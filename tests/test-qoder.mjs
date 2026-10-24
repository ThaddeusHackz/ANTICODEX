// Qoder integration tests.
//
// What is pinned here is the contract, not the network: the two QoderAI
// repositories that define one (`qoder-cloud-agents-sdk-ts` for the HTTP APIs,
// `qoder-acp-demos` for `qodercli --acp`) are read by this app without their
// packages, so the reading itself has to be tested.
//
//   * the atlas is a survey — counts, uniqueness, and no invented integration;
//   * the SSE parser survives frames split across chunks (the classic bug);
//   * the QCA error surface is honest (no token, HTTP error, timeout);
//   * the ACP client really drives a real NDJSON JSON-RPC peer, including a
//     permission request that must be refused by default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACP_PROTOCOL_VERSION, QCA_BASE, QODER_AGENT_REF, agentPrompt, agentProviderDef, createAcpClient,
  createSseParser, explainAcpError, isAgentRef, qcaStream, qcaPage, qcaRequest, qcaUrl,
  qoderActionWorkflow, qoderStatus, resolveQoderToken, streamAcpAnswer
} from '../lib/qoder.js';
import { QODER_REPOS, atlasTally } from '../lib/qoder-repos.js';

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

// ---------------------------------------------------------------------------
section('the atlas is a survey of 49 repositories, not a wish list');
{
  ok('all 49 are present', QODER_REPOS.length === 49, String(QODER_REPOS.length));
  ok('names are unique', new Set(QODER_REPOS.map((r) => r.name)).size === 49);
  ok('every entry links to qoderAI', QODER_REPOS.every((r) => r.url === `https://github.com/qoderAI/${r.name}`));
  ok('every entry says what it is', QODER_REPOS.every((r) => r.summary && r.summary.length > 8));
  ok('every entry says what came out of it', QODER_REPOS.every((r) => r.use && r.use.length > 8));

  const tally = atlasTally();
  ok('the tally counts what the page filters on', tally.total === 49 && Object.values(tally.byKind).reduce((a, b) => a + b, 0) === 49);
  ok('seven repositories are actually integrated', tally.integrated === 7, String(tally.integrated));
  ok('the empty ones are labelled empty', tally.empty === 6
    && QODER_REPOS.filter((r) => r.kind === 'empty').every((r) => /empty|nothing|placeholder/i.test(r.summary)));

  const integrated = QODER_REPOS.filter((r) => r.integrated).map((r) => r.name).sort();
  ok('the integrated set is the ones with a contract', integrated.join(',') === [
    'forward-quickstart', 'qoder-acp-demos', 'qoder-action',
    'qoder-cloud-agents-sdk-go', 'qoder-cloud-agents-sdk-java',
    'qoder-cloud-agents-sdk-python', 'qoder-cloud-agents-sdk-ts'
  ].join(','));
  ok('release-note repositories are not called integrations', QODER_REPOS.filter((r) => r.kind === 'changelog').every((r) => r.integrated === false));
  ok('stars and size came from the API', QODER_REPOS.find((r) => r.name === 'better-harness').stars === 2407);
  ok('…and size is in KB', QODER_REPOS.find((r) => r.name === 'qoder-action').size_kb === 24);
}

