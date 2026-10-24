// Qoder, as an app-level integration.
//
// Two of the 49 QoderAI repositories describe a machine-readable contract, and
// this module is a reading of them rather than a wrapper around their packages:
//
//   * `qoder-cloud-agents-sdk-ts` (and the Python/Go/Java siblings) define the
//     Cloud Agents HTTP APIs — base URLs, bearer auth, cursor pages, and the SSE
//     event stream. `forward-quickstart` shows the order they are used in:
//     identity → template → session → events.
//   * `qoder-acp-demos` shows how `qodercli --acp` is driven over stdio with
//     newline-delimited JSON-RPC: initialize, session/new, session/prompt, with
//     permission requests coming back to the host as JSON-RPC *requests*.
//
// Everything here is transport only. Keys never leave the server, the ACP child
// process is never started from a request's own command line, and a permission
// request from the agent is refused unless the caller explicitly allows tools.

import { spawn } from 'node:child_process';

export const QODER_PACKAGE = '@qoder-ai/qodercli';
export const QODER_PAT_ENVS = ['QODER_PAT', 'QODER_ACCESS_TOKEN'];

/** The two APIs, exactly as the SDKs resolve them (client.ts: cloud/forward). */
export const QCA_BASE = Object.freeze({
  forward: 'https://api.qoder.com/api/v1/forward',
  managed: 'https://api.qoder.com/api/v1/cloud'
});

/** ACP methods this host implements. Anything else gets `method not found`. */
export const ACP_PROTOCOL_VERSION = 1;

const trimSlashes = (s) => String(s || '').replace(/\/+$/, '');

/** Join a base URL and a path, encoding nothing twice. */
export function qcaUrl(mode, path, query) {
  const base = QCA_BASE[mode];
  if (!base) throw new Error(`unknown QCA mode: ${mode}`);
  const clean = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${base}/${clean}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) { for (const item of value) url.searchParams.append(key, String(item)); }
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Which credential to use, without ever logging it.
 *
 * A PAT is what the SDKs read from `QODER_PAT`; an access token is what the CLI
 * gets from `qodercli login`. Either works for the Forward API, so both are
 * accepted and the caller is told which one is in play.
 */
export function resolveQoderToken(getKey = () => null) {
  for (const name of QODER_PAT_ENVS) {
    const value = getKey(name);
    if (value && String(value).trim()) return { token: String(value).trim(), source: name };
  }
  return { token: null, source: null };
}

export function qoderStatus(getKey = () => null, { region } = {}) {
  const { token, source } = resolveQoderToken(getKey);
  return {
    configured: Boolean(token),
    source,
    region: region || 'global',
    forward: QCA_BASE.forward,
    managed: QCA_BASE.managed,
    key_envs: QODER_PAT_ENVS,
    note: token
      ? `Using ${source}. Keys stay on the server: the browser never sees this token.`
      : 'Add QODER_PAT (Qoder personal access token) in Settings → Keys to use Cloud Agents from here.'
  };
}

/**
 * One forwarded request, with the SDK's error surface flattened into `{ ok }`.
 *
 * Timeouts are per-request, retries are deliberately absent: a cloud agent
 * session is a side effect, and `Idempotency-Key` belongs to the caller.
 */
export async function qcaRequest(mode, path, {
  method = 'GET', token, body, query, timeoutMs = 30000, signal, fetch: fetchImpl = globalThis.fetch
} = {}) {
  if (!token) return { ok: false, status: 401, code: 'no_token', error: qoderStatus(() => null).note };
  const url = qcaUrl(mode, path, query);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, status: 0, code: timedOut ? 'timeout' : 'network', error: timedOut ? `Qoder did not answer within ${Math.round(timeoutMs / 1000)} s.` : `Could not reach ${new URL(url).host}: ${e?.message || e}` };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: data?.error?.code || data?.code || `http_${res.status}`,
      error: data?.error?.message || data?.message || `Qoder returned ${res.status}`,
      data
    };
  }
  return { ok: true, status: res.status, data, headers: res.headers };
}

/** A cursor page as `{ items, next }` — both SDKs page the same way. */
export function qcaPage(data) {
  const items = data?.data || data?.items || data?.results || [];
  const next = data?.next_cursor || data?.nextCursor || data?.next || null;
  return { items: Array.isArray(items) ? items : [], next };
}

