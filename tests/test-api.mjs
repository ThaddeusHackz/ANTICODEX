// ANTICODEX API integration tests — spins the real server and exercises every
// critical flow: health, models, chat, auth, reset codes, MCP, admin, media.

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import httpModule from 'node:http';
const ROOT = new URL('..', import.meta.url).pathname;
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-test-'));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

// A fake OpenAI-compatible provider. Tests assert on `upstreamHits` so "my key
// was used" and "the model id we sent is real" are proven, not assumed.
const upstreamHits = [];
const LIVE = ['mock/big-model', 'mock/tiny-model', 'mock/brand-new-2027'];
const SOLO = 'mock/solo-model';
let UPSTREAM_PORT = 0;
const UPSTREAM = await new Promise((resolve) => {
  const srv = httpModule.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not json */ }
      upstreamHits.push({ url: req.url, auth: req.headers.authorization || '', body });
      res.setHeader('Content-Type', 'application/json');
      if ((req.headers.authorization || '') === 'Bearer revoked-key') {
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      const auth = req.headers.authorization || '';
      if (req.url.includes('/models')) {
        // the "solo" gateway lists exactly one model, so there is nothing to
        // retry with when that one model refuses
        if (auth === 'Bearer solo-key') return res.end(JSON.stringify({ object: 'list', data: [{ id: SOLO }] }));
        return res.end(JSON.stringify({ object: 'list', data: LIVE.map((id) => ({ id })) }));
      }
      if (req.url.includes('/chat/completions')) {
        // a key that can list but not call: the retry cannot save this one
        if (auth === 'Bearer list-only-key') {
          return res.end(JSON.stringify({ error: { message: 'model_not_found: no capacity is deployed for this model on your key' } }));
        }
        // Exactly what a real gateway does with a model it does not host: an HTTP
        // 200 whose body is an error. ANTICODEX must notice, sync the live list
        // and answer with a model that exists instead of failing.
        if (!LIVE.includes(String(body.model || '')) && body.model !== SOLO) {
          return res.end(JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist or you do not have access to it` } }));
        }
        // listed but not callable — the honest "your key cannot use this one" case
        if (body.model === SOLO) {
          return res.end(JSON.stringify({ error: { message: `The model \`${SOLO}\` is not available for this key (model_not_found)` } }));
        }
        // If the literal "default" ever reaches a real upstream, the picker broke.
        if (body.model === 'default' || !body.model) return res.end(JSON.stringify({ error: { message: 'model_not_found: default' } }));
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `upstream answered with ${body.model}` } }], model: body.model, usage: { total_tokens: 7 } }));
      }
      res.end('{}');
    });
  });
  srv.listen(0, '127.0.0.1', () => { UPSTREAM_PORT = srv.address().port; resolve(srv); });
});
let passed = 0, failed = 0;

