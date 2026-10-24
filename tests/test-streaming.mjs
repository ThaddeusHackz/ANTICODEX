// Streaming + model health tests.
//
// Two things are being pinned here, because both were user-visible complaints:
//
//   * "when I send a text they take sooo long, I don't even know if they will
//     respond" → the answer has to arrive as events: a phase, a heartbeat while
//     waiting, deltas, and a cancel that actually stops the upstream request.
//   * "when you text them it says there is nothing like this model available" →
//     a rejected id is recorded and then hidden from the picker (website and
//     desktop share this index), with a way to see and forget it.
//
// The upstream is a local HTTP server this test owns, so nothing here needs a key.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

process.env.ANTICODEX_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-stream-data-'));

const { chatStream, chat, probeModel, PROVIDER_DEFS_KEY } = await import('../lib/providers.js');
const health = await import('../lib/model-health.js');
const { modelIndex } = await import('../lib/providers.js');

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

// --- a provider that can be slow, fast, or wrong ----------------------------

const calls = [];
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
  calls.push({ url: req.url, model: parsed.model, stream: parsed.stream });

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock/real-model' }, { id: 'mock/other-model' }] }));
  }

  // An id this endpoint does not have — exactly what produced the error users saw.
  if (parsed.model === 'ghost-model') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'The model `ghost-model` does not exist', code: 'model_not_found' } }));
  }

  if (parsed.model === 'slow-model') {
    // Headers now, first token in 1.2 s: the heartbeat has to cover the gap.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': keep-alive\n\n');
    await new Promise((r) => setTimeout(r, 1200));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'slow ' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (parsed.model === 'abort-model') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    // Never finishes on its own: the client has to abort.
    await new Promise((r) => setTimeout(r, 30000));
    return res.end();
  }

  if (parsed.model === 'tool-model') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'do_thing', arguments: '' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Everything else: a stream when asked for one, JSON otherwise (probeModel
  // and the non-streaming chat path both use JSON).
  if (parsed.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }

  // Normal streamed answer, word by word.
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of ['Hello', ', ', 'world']) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  return res.end();
});

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const PORT = upstream.address().port;
const defs = [{
  id: 'mock', name: 'Mock provider', type: 'openai', endpoint: `http://127.0.0.1:${PORT}/v1`,
  key_env: 'MOCK_API_KEY', default_model: 'mock/real-model'
}];
// The bridge hands device-supplied gateways to the engine under this key; naming
// it here means the test exercises the same path a browser request does.
const keys = { MOCK_API_KEY: 'test-key', [PROVIDER_DEFS_KEY]: defs };

section('an OpenAI-shaped stream');
{
  const events = [];
  const out = await chatStream(
    { messages: [{ role: 'user', content: 'hi' }], model: 'real-model', provider: 'mock', keys },
    { onEvent: (e) => events.push(e) }
  );
  ok('the answer arrives as deltas', out.text === 'Hello, world');
  ok('…and is reported as text too', out.content === 'Hello, world');
  ok('phases are emitted before any text', events[0].type === 'phase' && events[0].phase === 'contacting');
  ok('…connected once the headers land', events.some((e) => e.type === 'phase' && e.phase === 'connected'));
  ok('…streaming when the first token arrives', events.some((e) => e.type === 'phase' && e.phase === 'streaming'));
  ok('a delta event per piece', events.filter((e) => e.type === 'delta').length === 3);
  ok('a done event closes the turn', events.at(-1).type === 'done' && events.at(-1).chars === 12);
  ok('the request asked for a stream', calls.at(-1).stream === true);
  ok('the first-token time is reported', typeof out.first_token_ms === 'number');
}

section('slow upstream: the heartbeat is the point');
{
  const events = [];
  const out = await chatStream(
    { messages: [{ role: 'user', content: 'hi' }], model: 'slow-model', provider: 'mock', keys },
    { onEvent: (e) => events.push(e), heartbeatMs: 200 }
  );
  const beats = events.filter((e) => e.type === 'heartbeat');
  ok('heartbeats arrive while waiting', beats.length >= 2, `${beats.length} beats`);
  ok('…each says what it is waiting for', beats.every((b) => typeof b.waiting_on === 'string'));
  ok('…with a growing elapsed time', beats.at(-1).elapsed_ms > beats[0].elapsed_ms);
  ok('the answer still arrives', out.text === 'slow answer');
  ok('the first token really was late', out.first_token_ms >= 1000, String(out.first_token_ms));
  const h = health.getHealth('mock::slow-model');
  ok('the latency is recorded for the picker', h?.latency_ms >= 1000 && h?.state === 'ok');
}

section('cancelling really cancels');
{
  const controller = new AbortController();
  const events = [];
  const pending = chatStream(
    { messages: [{ role: 'user', content: 'hi' }], model: 'abort-model', provider: 'mock', keys },
    { onEvent: (e) => { events.push(e); if (e.type === 'delta') setTimeout(() => controller.abort(), 50); }, signal: controller.signal }
  );
  const out = await pending;
  ok('the partial answer is kept', out.aborted === true && out.text === 'partial');
  ok('…and no done event claims success', !events.some((e) => e.type === 'done'));
  ok('an empty delta list is not an error', events.some((e) => e.type === 'delta'));
}