/**
 * Split an SSE byte stream into events.
 *
 * Frames are `event:`/`data:`/`id:` lines ending in a blank line, and the frame
 * may be split across chunks at any byte — which is the bug every hand-rolled
 * client has, so the buffering lives here and is tested.
 */
export function createSseParser() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      const frames = [];
      let at;
      while ((at = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
        const frame = { event: 'message', data: '', id: null };
        for (const line of raw.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') frame.event = value;
          else if (field === 'data') frame.data += (frame.data ? '\n' : '') + value;
          else if (field === 'id') frame.id = value;
        }
        frames.push(frame);
      }
      return frames;
    },
    get pending() { return buffer; }
  };
}

/** Walk a QCA SSE response, yielding parsed `{type, ...}` events. */
export async function* qcaEvents(response, { signal } = {}) {
  if (!response?.body) return;
  const parser = createSseParser();
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    if (signal?.aborted) return;
    for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
      if (!frame.data) continue;
      let payload;
      try { payload = JSON.parse(frame.data); } catch { payload = { type: frame.event, raw: frame.data }; }
      yield { id: frame.id, event: frame.event, ...payload };
    }
  }
}

// ---------------------------------------------------------------------------
// qodercli over ACP
// ---------------------------------------------------------------------------

/**
 * A stdio ACP client for `qodercli --acp`.
 *
 * Newline-delimited JSON-RPC in both directions. Notifications and server→client
 * requests are routed by `method`; the host answers permission requests itself,
 * and refuses them unless the caller passed `allowTools`.
 */
export function createAcpClient({
  command = 'qodercli', args = ['--acp'], cwd = process.cwd(), env = process.env,
  clientName = 'ANTICODEX', clientVersion = '0.2.0', allowTools = false, onUpdate = () => {}, onStderr = () => {}
} = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const pending = new Map();
  const state = { initialized: null, sessionId: null, closed: false, nextId: 1, stderr: '' };
  let buffer = '';

  const write = (payload) => {
    if (state.closed) return;
    try { child.stdin.write(`${JSON.stringify(payload)}\n`); } catch { /* child gone */ }
  };
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  function handle(message) {
    // A response to something we asked.
    if (message.id !== undefined && !message.method) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(Object.assign(new Error(message.error.message || 'ACP error'), { code: message.error.code, data: message.error.data }));
      else slot.resolve(message.result);
      return;
    }
    // `session/update` — the agent's stream.
    if (message.method === 'session/update') { try { onUpdate(message.params); } catch { /* view error */ } return; }
    if (message.method === 'session/request_permission') {
      // Never silently approve: an agent asking to run a tool is exactly the
      // moment a person should decide. With `allowTools`, take the agent's own
      // "allow" option so unattended runs can proceed.
      const options = message.params?.options || [];
      const choice = allowTools
        ? options.find((o) => String(o.kind || '').startsWith('allow'))
        : null;
      reply(message.id, choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (message.method === 'fs/read_text_file' || message.method === 'fs/write_text_file') {
      fail(message.id, -32601, 'This host does not expose the file system over ACP.');
      return;
    }
    if (message.method === 'elicitation/create' || message.method === 'unstable_createElicitation') {
      reply(message.id, { action: 'decline' });
      return;
    }
    if (message.id !== undefined) fail(message.id, -32601, `unsupported method: ${message.method}`);
  }

  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      handle(message);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.stderr = (state.stderr + text).slice(-4000);
    try { onStderr(text); } catch { /* ignore */ }
  });
  child.on('exit', (code) => {
    state.closed = true;
    state.exitCode = code;
    for (const [, slot] of pending) slot.reject(new Error(`qodercli exited (code ${code}) before replying`));
    pending.clear();
  });
  child.on('error', (e) => {
    state.closed = true;
    state.spawnError = String(e.message || e);
    for (const [, slot] of pending) slot.reject(new Error(state.spawnError));
    pending.clear();
  });

  function call(method, params, timeoutMs = 120000) {
    if (state.closed) return Promise.reject(new Error(state.spawnError || 'qodercli is not running'));
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`qodercli did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`), { code: 'timeout' }));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    child,
    state,
    call,
    async initialize({ capabilities = {} } = {}) {
      const result = await call('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: clientName, version: clientVersion },
        clientCapabilities: capabilities
      }, 60000);
      state.initialized = result;
      return result;
    },
    async newSession({ cwd: sessionCwd = cwd, mcpServers = [], additionalDirectories = [] } = {}) {
      const result = await call('session/new', { cwd: sessionCwd, mcpServers, additionalDirectories }, 90000);
      state.sessionId = result?.sessionId || null;
      return result;
    },
    async prompt({ text, sessionId = state.sessionId, timeoutMs = 300000 }) {
      return call('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(text || '') }] }, timeoutMs);
    },
    async close() {
      if (state.closed) return;
      try { if (state.sessionId) await call('session/close', { sessionId: state.sessionId }, 5000); } catch { /* older agents */ }
      state.closed = true;
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
    }
  };
}