async function api(action, payload = {}, headers = {}) {
  const res = await fetch(`${BASE}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  const server = spawn('node', ['server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', EXPOSE_RESET_CODES: 'true',
      // A gateway we control, registered the same way a user's custom provider
      // would be: proves per-account keys, model sync and id substitution.
      CUSTOM_PROVIDERS: JSON.stringify([{
        id: 'localmock', name: 'Mock Gateway', type: 'openai',
        endpoint: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, key_env: 'LOCALMOCK_API_KEY',
        // first curated id is deliberately NOT served by the upstream, so the
        // auto-retry has something real to recover from
        default_model: 'default', models: [{ id: 'mock/stale-catalog-model', label: 'Stale Guess' }, { id: 'mock/big-model', label: 'Big Model' }]
      }, {
        id: 'mocksolo', name: 'Mock Solo', type: 'openai',
        endpoint: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, key_env: 'MOCKSOLO_API_KEY',
        default_model: 'default', models: [{ id: 'mock/solo-model', label: 'Solo' }]
      }]),
      // Isolated data dir so tests never touch the real config.json / db.json
      ANTICODEX_DATA: DATA_TMP
    },
    stdio: 'ignore'
  });

  // Wait for boot.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(`${BASE}/api/bridge`, { method: 'POST', body: JSON.stringify({ action: 'health' }), headers: { 'Content-Type': 'application/json' } }); up = true; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert(up, 'server did not start');

  console.log('\n— core —');
  let r = await api('health');
  ok('health', r.status === 200 && r.data.ok === true && r.data.name === 'ANTICODEX');

  r = await api('config');
  ok('config', r.status === 200 && r.data.name === 'ANTICODEX' && r.data.features.chat);

  r = await api('models');
  ok('models lists nvidia + demo', r.status === 200 && r.data.providers.some((p) => p.id === 'nvidia') && r.data.providers.some((p) => p.id === 'demo'));

  console.log('— provider directory (2026-10-18 catalog) —');
  r = await api('models');
  const dir = r.data.directory || [];
  ok('directory has 25+ providers', dir.length >= 25, `got ${dir.length}`);
  ok('deepseek provider present', dir.some((p) => p.id === 'deepseek'));
  const ds = dir.find((p) => p.id === 'deepseek');
  ok('DeepSeek V4.1 Flash 1017 in catalog', ds && ds.models.some((m) => m.id === 'deepseek-flash') && ds.models.some((m) => m.id === 'deepseek-v4.1-flash-1017'));
  ok('DeepSeek endpoint', ds && ds.endpoint === 'https://api.deepseek.com/v1');
  const nv = dir.find((p) => p.id === 'nvidia');
  ok('NVIDIA Nemotron 3.5 Lightning in catalog', nv && nv.models.some((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b'));
  ok('NVIDIA Nemotron 3 Ultra + Switchyard', nv && nv.models.some((m) => m.id === 'nvidia/nemotron-3-ultra-550b-a55b') && nv.models.some((m) => m.id === 'nvidia/switchyard'));
  ok('openai/anthropic/google/xai/mistral/moonshot/zai/qwen providers', ['openai', 'anthropic', 'google', 'xai', 'mistral', 'moonshot', 'zai', 'qwen'].every((id) => dir.some((p) => p.id === id)));
  ok('openrouter aggregator present', dir.some((p) => p.id === 'openrouter' && p.models_dynamic));
  ok('atria provider present', dir.some((p) => p.id === 'atria'));
  r = await api('chat', { messages: [{ role: 'user', content: 'what is deepseek v4.1 flash' }], model: 'anticodex/demo-core' });
  ok('demo knows deepseek 1017', r.status === 200 && r.data.text.includes('V4.1'));

  r = await api('chat', { messages: [{ role: 'user', content: 'hello' }], model: 'anticodex/demo-core' });
  ok('chat demo responds', r.status === 200 && typeof r.data.text === 'string' && r.data.text.length > 10);

  // provider::model routing with desktop-style key override
  r = await api('chat', { messages: [{ role: 'user', content: 'hi' }], model: 'anticodex/demo-core', provider: 'nvidia', provider_keys: {} });
  ok('provider routing falls back to demo without key', r.status === 200 && r.data.provider === 'demo');

  console.log('— search & media (demo fallbacks) —');
  r = await api('search', { query: 'what is ANTICODEX' });
  ok('search returns results', r.status === 200 && Array.isArray(r.data.results) && r.data.results.length > 0);

  r = await api('image', { prompt: 'crystal prism aurora', width: 512, height: 512 });
  ok('image returns data url', r.status === 200 && String(r.data.image).startsWith('data:image/'));

  r = await api('video_start', { prompt: 'drone over neon city', duration: 6 });
  ok('video job created', r.status === 200 && r.data.id && r.data.status);
  const jobId = r.data.id;
  r = await api('video_status', { id: jobId });
  ok('video status polled', r.status === 200 && r.data.status);

  console.log('— auth flows —');
  const email = `tester${Date.now()}@anticodex.dev`;
  r = await api('register', { email, password: 'secret123', name: 'Test User' });
  ok('register creates the account and signs in', r.status === 200 && r.data.ok && r.data.token && r.data.user.email === email);
  ok('register still hands out a verification code', r.data.dev_code?.length === 6);
  ok('no provider internals leak into sign-up errors', !/bearer|apikey|jwt|schema|ERFOS|EROFS|PostgREST|relation/i.test(JSON.stringify(r.data)));
  const regCode = r.data.dev_code;
  const sessionToken = r.data.token;

  r = await api('me', { token: sessionToken });
  ok('the sign-up session is live', r.status === 200 && r.data.user.email === email);

  r = await api('login', { email, password: 'secret123' });
  ok('login works right after sign-up (no email gate)', r.status === 200 && r.data.ok && r.data.token);

  r = await api('verify_code', { email, code: '000000', purpose: 'signup' });
  ok('wrong verify code rejected', r.status === 200 && r.data.ok === false);

  r = await api('resend_code', { email });
  ok('resend issues a fresh code', r.status === 200 && r.data.ok && r.data.dev_code?.length === 6);

  r = await api('verify_code', { email, code: regCode, purpose: 'signup' });
  ok('verify_code accepts a live code', r.status === 200 && r.data.ok && r.data.token);

  r = await api('register', { email, password: 'secret123', name: 'Dup' });
  ok('duplicate register rejected', r.status === 200 && r.data.ok === false && /already exists/i.test(r.data.error));

  r = await api('login', { email, password: 'wrong' });
  ok('wrong password rejected', r.status === 200 && r.data.ok === false && /wrong email or password/i.test(r.data.error));

  r = await api('login', { email, password: 'secret123' });
  ok('login after verify', r.status === 200 && r.data.token && r.data.user.email === email);
  const token = r.data.token;

  r = await api('me', { token });
  ok('me returns user', r.status === 200 && r.data.user.email === email);

  r = await api('logout', { token });
  ok('logout drops the session', r.status === 200 && r.data.ok && (await api('me', { token })).status === 401);

  r = await api('login', { email, password: 'secret123' });
  const token2 = r.data.token;

  r = await api('forgot', { email });
  ok('forgot emails code', r.status === 200 && r.data.ok && r.data.dev_code?.length === 6);
  const resetCode = r.data.dev_code;

  r = await api('reset', { email, code: '000000', new_password: 'newpass123' });
  ok('wrong code rejected', r.status === 200 && r.data.ok === false);

  r = await api('reset', { email, code: resetCode, new_password: 'newpass123' });
  ok('reset with code', r.status === 200 && r.data.ok);

  r = await api('login', { email, password: 'newpass123' });
  ok('login with new password', r.status === 200 && r.data.token);

  r = await api('reset', { email, code: resetCode, new_password: 'again456' });
  ok('code is single-use', r.status === 200 && r.data.ok === false);

  r = await api('login', { email, password: 'weak' });
  ok('account cannot be created with junk name', (await api('register', { email: 'x@y.zz', password: 'password1', name: '<script>' })).data.ok === false);

  console.log('— mcp —');
  r = await api('mcp', { op: 'catalog' });
  ok('mcp catalog', r.status === 200 && r.data.catalog.length >= 15 && r.data.catalog.some((c) => c.id === 'github'));
  ok('mcp gateways present', r.data.gateways?.some((g) => g.id === 'zapier'));
  r = await api('mcp', { op: 'save', connection: { id: 'mcp_t1', name: 'Test MCP', transport: 'http', url: 'https://example.com/mcp', status: 'connected' } });
  ok('mcp connection saved', r.status === 200);
  r = await api('mcp', { op: 'probe', url: 'https://example.invalid/mcp' });
  ok('mcp probe fails gracefully', r.status === 200 && r.data.ok === false && r.data.error);
  r = await api('mcp', { op: 'connect_begin', url: 'https://example.invalid/mcp', connection_id: 'mcp_t1', redirect_uri: 'http://localhost:8787/mcp/callback' });
  ok('connect_begin reports unreachable server', r.status === 200 && r.data.ok === false);
  r = await api('mcp', { op: 'list' });
  ok('mcp list', r.status === 200 && r.data.connections.some((c) => c.id === 'mcp_t1'));
  r = await api('mcp', { op: 'call', connection_id: 'mcp_t1', tool: 'x' });
  ok('mcp call reports failure', r.status === 200);
  r = await api('mcp', { op: 'delete', id: 'mcp_t1' });
  ok('mcp delete', r.status === 200);

  console.log('— admin —');
  r = await api('admin', { op: 'login', username: 'Thaddeusadmin', password: 'wrong' });
  ok('admin wrong creds rejected', r.status === 401);
  r = await api('admin', { op: 'login', username: 'Thaddeusadmin', password: 'Thaddeusk12' });
  ok('admin login', r.status === 200 && r.data.token);
  const at = r.data.token;
  r = await api('admin', { op: 'stats', token: at });
  ok('admin stats', r.status === 200 && typeof r.data.users === 'number');
  r = await api('admin', { op: 'users', token: at });
  ok('admin users', r.status === 200 && r.data.users.some((u) => u.email === email));
  r = await api('admin', { op: 'set_keys', token: at, NVIDIA_API_KEY: '' });
  ok('admin set_keys', r.status === 200 && r.data.ok);
  r = await api('admin', { op: 'stats', token: 'bad' });
  ok('admin bad token rejected', r.status === 401);

  console.log('— owner account (second admin: app sign-in, not the console) —');
  r = await api('login', { email: 'tthaddeus75@gmail.com', password: 'Thaddeusk12' });
  ok('owner signs in to the app', r.status === 200 && r.data.ok && r.data.token);
  ok('owner is flagged admin', r.data.user?.role === 'admin' && r.data.role === 'admin');
  ok('owner display name', r.data.user?.name === 'Thaddeus');
  r = await api('register', { email: 'tthaddeus75@gmail.com', password: 'another123', name: 'Hijack' });
  ok('owner account cannot be re-registered over', r.data.ok === false && /already exists/i.test(r.data.error || ''));
  r = await api('login', { email: 'tthaddeus75@gmail.com', password: 'nope-nope-nope' });
  ok('owner password is still required', r.data.ok === false && /wrong email or password/i.test(r.data.error || ''));
  r = await api('admin', { op: 'login', username: 'tthaddeus75@gmail.com', password: 'Thaddeusk12' });
  ok('owner email is NOT an admin-console login', r.status === 401);
  r = await api('admin', { op: 'ensure_owner', token: at });
  ok('admin can re-materialise the owner row', r.status === 200 && r.data.ok && r.data.users.some((u) => u.email === 'tthaddeus75@gmail.com' && u.role === 'admin'));

  r = await api('login', { email, password: 'newpass123' });
  const tokenLive = r.data.token;
  r = await api('me', { token: token2 });
  ok('a password reset signs other devices out', r.status === 401);
  r = await api('user_keys', { op: 'get', token: tokenLive });
  ok('the new session works', r.status === 200 && r.data.ok);

  console.log('— per-user API keys (replace built-ins per account) —');
  r = await api('user_keys', { op: 'get' });
  ok('user_keys requires login', r.status === 401);
  r = await api('user_keys', { op: 'get', token: tokenLive });
  ok('user_keys empty initially', r.status === 200 && r.data.count === 0);
  r = await api('user_keys', { op: 'save', token: tokenLive, key_env: 'NVIDIA_API_KEY', value: 'nvapi-MY-OWN-KEY-1234567890' });
  ok('save_user_key', r.status === 200 && r.data.ok);
  r = await api('user_keys', { op: 'get', token: tokenLive });
  ok('user key masked + tied to email', r.status === 200 && r.data.keys.NVIDIA_API_KEY?.includes('…') && r.data.email === email);
  r = await api('user_keys', { op: 'save', token: tokenLive, key_env: 'TAVILY_API_KEY', value: 'tvly-personal-abcdefghijk' });
  ok('second user key saved', r.data.ok);
  r = await api('user_keys', { op: 'delete', token: tokenLive, key_env: 'NVIDIA_API_KEY' });
  ok('delete reverts to built-in', r.data.ok);
  r = await api('user_keys', { op: 'get', token: tokenLive });
  ok('override removed, one remains', r.data.count === 1 && !r.data.keys.NVIDIA_API_KEY && r.data.keys.TAVILY_API_KEY);
  r = await api('user_keys', { op: 'delete', token: tokenLive, key_env: 'TAVILY_API_KEY' });
  ok('cleanup', r.data.ok);


  console.log('— your key + the model picker (end to end, against a real upstream) —');
  const mk = 'Bearer-mock-key-for-tests';
  const LIVE2 = ['mock/big-model', 'mock/tiny-model', 'mock/brand-new-2027'];
  r = await api('config');
  let gw = (r.data.providers || []).find((p) => p.id === 'localmock');
  ok('a gateway is a first-class row in config', !!gw && gw.key_env === 'LOCALMOCK_API_KEY' && gw.configured === false);
  ok('config carries real model ids, so "provider::default" cannot be built', (gw?.models || []).some((m) => (m.id || m) === 'mock/big-model'));
  ok('until the endpoint is asked, nothing is claimed as verified', gw?.verified === false, JSON.stringify(gw?.verified));
  r = await api('chat', { provider: 'localmock', model: 'default', messages: [{ role: 'user', content: 'ping' }] });
  ok('an unconfigured provider explains itself instead of a bare 500', r.status === 200 && r.data.ok === false && /no API key yet/i.test(r.data.error || '') && r.data.fix === 'key' && r.data.settings_link === '/settings');
  r = await api('save_provider_key', { key_env: 'LOCALMOCK_API_KEY', value: mk });
  ok('global key writes are admin-only now', r.status === 401 && /admin-only/i.test(r.data.error || ''));
  r = await api('save_provider_key', { token: at, key_env: 'ANTICODEX_ADMIN_PASSWORD', value: 'x' });
  ok('the key allowlist refuses account/env secrets', r.status === 400);
  r = await api('user_keys', { op: 'save', token: tokenLive, key_env: 'LOCALMOCK_API_KEY', value: mk });
  ok('saving an account key reports ok', r.status === 200 && r.data.ok);
  upstreamHits.length = 0;
  r = await api('chat', { provider: 'localmock', model: 'default', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('a catalog guess the endpoint does not serve is answered anyway', r.data.model === 'mock/big-model' && /upstream answered with mock\/big-model/.test(r.data.content || ''), JSON.stringify(r.data).slice(0, 220));
  ok('and it says what it swapped instead of failing silently', r.data.retried_with === 'mock/big-model' && r.data.asked_for === 'mock/stale-catalog-model' && /no model called/.test(r.data.note || ''), String(r.data.note));
  ok('the retry is visible on the wire', upstreamHits.filter((h) => h.url.includes('chat/completions')).map((h) => h.body.model).join(',') === 'mock/stale-catalog-model,mock/big-model', JSON.stringify(upstreamHits.map((h) => h.body.model)));
  ok('the account key was on both calls', upstreamHits.every((h) => h.auth === `Bearer ${mk}`));
  ok('the live list it pulled is kept for the picker', (await api('models', { token: tokenLive })).data.picker.providers.find((p) => p.id === 'localmock')?.verified === true);
  r = await api('sync_models', { provider: 'localmock', token: tokenLive });
  ok('so the picker leads with ids the endpoint confirmed', r.data.models[0].live === true && r.data.models.some((m) => m.id === 'mock/stale-catalog-model' && m.unverified === true));
  r = await api('config', { token: tokenLive });
  gw = (r.data.providers || []).find((p) => p.id === 'localmock');
  ok('the row flips to configured for that account', gw?.configured === true && gw?.key_owner === 'you');
  r = await api('config');
  gw = (r.data.providers || []).find((p) => p.id === 'localmock');
  ok("and stays unconfigured for everyone else's account", gw?.configured === false && gw?.key_owner === null);
  r = await api('models', { token: tokenLive });
  const pg = (r.data.picker?.providers || []).find((p) => p.id === 'localmock');
  ok('picker lists every provider with curated models', r.data.picker?.total_models > 200 && r.data.picker?.providers?.length > 20);
  ok('picker marks the gateway configured with its key_env', pg?.configured === true && pg?.key_env === 'LOCALMOCK_API_KEY' && pg.models.some((m) => m.id === 'mock/big-model' && m.label === 'Big Model'));
  r = await api('sync_models', { provider: 'localmock', token: tokenLive });
  ok('live models sync using the account key', r.data.ok && ['provider', 'cache'].includes(r.data.source) && r.data.models.some((m) => m.id === 'mock/brand-new-2027'));
  ok('curated labels survive the sync', r.data.models.some((m) => m.id === 'mock/big-model' && m.label === 'Big Model'));
  ok('live ids lead and are flagged', r.data.models[0].live === true && r.data.models.some((m) => m.id === 'mock/brand-new-2027' && m.live === true));
  ok('a catalog-only id stays selectable but is honestly tagged', r.data.models.some((m) => m.id === 'mock/stale-catalog-model' && m.unverified === true), JSON.stringify(r.data.models.map((m) => [m.id, !!m.live, !!m.unverified])));
  ok('sync reports what it proved', r.data.verified === true && r.data.live === 3, JSON.stringify({ verified: r.data.verified, live: r.data.live }));
  r = await api('sync_models', { provider: 'localmock', token: tokenLive });
  ok('a second sync is cached, not hammered', r.data.source === 'cache');
  r = await api('sync_models', { provider: 'nosuchprovider', token: tokenLive });
  ok('an unknown provider answers instead of throwing', r.status === 200 && r.data.ok === false && /unknown provider/i.test(r.data.error || ''));
  upstreamHits.length = 0;
  r = await api('chat', { provider: 'localmock', model: 'default', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('a "default" ref is replaced with a real model id', r.data.model === 'mock/big-model' && /upstream answered with mock\/big-model/.test(r.data.content || ''));
  const hit = upstreamHits.find((h) => h.url.includes('chat/completions'));
  ok('the upstream sees your key and a real model', hit?.auth === `Bearer ${mk}` && hit?.body.model === 'mock/big-model');
  ok('routing metadata is reported back', r.data.provider === 'localmock' && r.data.usage?.total_tokens === 7);
  r = await api('chat', { provider: 'localmock', model: 'does-not-exist', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('an unknown id is retried with a real one instead of erroring', r.data.model === 'mock/big-model' && r.data.retried_with === 'mock/big-model' && r.data.asked_for === 'does-not-exist');
  await api('user_keys', { op: 'save', token: tokenLive, key_env: 'LOCALMOCK_API_KEY', value: 'list-only-key' });
  upstreamHits.length = 0;
  r = await api('chat', { provider: 'localmock', model: 'mock/ghost-model', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('when even the retry fails, you get alternatives to click, not a shrug', r.data.ok === false && r.data.fix === 'model' && r.data.verdict === 'model' && r.data.model_picker === true && (r.data.fallback || []).length >= 1 && r.data.fallback.every((f) => LIVE2.includes(f.id)) && (r.data.tried_models || []).length === 2, JSON.stringify(r.data).slice(0, 240));
  ok('it tried more than one model before giving up', upstreamHits.filter((h) => h.url.includes('chat/completions')).length === 2);
  await api('user_keys', { op: 'save', token: tokenLive, key_env: 'LOCALMOCK_API_KEY', value: mk });
  await api('user_keys', { op: 'save', token: tokenLive, key_env: 'MOCKSOLO_API_KEY', value: 'solo-key' });
  upstreamHits.length = 0;
  r = await api('chat', { provider: 'mocksolo', model: 'default', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('a listed-but-unusable model with nothing else to try says so honestly', r.data.ok === false && r.data.fix === 'model' && /no model called/.test(r.data.error || '') && !r.data.tried_models && upstreamHits.filter((h) => h.url.includes('chat/completions')).length === 1, JSON.stringify(r.data).slice(0, 240));
  ok('and it names the model that was actually sent', r.data.model === 'mock/solo-model', String(r.data.model));
  await api('user_keys', { op: 'delete', token: tokenLive, key_env: 'MOCKSOLO_API_KEY' });
  await api('user_keys', { op: 'save', token: tokenLive, key_env: 'LOCALMOCK_API_KEY', value: 'revoked-key' });
  r = await api('chat', { provider: 'localmock', model: 'mock/tiny-model', messages: [{ role: 'user', content: 'ping' }], token: tokenLive });
  ok('a rejected key is blamed on the key, with a fix', r.data.ok === false && r.data.fix === 'key' && r.data.settings_link === '/settings');
  r = await api('chat', { provider: 'localmock', model: 'default', messages: [{ role: 'user', content: 'ping' }] });
  ok('your saved key is never used for anonymous callers', r.data.ok === false && /no API key yet/i.test(r.data.error || ''));
  r = await api('test_endpoint', { provider: 'localmock', api_key: mk, token: tokenLive });
  ok('a gateway row tests itself from its own id', r.data.ok === true && r.data.type === 'openai'
    && (r.data.models || []).includes('mock/big-model') && r.data.verified === 3 && /Key works/.test(r.data.message || ''));
  r = await api('test_endpoint', { provider: 'mocksolo', api_key: 'solo-key', token: tokenLive });
  ok('a key that lists a model but cannot call it is not called "working"', r.data.ok === false && r.data.listed_models >= 1
    && /not available|answered with an error/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 240));
  r = await api('sync_models', { provider: 'mocksolo', api_key: 'solo-key', refresh: true, token: tokenLive });
  ok('and the refusal does not stop the list from syncing', r.data.ok === true && r.data.models[0].live === true, JSON.stringify(r.data).slice(0, 200));
  await api('user_keys', { op: 'delete', token: tokenLive, key_env: 'LOCALMOCK_API_KEY' });

  console.log('— GitHub OAuth + desktop pairing —');
  r = await api('admin', { op: 'set_keys', token: at, GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'testsecret' });
  ok('github keys saved', r.status === 200 && r.data.ok);
  r = await api('github_login', {});
  ok('github authorize url issued', r.status === 200 && r.data.url?.includes('github.com/login/oauth/authorize') && r.data.url.includes('client_id=Iv1.testclient') && r.data.url.includes('state=st_') && r.data.mode === 'github-oauth');
  ok('github callback url configured', r.data.callback?.endsWith('/auth/callback'));
  ok('github state is self-contained (no db row needed)', /^st_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test((r.data.url.match(/state=([^&]+)/) || [])[1] || ''));
  const ghState = (r.data.url.match(/state=([^&]+)/) || [])[1];
  r = await api('oauth_callback', { code: 'badcode', state: 'gh_nope' });
  ok('unknown oauth state rejected', r.data.ok === false);
  r = await api('oauth_callback', { code: 'badcode', state: `${ghState.slice(0, -2)}zz` });
  ok('tampered oauth state rejected', r.data.ok === false);
  r = await api('oauth_callback', { code: 'badcode', state: ghState });
  ok('bad github code fails gracefully', r.data.ok === false && Boolean(r.data.error) && !/node_modules|at .*\.js:|fetch failed|undici/i.test(r.data.error));
  r = await api('oauth_callback', { state: ghState });
  ok('missing github code explained', r.data.ok === false && /authorization code/i.test(r.data.error));
  r = await api('admin', { op: 'set_keys', token: at, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
  ok('github keys cleared', r.status === 200 && r.data.ok);

  console.log('— pairing & updates —');
  r = await api('pair', { op: 'create' });
  ok('pair code', r.status === 200 && r.data.code?.length === 6);
  const pairCode = r.data.code;
  r = await api('pair', { op: 'claim', code: pairCode, user_id: 'u1', user_token: 'acx_linked', user: { name: 'Linked', email: 'l@x.com' } });
  ok('pair claim', r.status === 200 && r.data.token === 'acx_linked');
  r = await api('pair', { op: 'status', code: pairCode });
  ok('pair status returns linked account', r.status === 200 && r.data.claimed === true && r.data.token === 'acx_linked' && r.data.user?.email === 'l@x.com');
  r = await api('update_check');
  ok('update check runs', r.status === 200);

  console.log('— test_endpoint —');
  r = await api('test_endpoint', { endpoint: 'https://integrate.api.nvidia.com/v1', api_key: 'bad', type: 'openai' });
  ok('endpoint test needs a session (it is an SSRF relay)', r.status === 401 && r.data.sign_in === '/login');
  r = await api('test_endpoint', { endpoint: 'https://integrate.api.nvidia.com/v1', api_key: 'bad', type: 'openai', token: tokenLive });
  ok('endpoint test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
  r = await api('test_endpoint', { provider: 'anthropic', api_key: 'bad', token: tokenLive });
  ok('anthropic wire test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
  r = await api('test_endpoint', { provider: 'cohere', api_key: 'bad', token: tokenLive });
  ok('cohere wire test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
  r = await api('test_endpoint', { endpoint: 'http://127.0.0.1:1/v1', api_key: 'whatever', type: 'openai', token: tokenLive });
  ok('an unreachable endpoint is never blamed on your key', r.data.ok === false && r.data.verdict === 'unreachable' && /not a bad key|network limit/i.test(`${r.data.error} ${r.data.fix || ''}`), JSON.stringify(r.data).slice(0, 220));
  r = await api('test_endpoint', { provider: 'localmock', api_key: 'revoked-key', token: tokenLive });
  ok('a rejected key is called a rejected key', r.data.ok === false && r.data.verdict === 'key' && r.data.settings_link === '/settings', JSON.stringify(r.data).slice(0, 200));
  r = await api('test_endpoint', { token: tokenLive });
  ok('a probe with no endpoint is refused politely', r.status === 200 && r.data.ok === false && /endpoint required/i.test(r.data.error || ''));
  r = await api('sync_models', { provider: 'deepseek' });
  ok('sync_models returns keyed error gracefully', r.status === 200 && r.data.ok === false);

  console.log('— extras (voice/search/data services) —');
  r = await api('extras', { op: 'status' });
  ok('extras status lists services', r.status === 200 && r.data.ok && 'tavily' in r.data.services && 'elevenlabs' in r.data.services);
  r = await api('extras', { op: 'image_search', query: 'test' });
  ok('extras degrade gracefully without keys', r.status === 200 && r.data.ok === false && /not configured/i.test(r.data.error || ''));
  r = await api('extras', { op: 'tts', text: 'hi' });
  ok('tts degrades gracefully', r.status === 200 && r.data.ok === false);
  r = await api('extras', { op: 'nope' });
  ok('unknown extras op rejected', r.data.ok === false);

  console.log('— full provider catalog (26 providers / 471 OpenRouter ids) —');
  const { PROVIDER_DIRECTORY, OPENROUTER_EXTRA_MODELS } = await import('../lib/catalog.js');
  ok('27 directory providers', PROVIDER_DIRECTORY.length === 27);
  ok('471 OpenRouter ids in fallback', OPENROUTER_EXTRA_MODELS.length === 471 && new Set(OPENROUTER_EXTRA_MODELS).size === 471);
  const spot = [
    'deepseek/deepseek-v4.1-flash-1017', '~openai/gpt-sol-latest', 'sakana/fugu-ultra-v2',
    '~anthropic/claude-sonnet-latest', '~deepseek/deepseek-v4-flash-latest', '~z-ai/glm-latest',
    'qwen/qwen3.5-27b', 'google/gemma-4-31b-it', 'nvidia/nemotron-3-ultra-550b-a55b',
    'x-ai/grok-4.20-multi-agent', 'moonshotai/kimi-k2.5', 'xiaomi/mimo-v2.5-pro',
    'amazon/nova-2-lite-v1', 'openrouter/auto', 'microsoft/phi-4'
  ];
  ok('appendix spot ids present', spot.every((id) => OPENROUTER_EXTRA_MODELS.includes(id)));
  const find = (pid) => PROVIDER_DIRECTORY.find((p) => p.id === pid).models.map((m) => m.id);
  ok('deepseek-flash + 1017 in directory', ['deepseek-flash', 'deepseek-v4.1-flash-1017'].every((id) => find('deepseek').includes(id)));
  ok('atria endpoint is real', PROVIDER_DIRECTORY.find((p) => p.id === 'atria')?.endpoint === 'https://api.atria-asi.ai/v1');
  ok('experientiallabs provider present', PROVIDER_DIRECTORY.some((p) => p.id === 'experientiallabs' && p.endpoint === 'https://api.experientiallabs.ai/v1' && p.key_env === 'EXPLABS_API_KEY'));
  ok('directory stragglers present',
    ['gpt-3.5-turbo', 'gpt-4', 'o1-pro'].every((id) => find('openai').includes(id)) &&
    ['claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101'].every((id) => find('anthropic').includes(id)) &&
    ['gemini-3-flash-preview', 'gemini-2.5-flash-image'].every((id) => find('google').includes(id)) &&
    ['glm-4.5-air', 'glm-4.5v', 'glm-4.6v'].every((id) => find('zai').includes(id)) &&
    ['mistral-embed', 'mistral-large-2512', 'mistral-medium-2604'].every((id) => find('mistral').includes(id)) &&
    ['hy-mt2-7b', 'hy-mt2-30b-a3b', 'hy-mt2-1.8b'].every((id) => find('hunyuan').includes(id)) &&
    ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'].every((id) => find('meta').includes(id)) &&
    ['command-r-08-2024', 'command-r7b-12-2024'].every((id) => find('cohere').includes(id)) &&
    find('bedrock').includes('amazon.nova-2-lite-v1:0') &&
    ['deepseek-v4-flash-0731', 'deepseek-r1'].every((id) => find('deepseek').includes(id)));
  ok('desktop main + packager syntax', (() => {
    try {
      execFileSync(process.execPath, ['--check', 'desktop/main.mjs'], { cwd: ROOT });
      execFileSync(process.execPath, ['--check', 'desktop/package-win.mjs'], { cwd: ROOT });
      return true;
    } catch { return false; }
  })());

  server.kill('SIGTERM');
  UPSTREAM.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
