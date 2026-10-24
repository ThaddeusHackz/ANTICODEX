// Speed, deliberation, and the tool cache.
//
// The complaint this suite exists for: "the models are very slow". The biggest
// cause was not the provider — it was this app spawning every connected MCP
// server to re-read its tool list before *every* message (4.35 s against 0.05 s
// on a machine with one server, measured). The rest of the file pins the two
// things that make speed a setting instead of a hope: the Fast/Balanced/Max
// presets, and the model's own reasoning being streamed as it happens.
//
// Run: node tests/test-fast.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ANTICODEX_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-fast-data-'));

const { chatStream, chat, effortParams, effortProfile, EFFORTS, DEFAULT_EFFORT, PROVIDER_DEFS_KEY } = await import('../lib/providers.js');
const cache = await import('../lib/tool-cache.js');

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

// --- an upstream that can reason, think, or reject a parameter ---------------
const seen = [];
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const parsed = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
  seen.push({ url: req.url, model: parsed.model, stream: parsed.stream, effort: parsed.reasoning_effort, max_tokens: parsed.max_tokens, temperature: parsed.temperature, thinking: parsed.thinking });

  // An endpoint that does not know `reasoning_effort` — the retry has to save it.
  if (parsed.model === 'strict-model' && parsed.reasoning_effort) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } }));
  }
  if (parsed.model === 'strict-model') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: 'assistant', content: 'answered anyway' } }] }));
  }
  // A reasoning model: deliberation first, then the answer.
  if (parsed.model === 'think-model') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    frame({ choices: [{ delta: { reasoning_content: 'First, ' } }] });
    frame({ choices: [{ delta: { reasoning_content: 'consider the ask.' } }] });
    frame({ choices: [{ delta: { content: 'Hello' } }] });
    frame({ choices: [{ delta: { content: ', world' } }] });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  if (parsed.model === 'think-model-json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      model: parsed.model,
      choices: [{ message: { role: 'assistant', content: 'the answer', reasoning_content: 'the reasoning' } }]
    }));
  }
  if (req.url === '/v1/messages') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Claude thinks ' } });
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'before answering.' } });
    frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answered.' } });
    frame({ type: 'message_stop' });
    return res.end();
  }
  if (parsed.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  return res.end();
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const PORT = upstream.address().port;
const defs = [
  { id: 'mini', name: 'Mock NIM', type: 'openai', endpoint: `http://127.0.0.1:${PORT}/v1`, key_env: 'MINI_API_KEY', default_model: 'think-model', effort: true },
  { id: 'plain', name: 'Plain gateway', type: 'openai', endpoint: `http://127.0.0.1:${PORT}/v1`, key_env: 'PLAIN_KEY', default_model: 'chat-model' },
  { id: 'claudey', name: 'Mock Claude', type: 'anthropic', endpoint: `http://127.0.0.1:${PORT}`, key_env: 'CLAUDE_KEY', default_model: 'claude-mock' }
];
const keys = { MINI_API_KEY: 'k', CLAUDE_KEY: 'k', PLAIN_KEY: 'k', [PROVIDER_DEFS_KEY]: defs };

// ---------------------------------------------------------------------------
section('the effort presets are the speed dial');
{
  ok('there are three of them', Object.keys(EFFORTS).length === 3, Object.keys(EFFORTS).join(','));
  ok('Fast is the small one', EFFORTS.fast.max_tokens < EFFORTS.balanced.max_tokens && EFFORTS.balanced.max_tokens < EFFORTS.max.max_tokens);
  ok('Fast asks for no deliberation at all', EFFORTS.fast.reasoning === false && EFFORTS.fast.reasoning_effort === null);
  ok('Max asks for the most', EFFORTS.max.reasoning_effort === 'high');
  ok('an unknown value falls back to the default, not to nothing', effortProfile('turbo').id === DEFAULT_EFFORT && effortProfile(undefined).id === DEFAULT_EFFORT);
  const fast = effortParams('fast');
  ok('the profile sets tokens and temperature', fast.max_tokens === 512 && fast.temperature === 0.3);
  const explicit = effortParams('max', { max_tokens: 42, temperature: 0 });
  ok('an explicit value still wins over the preset', explicit.max_tokens === 42 && explicit.temperature === 0);
}

section('the preset reaches the provider');
{
  seen.length = 0;
  await chatStream({ model: 'think-model', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'fast' });
  const call = seen.at(-1);
  ok('Fast sends 512 tokens and temperature 0.3', call.max_tokens === 512 && call.temperature === 0.3, JSON.stringify(call));
  ok('…and no reasoning_effort', call.effort === undefined, String(call.effort));

  seen.length = 0;
  await chatStream({ model: 'think-model', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'max' });
  const call2 = seen.at(-1);
  ok('Max sends 4096 tokens', call2.max_tokens === 4096, String(call2.max_tokens));
  ok('…and asks for high reasoning effort where the gateway takes it', call2.effort === 'high', String(call2.effort));

  seen.length = 0;
  await chatStream({ model: 'chat-model', provider: 'plain', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'max' });
  ok('a plain gateway is never sent a field it did not advertise', seen.at(-1).effort === undefined, String(seen.at(-1).effort));
}

section('a provider that refuses the knob is answered anyway');
{
  seen.length = 0;
  const out = await chat({ model: 'strict-model', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'max' });
  ok('the request is retried without reasoning_effort', seen.length === 2 && seen[0].effort === 'high' && seen[1].effort === undefined, JSON.stringify(seen.map((s) => s.effort)));
  ok('…and the answer is the provider\'s real one', out.text === 'answered anyway', out.text);
  ok('the rejection is remembered, so the retry is paid once', (seen.length = 0, await chat({ model: 'strict-model', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'max' }), seen.length === 1), `${seen.length} calls`);
}

section('thinking is streamed, not hidden');
{
  const events = [];
  const out = await chatStream(
    { model: 'think-model', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'balanced' },
    { onEvent: (e) => events.push(e) }
  );
  const thought = events.filter((e) => e.type === 'thinking').map((e) => e.text).join('');
  ok('the reasoning arrives as its own events', thought === 'First, consider the ask.', JSON.stringify(thought));
  ok('a phase says it is thinking', events.some((e) => e.type === 'phase' && e.phase === 'thinking'));
  ok('the answer is still only the answer', out.text === 'Hello, world', out.text);
  ok('the reasoning is returned with the answer', out.reasoning === 'First, consider the ask.', out.reasoning);
  ok('done reports how long the thinking took', out.thinking_ms >= 0 && Number.isFinite(out.thinking_ms));
  ok('thinking does not count as the first answer token', out.first_token_ms >= 0);

  const nonStream = await chat({ model: 'think-model-json', provider: 'mini', messages: [{ role: 'user', content: 'hi' }], keys });
  ok('a non-streamed reply keeps its reasoning too', nonStream.reasoning === 'the reasoning' && nonStream.text === 'the answer');

  const anthEvents = [];
  const anth = await chatStream(
    { model: 'claude-mock', provider: 'claudey', messages: [{ role: 'user', content: 'hi' }], keys, effort: 'max' },
    { onEvent: (e) => anthEvents.push(e) }
  );
  ok('Claude\'s thinking blocks are read the same way', /Claude thinks before answering\./.test(anth.reasoning || ''), anth.reasoning);
  ok('…and the text block is the answer', anth.text === 'Answered.', anth.text);
  ok('…with the thinking budget requested', seen.some((s) => s.thinking?.type === 'enabled' && s.thinking.budget_tokens > 0));
}

section('MCP tool lists are cached, and never block an answer');
{
  cache.forgetTools();
  const conns = [{ id: 'slow', status: 'connected', enabled: true, updated_at: 'v1', url: 'stdio:not-a-real-server' }];
  ok('a key exists for the connection set', cache.connectionKey(conns) === 'slow@v1:1', cache.connectionKey(conns));
  ok('the fingerprint changes with the server version', cache.connectionKey([{ ...conns[0], updated_at: 'v2' }]) !== cache.connectionKey(conns));

  // A gateway that accepts the connection and never answers the handshake: the
  // exact shape of a slow MCP server, and the reason a message must not wait.
  const hang = http.createServer(() => { /* deliberately never responds */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const hangConn = { id: 'slow', status: 'connected', enabled: true, updated_at: 'slow-1', url: `http://127.0.0.1:${hang.address().port}/mcp`, type: 'http' };
  const started = Date.now();
  const first = await cache.toolsFor([hangConn], { waitMs: 120 });
  const took = Date.now() - started;
  ok('a cold cache answers inside its budget', took < 1500, `${took}ms`);
  ok('…saying it is warming rather than pretending there are no tools', first.warming === true && first.from === 'warming', JSON.stringify(first));
  hang.closeAllConnections?.();

  // A warm entry is served from disk/memory with no spawn at all.
  cache.forgetTools();
  const entry = cache.cachedTools([{ id: 'x', updated_at: 'v1' }]);
  ok('an unknown set has no entry', entry === null);
}

section('the cache survives a restart (it is a file)');
{
  const file = path.join(process.env.ANTICODEX_DATA, 'mcp-tools.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries: { 'k@v1:1': { at: Date.now(), tools: [{ type: 'function', function: { name: 'one' } }] } } }));
  const fresh = await import(`../lib/tool-cache.js?fresh=${Date.now()}`);
  const hit = fresh.cachedTools([{ id: 'k', updated_at: 'v1', enabled: true }]);
  ok('a written entry is read back', hit?.tools?.length === 1, JSON.stringify(hit));
  ok('…with its age', hit.age_ms >= 0);
  ok('a stale-by-age entry is not used for a fresh answer', fresh.cachedTools([{ id: 'k', updated_at: 'v1' }], { allowStale: false, now: Date.now() + 2 * 60 * 60 * 1000 }) === null);
  ok('clearing forgets everything', (fresh.forgetTools(), fresh.cachedTools([{ id: 'k', updated_at: 'v1' }]) === null));
}

upstream.close();
fs.rmSync(process.env.ANTICODEX_DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