// ---------------------------------------------------------------------------
// The agent, as a model you can pick in Chat
// ---------------------------------------------------------------------------

export const QODER_AGENT_PROVIDER = 'agent';
export const QODER_AGENT_MODEL = 'qodercli';
export const QODER_AGENT_REF = `${QODER_AGENT_PROVIDER}::${QODER_AGENT_MODEL}`;

export const isAgentRef = (ref) => String(ref || '') === QODER_AGENT_REF;

// One detection per five minutes, shared by every caller: `listProviders` is
// synchronous and called on every model listing, and spawning `qodercli` there
// would be both slow and rude.
let cliCache = { at: 0, value: null };

export function qoderCliCached() {
  return cliCache.value && Date.now() - cliCache.at < 5 * 60 * 1000 ? cliCache.value : null;
}

export async function refreshQoderCli({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (cliCache.value && Date.now() - cliCache.at < maxAgeMs) return cliCache.value;
  const value = await qoderCliStatus().catch((e) => ({ found: false, error: String(e.message || e) }));
  cliCache = { at: Date.now(), value };
  return value;
}

/** The provider row Chat shows, or null when qodercli is not on this machine. */
export function agentProviderDef(cli = qoderCliCached()) {
  if (!cli?.found) return null;
  return {
    id: QODER_AGENT_PROVIDER,
    name: 'Qoder CLI (local agent)',
    kind: 'agent',
    configured: true,
    endpoint: null,
    key_env: null,
    category: 'Local agents',
    models_verified: true,
    models_note: `Runs \`qodercli --acp\` on this machine${cli.version ? ` (${cli.version})` : ''}; tool permissions are refused unless you allow them.`,
    models: [{ id: QODER_AGENT_MODEL, label: 'Qoder CLI — ACP', live: true, vision: false, reasoning: true, tools: true }]
  };
}

/**
 * Stream one answer from the local agent as chat events.
 *
 * The bridge speaks SSE to the browser; ACP speaks JSON-RPC to the CLI. This is
 * the adapter: ACP `session/update` frames become `delta` (text), `thinking`
 * (reasoning) and `tool` events, so the existing Chat view renders an agent
 * answer exactly like a model answer, including the reasoning panel.
 */
// The agent is spawned per turn, so it has no memory of its own: prior turns
// have to be carried in the prompt. One user message is sent verbatim (nothing
// to lose); a real conversation becomes a labelled transcript with the oldest
// turns dropped first when it gets long.
export function agentPrompt({ system = '', messages = [], maxTurns = 12, maxCharsPerTurn = 8000 } = {}) {
  const clip = (text) => {
    const body = String(text).trim();
    if (body.length <= maxCharsPerTurn) return body;
    return `… ${body.length - maxCharsPerTurn} earlier characters omitted …\n${body.slice(-maxCharsPerTurn)}`;
  };
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: clip(m.content) }));
  if (!turns.some((t) => t.role === 'user')) return '';
  const kept = turns.slice(-Math.max(2, maxTurns));
  const head = String(system).trim();
  if (kept.length === 1) return [head, kept[0].content].filter(Boolean).join('\n\n');
  const transcript = kept.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  return [head, `Conversation so far:\n\n${transcript}`, 'Reply to the last User message.'].filter(Boolean).join('\n\n');
}