// ---------------------------------------------------------------------------
section('the Cloud Agents client reads the SDK contract');
{
  ok('forward and managed have their own bases', qcaUrl('forward', 'sessions') === `${QCA_BASE.forward}/sessions`);
  ok('…and the managed half is separate', qcaUrl('managed', 'agents').startsWith('https://api.qoder.com/api/v1/cloud/'));
  ok('query values are encoded', qcaUrl('forward', 'sessions', { limit: 20, order: 'asc' }).endsWith('?limit=20&order=asc'));
  ok('empty query values are dropped', qcaUrl('forward', 'sessions', { cursor: '', limit: 5 }) === `${QCA_BASE.forward}/sessions?limit=5`);
  ok('arrays repeat the key', qcaUrl('forward', 'sessions', { tag: ['a', 'b'] }).endsWith('?tag=a&tag=b'));
  ok('an unknown mode is refused', (() => { try { qcaUrl('nope', 'x'); return false; } catch { return true; } })());

  const pat = resolveQoderToken((k) => (k === 'QODER_PAT' ? ' pat_value ' : null));
  ok('QODER_PAT wins', pat.token === 'pat_value' && pat.source === 'QODER_PAT');
  ok('…an access token is the fallback', resolveQoderToken((k) => (k === 'QODER_ACCESS_TOKEN' ? 'tok' : null)).source === 'QODER_ACCESS_TOKEN');
  ok('…and no token is reported as such', resolveQoderToken(() => null).token === null);

  const st = qoderStatus((k) => (k === 'QODER_PAT' ? 'super-secret-token' : null));
  ok('status never echoes the token', !JSON.stringify(st).includes('super-secret-token'));
  ok('…but says where it came from', st.configured === true && st.source === 'QODER_PAT');
  ok('…and tells you how to add one', qoderStatus(() => null).note.includes('QODER_PAT'));

  ok('a cursor page is read either way', qcaPage({ data: [1, 2], next_cursor: 'c2' }).next === 'c2'
    && qcaPage({ items: [1] }).items.length === 1);
}

