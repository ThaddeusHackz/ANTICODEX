// ANTICODEX — stdio MCP transport.
//
// The HTTP client in `mcp.js` covers remote servers (Streamable HTTP + legacy
// SSE). A local server such as REA (`npx -y rea-agents mcp`) is a *child
// process* that speaks JSON-RPC over stdin/stdout, which is a different
// transport, not a different protocol: same `initialize` → `tools/list` →
// `tools/call` handshake, same 2025-06-18 shapes.
//
// Framing: MCP stdio is newline-delimited JSON. Some older servers still emit
// LSP-style `Content-Length: n\r\n\r\n{...}`; the reader accepts both and never
// assumes which one a given server picked.
//
// SECURITY: commands are never taken from a request. `stdio:` URLs resolve
// through MCP_CATALOG in `mcp.js`, so a browser can only ask for a server the
// product already ships a launch spec for. A child process is never spawned
// from user input.

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 30_000;
const TOOL_TIMEOUT = 180_000; // decompiling / ASAR analysis is not fast
const STDERR_CAP = 8 * 1024;

class StdioError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export class StdioMcpClient {
  /**
   * @param {string} command  e.g. "npx" — comes from a registry entry, not a request
   * @param {string[]} args   e.g. ["-y","rea-agents@6.7.0","mcp"]
   * @param {{env?:object, cwd?:string, label?:string}} opts
   */
  constructor(command, args = [], { env, cwd, label = command } = {}) {
    this.command = command;
    this.args = args;
    this.label = label;
    this.env = env;
    this.cwd = cwd;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    this.transport = 'stdio';
    this.exited = false;
    this.exitInfo = null;
  }

  start() {
    if (this.child) return this;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.env || {}), NO_COLOR: '1', CI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group so `npx` + the node it launches die together; without
      // this a SIGTERM to npx leaves the real server holding the pipe open.
      detached: process.platform !== 'win32'
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this.#onStdout(c));
    this.child.stderr.on('data', (c) => {
      this.stderr = (this.stderr + c).slice(-STDERR_CAP);
    });
    this.child.on('error', (e) => this.#failAll(new StdioError(`${this.label} could not start: ${e.message}`)));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      const why = this.stderr.trim().split('\n').slice(-4).join(' | ');
      this.#failAll(new StdioError(
        `${this.label} exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})${why ? `: ${why}` : ''}`,
        code
      ));
    });
    return this;
  }

  // --- framing -------------------------------------------------------------

  #onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const head = this.buffer;
      if (!head) return;
      // Content-Length frame
      if (/^content-length:/i.test(head)) {
        const sep = head.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const len = Number((head.slice(0, head.indexOf('\r\n')).split(':')[1] || '').trim());
        const body = head.slice(sep + 4);
        if (!Number.isFinite(len) || body.length < len) return;
        this.buffer = body.slice(len);
        this.#dispatch(body.slice(0, len));
        continue;
      }
      // newline-delimited JSON
      const nl = head.indexOf('\n');
      if (nl === -1) return;
      const line = head.slice(0, nl).trim();
      this.buffer = head.slice(nl + 1);
      if (line) this.#dispatch(line);
    }
  }

  #dispatch(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; } // logs on stdout are not our problem
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new StdioError(msg.error.message || 'MCP error', msg.error.code));
      else resolve(msg.result);
      return;
    }
    // Server-initiated notifications/requests we do not need: logging,
    // progress, resources/updated. Swallow rather than crash the stream.
  }

  #failAll(err) {
    for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }

  #send(obj) {
    if (!this.child || this.exited) throw new StdioError(`${this.label} is not running`);
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  #request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StdioError(`${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // --- protocol ------------------------------------------------------------

  async initialize() {
    this.start();
    const result = await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'ANTICODEX', version: '1.0.0' }
    });
    // Notification (no id, no reply).
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this.protocolVersion = result?.protocolVersion;
    return result;
  }

  async listTools() {
    const out = [];
    let cursor;
    do {
      const r = await this.#request('tools/list', cursor ? { cursor } : {});
      out.push(...(r?.tools || []));
      cursor = r?.nextCursor || r?.next_cursor;
    } while (cursor);
    return out;
  }

  async callTool(name, args = {}) {
    return this.#request('tools/call', { name, arguments: args }, TOOL_TIMEOUT);
  }

  async listResources() {
    try { const r = await this.#request('resources/list', {}); return r?.resources || []; } catch { return []; }
  }

  async listPrompts() {
    try { const r = await this.#request('prompts/list', {}); return r?.prompts || []; } catch { return []; }
  }

  lastStderr() { return this.stderr.trim(); }

  async close() {
    const child = this.child;
    if (!child || this.exited) { this.child = null; return; }
    this.#failAll(new StdioError(`${this.label} closed`));
    const signal = (sig) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    try { child.stdin.end(); } catch { /* already gone */ }
    signal('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { signal('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      if (this.exited) { clearTimeout(t); resolve(); }
    });
    this.child = null;
  }
}

/** Run one request/response round trip and always clean up the child. */
export async function withStdio(command, args, fn, opts = {}) {
  const client = new StdioMcpClient(command, args, opts);
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close();
  }
}