section('tool calls survive the stream');
{
  const events = [];
  const out = await chatStream(
    { messages: [{ role: 'user', content: 'hi' }], model: 'tool-model', provider: 'mock', keys, tools: [{ type: 'function', function: { name: 'do_thing', parameters: { type: 'object' } } }] },
    { onEvent: (e) => events.push(e) }
  );
  ok('a streamed tool call is reassembled', out.tool_calls?.[0]?.function?.name === 'do_thing');
  ok('…with its arguments', out.tool_calls[0].function.arguments === '{"x":1}');
  ok('…and nothing pretends to be an answer', out.text === '');
}

section('a rejected model is remembered, then hidden');
{
  const events = [];
  let threw = null;
  try {
    await chatStream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'ghost-model', provider: 'mock', keys },
      { onEvent: (e) => events.push(e) }
    );
  } catch (e) { threw = e; }
  ok('the call fails with the provider’s own sentence', /does not exist/.test(String(threw?.message || '')));
  ok('an error event was emitted before the throw', events.some((e) => e.type === 'error' && e.state === 'missing'));
  const h = health.getHealth('mock::ghost-model');
  ok('the verdict is recorded', h?.state === 'missing');
  ok('…and the model counts as dead', health.isDead('mock::ghost-model'));

  // The index is what the picker reads — on the website and in the desktop app.
  const idx = modelIndex(keys);
  const mock = idx.providers.find((p) => p.id === 'mock');
  ok('the dead id is not offered', !(mock.models || []).some((m) => m.id === 'ghost-model'));
  ok('…and the reason is kept for the UI', idx.hidden.models.some((m) => m.id === 'ghost-model' && /does not exist/.test(m.reason)));
  const withHidden = modelIndex(keys, { includeHidden: true });
  ok('it is still visible on request', withHidden.providers.find((p) => p.id === 'mock').models.some((m) => m.id === 'ghost-model' && m.dead === true));
  ok('a successful call revives the model', (health.recordOutcome('mock::ghost-model', { state: 'ok', ms: 10 }), health.isDead('mock::ghost-model') === false));
}

section('classification');
{
  ok('"model not found" is missing', health.classifyFailure(new Error('model_not_found: nope')) === 'missing');
  ok('a bare 404 that mentions the model is missing', health.classifyFailure(new Error('404 model unavailable')) === 'missing');
  ok('a 404 on the endpoint is not', health.classifyFailure(new Error('404 page not found')) !== 'missing');
  ok('a 401 is a key problem', health.classifyFailure(new Error('401 unauthorized')) === 'key');
  ok('a 429 is quota', health.classifyFailure(new Error('429 rate limit')) === 'quota');
  ok('a timeout is the network', health.classifyFailure(new Error('fetch failed ECONNRESET')) === 'network');
  ok('a 500 is a retry', health.classifyFailure(new Error('503 overloaded')) === 'retry');
}

section('probing one model answers in eight tokens');
{
  const good = await probeModel({ model: 'real-model', provider: 'mock', keys });
  ok('a working model reports ok and a time', good.ok === true && good.ms >= 0);
  const bad = await probeModel({ model: 'ghost-model', provider: 'mock', keys });
  ok('a ghost reports the verdict', bad.ok === false && bad.state === 'missing');
  ok('the probe asked for at most 8 tokens', calls.some((c) => c.model === 'real-model'));
}

section('the picker hides what the endpoint did not list');
{
  // Ask the endpoint for its own list, then check the index: catalog guesses
  // must not be offered next to confirmed ids.
  const { syncModels } = await import('../lib/providers.js');
  const synced = await syncModels({ provider: 'mock', keys });
  ok('sync returns the live list', synced.ok === true && synced.live === 2);
  const idx = modelIndex(keys);
  const mock = idx.providers.find((p) => p.id === 'mock');
  ok('only live ids are offered', mock.models.every((m) => m.live === true));
  ok('…and the confirmed ids are there', mock.models.some((m) => m.id === 'mock/real-model'));
}

section('health survives a restart (it is a file, not a variable)');
{
  const snapshot = health.allHealth();
  ok('the record has entries', snapshot.length >= 2);
  ok('…newest first', (snapshot[0].checked_at || 0) >= (snapshot.at(-1).checked_at || 0));
  const summary = health.summary();
  ok('the summary counts tracked models', summary.tracked === snapshot.length);
  ok('…and knows the slowest', summary.slowest?.latency_ms >= 1000);
  ok('clearing forgets it', health.clearHealth('mock::ghost-model') && !health.getHealth('mock::ghost-model'));
}

upstream.close();
fs.rmSync(process.env.ANTICODEX_DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