// ---------------------------------------------------------------------------
section('requests: honest errors, no secret in the message');
{
  const noToken = await qcaRequest('forward', 'sessions', { token: null });
  ok('no token is a 401 with instructions', noToken.ok === false && noToken.status === 401 && noToken.code === 'no_token' && /QODER_PAT/.test(noToken.error));

  const okFetch = async (url, init) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: [{ id: 's1' }], next_cursor: null }),
    headers: new Headers(),
    _url: url, _init: init
  });
  const okRes = await qcaRequest('forward', 'sessions', { token: 't', fetch: okFetch });
  ok('a good response is unwrapped', okRes.ok === true && okRes.data.data.length === 1);

  const seen = {};
  await qcaRequest('forward', 'sessions', { token: 't', method: 'POST', body: { identity_id: 'i' }, fetch: async (u, init) => { seen.auth = init.headers.Authorization; seen.body = init.body; seen.method = init.method; return okFetch(); } });
  ok('auth is a bearer token', seen.auth === 'Bearer t');
  ok('POST bodies are JSON', seen.method === 'POST' && JSON.parse(seen.body).identity_id === 'i');

  const errRes = await qcaRequest('forward', 'sessions', { token: 't', fetch: async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ error: { code: 'invalid_identity', message: 'identity does not exist' } }), headers: new Headers() }) });
  ok('an API error keeps its code and message', errRes.ok === false && errRes.code === 'invalid_identity' && errRes.error === 'identity does not exist');

  const netRes = await qcaRequest('forward', 'sessions', { token: 't', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  ok('a network failure names the host and the reason', netRes.code === 'network' && /api\.qoder\.com/.test(netRes.error) && /ECONNREFUSED/.test(netRes.error));

  const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
  const toRes = await qcaRequest('forward', 'sessions', { token: 't', timeoutMs: 2500, fetch: async () => { throw timeout; } });
  ok('a timeout is reported as seconds, not as a stack', toRes.code === 'timeout' && /3 s/.test(toRes.error));
}

// ---------------------------------------------------------------------------
section('SSE frames survive being split anywhere');
{
  const p = createSseParser();
  ok('one frame', p.push('event: session\ndata: {"a":1}\n\n').length === 1);
  const split = createSseParser();
  ok('a frame split mid-JSON yields nothing early', split.push('data: {"a":').length === 0);
  const later = split.push('1}\n\n');
  ok('…and completes when the blank line arrives', later.length === 1 && later[0].data === '{"a":1}');
  const crlf = createSseParser();
  ok('CRLF frames work', crlf.push('data: x\r\n\r\n')[0].data === 'x');
  const multi = createSseParser();
  ok('multi-line data is joined with newlines', multi.push('data: one\ndata: two\n\n')[0].data === 'one\ntwo');
  const comment = createSseParser();
  ok('heartbeat comments are not events', comment.push(': keep-alive\n\n')[0].data === '');
  const idEvent = createSseParser();
  const f = idEvent.push('id: 42\nevent: delta\ndata: {}\n\n')[0];
  ok('id and event are kept', f.id === '42' && f.event === 'delta');
  const two = createSseParser();
  ok('two frames in one chunk', two.push('data: a\n\ndata: b\n\n').length === 2);
}

// ---------------------------------------------------------------------------
section('the GitHub Action workflow is the one qoder-action documents');
{
  const pr = qoderActionWorkflow({ prompt: 'Review "this" PR', version: '0.1.18' });
  ok('it uses the action', /uses: qoderAI\/qoder-action@v1/.test(pr));
  ok('…with the PAT from secrets, never inline', /qoder_personal_access_token: \$\{\{ secrets\.QODER_PERSONAL_ACCESS_TOKEN \}\}/.test(pr) && !/qpat_/.test(pr));
  ok('…the version it was tested with', /qodercli_version: '0\.1\.18'/.test(pr));
  ok('…and the MCP toggle', /enable_qoder_github_mcp: 'true'/.test(pr));
  ok('a quoted prompt stays a quoted scalar', /prompt: "Review \\"this\\" PR"/.test(pr));
  ok('pull_request is the default trigger', /  pull_request:/.test(pr));
  ok('issue_comment gets the issues permission it needs', /issues: write/.test(qoderActionWorkflow({ trigger: 'issue_comment' })));
  ok('mcp can be turned off', /enable_qoder_github_mcp: 'false'/.test(qoderActionWorkflow({ mcp: false })));
  ok('flags are passed through when given', /flags: "--verbose"/.test(qoderActionWorkflow({ flags: '--verbose' })));
}

// ---------------------------------------------------------------------------
section('ACP errors are explained, not dumped');
{
  const auth = explainAcpError({ code: -32000, message: 'Authentication required: Authentication is required.' });
  ok('auth-required points at qodercli login', /qodercli login/.test(auth));
  ok('a missing binary points at npm', /npm i -g @qoder-ai\/qodercli/.test(explainAcpError({ message: 'spawn qodercli ENOENT' })));
  ok('a timeout says what timed out', /did not answer/.test(explainAcpError({ code: 'timeout', message: 'qodercli did not answer session/prompt within 5 s' })));
}

// ---------------------------------------------------------------------------
section('ACP: a real JSON-RPC peer, driven to completion');
{
  // A fake agent that behaves like qodercli: initialize, session/new, a
  // permission request in the middle of the prompt, then the final result.
  const fixture = path.join(os.tmpdir(), `acx-fake-acp-${process.pid}.mjs`);
  fs.writeFileSync(fixture, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    let sawPermission = null;
    let promptId = null;
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '9.9.9', title: 'Fake' }, authMethods: [], agentCapabilities: { loadSession: true } } });
      } else if (msg.method === 'session/new') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
      } else if (msg.method === 'session/prompt') {
        promptId = msg.id;
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
        send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { title: 'write file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] } });
      } else if (msg.id === 'perm-1') {
        sawPermission = msg.result?.outcome?.outcome ?? 'none';
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', title: 'write file' } } });
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', _perm: sawPermission } });
      } else if (msg.method === 'session/close') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });
  `);

  const run = async (allowTools) => {
    const updates = [];
    const client = createAcpClient({ command: process.execPath, args: [fixture], allowTools, onUpdate: (p) => updates.push(p.update) });
    const init = await client.initialize();
    const session = await client.newSession({ cwd: os.tmpdir() });
    const result = await client.prompt({ text: 'hi', sessionId: session.sessionId });
    await client.close();
    return { init, session, result, updates, state: client.state };
  };

  const denied = await run(false);
  ok('initialize reports the agent', denied.init.agentInfo.name === 'fake' && denied.init.protocolVersion === 1);
  ok('session/new returns an id', denied.session.sessionId === 'sess-1');
  ok('prompt resolves with the stop reason', denied.result.stopReason === 'end_turn');
  ok('both chunks arrived, in order', denied.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('') === 'Hello world');
  ok('the tool call is reported, not executed here', denied.updates.some((u) => u.sessionUpdate === 'tool_call'));
  // The fake agent echoes back what it was told when it asked for permission.
  ok('by default a permission request is refused', denied.result._perm === 'cancelled', String(denied.result._perm));

  const allowed = await run(true);
  ok('with allowTools the agent’s allow option is taken', allowed.result._perm === 'selected', String(allowed.result._perm));
  ok('the same prompt still completes either way', allowed.result.stopReason === 'end_turn');
  ok('ACP protocol version is 1', ACP_PROTOCOL_VERSION === 1);
  fs.rmSync(fixture, { force: true });
}

// ---------------------------------------------------------------------------
section('a cloud stream cannot be pointed at another host');
{
  let refused = null;
  try { await qcaStream('forward', '/../../evil.example.com/x', {}); } catch (e) { refused = e; }
  ok('a path that escapes the base is refused before a socket opens', refused?.status === 400, String(refused?.message));
  ok('…and no other mode is invented', (await qcaStream('nope', 'x', {}).catch((e) => e)).message.includes('unknown QCA mode'));
}

// ---------------------------------------------------------------------------
section('the agent is a model you can pick, and it streams as chat events');
{
  ok('the ref is provider::model', QODER_AGENT_REF === 'agent::qodercli');
  ok('…and only that ref is the agent', isAgentRef('agent::qodercli') && !isAgentRef('nvidia::qwen') && !isAgentRef(''));
  ok('no installed CLI means no provider row', agentProviderDef({ found: false }) === null);
  const row = agentProviderDef({ found: true, version: '1.2.3' });
  ok('an installed CLI is always configured', row.configured === true && row.id === 'agent');
  ok('…it needs no key', row.key_env === null);
  ok('…and says what it runs', /qodercli --acp/.test(row.models_note) && row.models_note.includes('1.2.3'));
  ok('…with one reasoning model, already verified', row.models_verified === true && row.models[0].reasoning === true && row.models[0].live === true);

  // A peer that thinks, then answers, then asks for a tool.
  const fixture = path.join(os.tmpdir(), `acx-agent-chat-${process.pid}.mjs`);
  fs.writeFileSync(fixture, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    let permission = null;
    let promptId = null;
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake', title: 'Fake CLI', version: '1.2.3' }, authMethods: [], agentCapabilities: {} } });
      else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-chat' } });
      else if (msg.method === 'session/prompt') {
        promptId = msg.id;
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me think' } } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'read file', status: 'pending' } } });
        send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
      } else if (msg.id === 'p1') {
        permission = msg.result?.outcome?.outcome;
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } });
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', _perm: permission } });
      } else if (msg.method === 'session/close') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
  `);

  // The agent is a fresh process each turn, so history has to ride along.
  ok('an empty conversation asks nothing', agentPrompt({ messages: [] }) === '');
  ok('…as does one with no user turn', agentPrompt({ messages: [{ role: 'assistant', content: 'hi' }] }) === '');
  ok('a single question is sent verbatim, after the system prompt', agentPrompt({ system: 'be brief', messages: [{ role: 'user', content: 'why?' }] }) === 'be brief\n\nwhy?');
  const chat = agentPrompt({ messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' }
  ] });
  ok('a follow-up carries the earlier turns', chat.includes('User: first') && chat.includes('Assistant: answer') && chat.endsWith('Reply to the last User message.'));
  ok('…old turns fall off the front, not the back', !agentPrompt({
    messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` })), maxTurns: 4
  }).includes('t14'), 't16');
  ok('a huge turn is clipped and says so', /earlier characters omitted/.test(agentPrompt({
    system: 's', messages: [{ role: 'user', content: 'x'.repeat(9000) }], maxCharsPerTurn: 100
  })));

  const collected = [];
  for await (const evt of streamAcpAnswer({ text: 'hi', command: process.execPath, args: [fixture], cwd: os.tmpdir() })) {
    collected.push(evt);
  }
  fs.rmSync(fixture, { force: true });

  const types = collected.map((e) => e.type);
  ok('a thought chunk becomes a thinking event', collected.some((e) => e.type === 'thinking' && e.text === 'let me think'));
  ok('tool calls become tool events, not actions', collected.some((e) => e.type === 'tool' && e.name === 'read file'));
  ok('the answer arrives as deltas', collected.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Hello world');
  ok('the run ends with a done event', types.lastIndexOf('done') === types.length - 1 && collected.find((e) => e.type === 'done').stop_reason === 'end_turn');
  ok('the agent is announced before the answer', types.indexOf('phase') === 0 && types.indexOf('phase') < types.indexOf('delta'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