export async function* streamAcpAnswer({
  text, cwd = process.cwd(), signal, allowTools = false, timeoutMs = 300000, command = 'qodercli', args = ['--acp'], onStderr = () => {}
} = {}) {
  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };

  const client = createAcpClient({
    command, args, cwd, allowTools, onStderr,
    onUpdate: (params) => { const u = params?.update || params; if (u) { queue.push(u); poke(); } }
  });

  const stop = () => { client.close().catch(() => {}); done = true; poke(); };
  if (signal) signal.addEventListener('abort', stop, { once: true });

  const worker = (async () => {
    try {
      const init = await client.initialize();
      yield0({ type: 'phase', phase: 'agent', detail: `${init?.agentInfo?.title || init?.agentInfo?.name || 'qodercli'} ${init?.agentInfo?.version || ''}`.trim() });
      const session = await client.newSession({ cwd });
      yield0({ type: 'phase', phase: 'agent-session', detail: session?.sessionId || null });
      const result = await client.prompt({ text, sessionId: session?.sessionId, timeoutMs });
      yield0({ type: 'done', stop_reason: result?.stopReason ?? null });
    } catch (e) {
      failure = e;
    } finally {
      done = true;
      poke();
      client.close().catch(() => {});
    }
  })();

  function yield0(value) { queue.push(value); poke(); }

  try {
    while (!done || queue.length) {
      if (signal?.aborted) return;
      if (!queue.length) { await new Promise((r) => { wake = r; }); continue; }
      const update = queue.shift();
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const t = update.content?.text || '';
        if (t) yield { type: 'delta', text: t };
      } else if (update?.sessionUpdate === 'agent_thought_chunk') {
        const t = update.content?.text || '';
        if (t) yield { type: 'thinking', text: t };
      } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        yield { type: 'tool', name: update.title || update.name || 'tool', status: update.status || 'requested' };
      } else if (update?.type === 'phase' || update?.type === 'done') {
        yield update;
      } else if (update && !update.sessionUpdate) {
        yield update;
      }
    }
    if (failure) throw failure;
  } finally {
    await worker.catch(() => {});
    client.close().catch(() => {});
  }
}

/** Map ACP's error into something a person can act on. */
export function explainAcpError(error = {}) {
  const message = String(error.error || error.message || error);
  if (error.code === -32000 && /auth/i.test(message)) {
    return 'qodercli is installed but not signed in. Run `qodercli login` (or set QODER_PERSONAL_ACCESS_TOKEN) and try again.';
  }
  if (error.code === 'timeout') return message;
  if (/ENOENT|not found/i.test(message)) return 'qodercli is not installed. `npm i -g @qoder-ai/qodercli` (or `brew install qoderAI/qoder/qodercli`).';
  return message;
}

/** Download-free check: is a `qodercli` on PATH, and which version? */
export function qoderCliStatus({ command = 'qodercli', timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child;
    const done = (value) => { try { child?.kill('SIGKILL'); } catch { /* gone */ } resolve(value); };
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (e) {
      return resolve({ found: false, command, error: String(e.message || e) });
    }
    let out = '';
    const timer = setTimeout(() => done({ found: false, command, timed_out: true, error: `\`${command} --version\` did not answer in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); done({ found: false, command, error: String(e.message || e) }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const version = (out.match(/\d+\.\d+\.\d+/) || [])[0] || null;
      done({ found: code === 0 || Boolean(version), command, version, exit_code: code, install: `npm i -g ${QODER_PACKAGE}` });
    });
  });
}

/**
 * The GitHub Actions workflow `qoder-action` expects.
 *
 * Inputs are the action's own (`action.yml`): prompt, qoder_personal_access_token,
 * qodercli_version, enable_qoder_github_mcp, flags.
 */
export function qoderActionWorkflow({ prompt = 'Review this pull request for bugs, security issues and missing tests.', version = '0.1.18', mcp = true, flags = '', trigger = 'pull_request', job = 'review' } = {}) {
  const on = trigger === 'issue_comment'
    ? '  issue_comment:\n    types: [created]'
    : trigger === 'workflow_dispatch'
      ? '  workflow_dispatch:'
      : '  pull_request:\n    types: [opened, synchronize, reopened]';
  const permission = ['  contents: read', '  pull-requests: write', ...(trigger === 'issue_comment' ? ['  issues: write'] : [])].join('\n');
  return `# Generated by ANTICODEX from qoderAI/qoder-action.
name: Qoder
on:
${on}

permissions:
${permission}

jobs:
  ${job}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: qoderAI/qoder-action@v1
        with:
          prompt: ${JSON.stringify(String(prompt))}
          qoder_personal_access_token: \${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
          qodercli_version: '${version}'
          enable_qoder_github_mcp: '${mcp ? 'true' : 'false'}'${flags ? `\n          flags: ${JSON.stringify(String(flags))}` : ''}
`;
}
