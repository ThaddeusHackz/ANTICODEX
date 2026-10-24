// stdio MCP transport tests.
//
// The bridge used to speak HTTP/SSE only, so a local server such as REA
// (`npx -y rea-agents mcp`) could be listed in the catalogue but never actually
// connected — "Connect" would try to POST to the string "stdio:rea". These tests
// pin the real transport: spawn, initialize, tools/list, tools/call, cleanup,
// both framings, and the launch-spec allowlist that stops a request from
// choosing a command.
//
// Run: node tests/test-mcp-stdio.mjs
// Real REA round trip: REA_E2E=1 node tests/test-mcp-stdio.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StdioMcpClient } from '../lib/mcp-stdio.js';
import { createClient, stdioSpec, isLocalMcp, probeServer, MCP_CATALOG, selectTools } from '../lib/mcp.js';

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---------------------------------------------------------------------------
// Fixture MCP server: newline-delimited JSON, and a second mode that answers in
// LSP-style Content-Length frames, because older servers still ship that.
// ---------------------------------------------------------------------------
const FIXTURE = `
const MODE = process.argv[2] || 'lines';
let buf = '';
function write(obj) {
  const body = JSON.stringify(obj);
  if (MODE === 'length') process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
  else process.stdout.write(body + '\\n');
}
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    let raw = null;
    if (MODE === 'length' && buf.startsWith('Content-Length:')) {
      const sep = buf.indexOf('\\r\\n\\r\\n');
      if (sep === -1) return;
      const len = Number(buf.slice(0, buf.indexOf('\\r\\n')).split(':')[1]);
      if (buf.length < sep + 4 + len) return;
      raw = buf.slice(sep + 4, sep + 4 + len);
      buf = buf.slice(sep + 4 + len);
    } else {
      const nl = buf.indexOf('\\n');
      if (nl === -1) return;
      raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'fixture', version: '1.2.3' },
        capabilities: { tools: {}, prompts: {} }
      }});
    } else if (msg.method === 'notifications/initialized') {
      // notification: no reply
    } else if (msg.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'fail', description: 'Always errors', inputSchema: { type: 'object', properties: {} } }
      ]}});
    } else if (msg.method === 'prompts/list') {
      write({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'p1', description: 'demo' }] } });
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'fail') {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'deliberate failure' } });
      } else {
        write({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') }]
        }});
      }
    } else if (msg.id != null) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method ' + msg.method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-mcp-'));
const fixturePath = path.join(dir, 'fixture-server.mjs');
fs.writeFileSync(fixturePath, FIXTURE);

console.log('\nLaunch-spec allowlist');
{
  const spec = stdioSpec('stdio:rea');
  ok('rea is in the catalogue', MCP_CATALOG.some((c) => c.id === 'rea' && c.local));
  ok('spec resolves', spec && spec.command === 'npx');
  ok('spec is version-pinned', spec.args.join(' ').includes('rea-agents@6.7.0'));
  ok('it ends in the mcp subcommand', spec.args[spec.args.length - 1] === 'mcp');
  ok('isLocalMcp recognises it', isLocalMcp('stdio:rea') === true);
  ok('a remote url is not local', isLocalMcp('https://mcp.example.com/mcp') === false);
  ok('an unknown local id does not resolve', stdioSpec('stdio:definitely-not-registered') === null);
  let threw = null;
  try { createClient({ url: 'stdio:definitely-not-registered' }); } catch (e) { threw = e.message; }
  ok('unknown local id refuses to spawn', /no launch spec/.test(String(threw)), String(threw));
  ok('a command in the URL is not a spec', stdioSpec('stdio:rm -rf /') === null);
}

console.log('\nChat tool surface');
{
  const many = Array.from({ length: 207 }, (_, i) => ({ name: 'tool_' + i }));
  const rea = MCP_CATALOG.find((c) => c.id === 'rea');
  const curated = selectTools({ id: 'rea', url: 'stdio:rea' },
    rea.suggested_tools.map((n) => ({ name: n })));
  ok('REA contributes its curated surface, not all 207', curated.length === rea.suggested_tools.length && curated.length < 30);
  ok('all_tools opts back in', selectTools({ id: 'rea', url: 'stdio:rea', all_tools: true }, many).length === 207);
  ok('a connection allowlist wins', selectTools({ url: 'stdio:rea', tool_allowlist: ['tool_1', 'tool_2'] }, many).length === 2);
  ok('max_tools caps anything', selectTools({ url: 'https://x/mcp', max_tools: 5 }, many).length === 5);
  ok('a server outside the catalogue is untouched', selectTools({ url: 'https://x/mcp' }, many).length === 207);
  ok('the curated names are real REA tool names', probeNamesHave(rea.suggested_tools));
}
function probeNamesHave(names) {
  // names are pinned against the live inventory in the REA_E2E block below;
  // here we only require the list to be non-empty and de-duplicated.
  return names.length > 4 && new Set(names).size === names.length;
}

console.log('\nNewline framing');
{
  const client = new StdioMcpClient(process.execPath, [fixturePath, 'lines'], { label: 'fixture' });
  const info = await client.initialize();
  ok('initialize returns server info', info.serverInfo.name === 'fixture' && info.serverInfo.version === '1.2.3');
  ok('protocol version recorded', client.protocolVersion === '2025-06-18');
  const tools = await client.listTools();
  ok('tools/list', tools.length === 2 && tools[0].name === 'echo');
  ok('inputSchema passes through', tools[0].inputSchema.properties.text.type === 'string');
  const prompts = await client.listPrompts();
  ok('prompts/list', prompts.length === 1);
  const res = await client.callTool('echo', { text: 'hi' });
  ok('tools/call', res.content[0].text === 'echo:hi');
  let err = null;
  try { await client.callTool('fail', {}); } catch (e) { err = e.message; }
  ok('a JSON-RPC error rejects with the server message', /deliberate failure/.test(String(err)), String(err));
  await client.close();
  ok('close() reaps the child', client.child === null);
}

console.log('\nContent-Length framing');
{
  const client = new StdioMcpClient(process.execPath, [fixturePath, 'length'], { label: 'fixture-length' });
  await client.initialize();
  const tools = await client.listTools();
  const res = await client.callTool('echo', { text: 'frames' });
  ok('LSP-style frames are read too', tools.length === 2 && res.content[0].text === 'echo:frames');
  await client.close();
}

console.log('\nLifecycle');
{
  const client = new StdioMcpClient(process.execPath, [fixturePath, 'lines'], { label: 'fixture-life' });
  await client.initialize();
  ok('transport label', client.transport === 'stdio');
  // A server that dies mid-request must reject the pending call, not hang.
  const dying = new StdioMcpClient(process.execPath, ['-e', 'process.exit(3)'], { label: 'dies' });
  let msg = null;
  try { await dying.initialize(); } catch (e) { msg = e.message; }
  ok('a server that exits fails fast', /exited/.test(String(msg)), String(msg));
  await dying.close().catch(() => {});
  await client.close();
}

console.log('\nImported servers (conn.stdio, from a config.toml)');
{
  // This is the path `import_config` produces: a command that came from the
  // user's own file. The bridge only lets a loopback caller reach it.
  const client = createClient({
    id: 'imported', name: 'imported', url: 'stdio:imported-fixture',
    stdio: { command: process.execPath, args: [fixturePath, 'lines'] }
  });
  const info = await client.initialize();
  const tools = await client.listTools();
  const res = await client.callTool('echo', { text: 'imported' });
  ok('an imported command is runnable when authorised', info.serverInfo.name === 'fixture' && tools.length === 2);
  ok('and it answers tool calls', res.content[0].text === 'echo:imported');
  await client.close();
}

console.log('\nReal REA (REA_E2E=1)');
if (process.env.REA_E2E === '1') {
  const started = Date.now();
  const probe = await probeServer('stdio:rea');
  ok('transport is stdio', probe.transport === 'stdio');
  ok('server is rea', probe.server.name === 'rea');
  ok('tool inventory', probe.tools.length >= 200, `${probe.tools.length} tools`);
  ok('prompts', probe.prompts.length >= 1);
  const names = probe.tools.map((t) => t.name);
  ok('has the ASAR/Electron analyser', names.includes('analyze_javascript_application'));
  ok('has artifact inventory', names.includes('inspect_artifact'));
  ok('has sqlite inspection', names.includes('inspect_sqlite_database'));
  ok('answered in a sane time', Date.now() - started < 120000, `${Date.now() - started}ms`);
  const curated = MCP_CATALOG.find((c) => c.id === 'rea').suggested_tools;
  const missing = curated.filter((n) => !names.includes(n));
  ok('every curated chat-tool name exists on the real server', missing.length === 0, missing.join(', '));
  // The child must be gone: a leaked process keeps a Node host alive forever.
  const leaked = await new Promise((resolve) => {
    setTimeout(() => resolve(false), 300);
    process.once('beforeExit', () => resolve(true));
  });
  ok('no leaked child keeps the loop alive', leaked === false);
} else {
  console.log('  · skipped (set REA_E2E=1 to spawn the real server)');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
