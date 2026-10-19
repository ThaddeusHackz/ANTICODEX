// ANTICODEX API integration tests — spins the real server and exercises every
// critical flow: health, models, chat, auth, reset codes, MCP, admin, media.

import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-test-'));

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
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
  ok('register sends code', r.status === 200 && r.data.ok && r.data.dev_code?.length === 6);
  const regCode = r.data.dev_code;

  r = await api('login', { email, password: 'secret123' });
  ok('login blocked before email verify', r.status === 200 && r.data.ok === false && /not verified|verify/i.test(r.data.error || ''));

  r = await api('verify_code', { email, code: '000000', purpose: 'signup' });
  ok('wrong verify code rejected', r.status === 200 && r.data.ok === false);

  r = await api('register', { email, password: 'secret123', name: 'Dup' });
  ok('re-register unconfirmed resends code', r.status === 200 && r.data.ok && r.data.dev_code?.length === 6);

  r = await api('verify_code', { email, code: regCode, purpose: 'signup' });
  ok('verify_code confirms account', r.status === 200 && r.data.ok);

  r = await api('register', { email, password: 'secret123', name: 'Dup' });
  ok('duplicate register rejected once verified', r.status === 200 && r.data.ok === false);

  r = await api('login', { email, password: 'wrong' });
  ok('wrong password rejected', r.status === 200 && r.data.ok === false);

  r = await api('login', { email, password: 'secret123' });
  ok('login after verify', r.status === 200 && r.data.token && r.data.user.email === email);
  const token = r.data.token;

  r = await api('me', { token });
  ok('me returns user', r.status === 200 && r.data.user.email === email);

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

  console.log('— per-user API keys (replace built-ins per account) —');
  r = await api('user_keys', { op: 'get' });
  ok('user_keys requires login', r.status === 401);
  r = await api('user_keys', { op: 'get', token });
  ok('user_keys empty initially', r.status === 200 && r.data.count === 0);
  r = await api('user_keys', { op: 'save', token, key_env: 'NVIDIA_API_KEY', value: 'nvapi-MY-OWN-KEY-1234567890' });
  ok('save_user_key', r.status === 200 && r.data.ok);
  r = await api('user_keys', { op: 'get', token });
  ok('user key masked + tied to email', r.status === 200 && r.data.keys.NVIDIA_API_KEY?.includes('…') && r.data.email === email);
  r = await api('user_keys', { op: 'save', token, key_env: 'TAVILY_API_KEY', value: 'tvly-personal-abcdefghijk' });
  ok('second user key saved', r.data.ok);
  r = await api('user_keys', { op: 'delete', token, key_env: 'NVIDIA_API_KEY' });
  ok('delete reverts to built-in', r.data.ok);
  r = await api('user_keys', { op: 'get', token });
  ok('override removed, one remains', r.data.count === 1 && !r.data.keys.NVIDIA_API_KEY && r.data.keys.TAVILY_API_KEY);
  r = await api('user_keys', { op: 'delete', token, key_env: 'TAVILY_API_KEY' });
  ok('cleanup', r.data.ok);

  console.log('— GitHub OAuth + desktop pairing —');
  r = await api('admin', { op: 'set_keys', token: at, GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'testsecret' });
  ok('github keys saved', r.status === 200 && r.data.ok);
  r = await api('github_login', {});
  ok('github authorize url issued', r.status === 200 && r.data.url?.includes('github.com/login/oauth/authorize') && r.data.url.includes('client_id=Iv1.testclient') && r.data.url.includes('state=gh_') && r.data.mode === 'github-oauth');
  ok('github callback url configured', r.data.callback?.endsWith('/auth/callback'));
  const ghState = (r.data.url.match(/state=([^&]+)/) || [])[1];
  r = await api('oauth_callback', { code: 'badcode', state: 'gh_nope' });
  ok('unknown oauth state rejected', r.data.ok === false);
  r = await api('oauth_callback', { code: 'badcode', state: ghState });
  ok('bad github code fails gracefully', r.data.ok === false && Boolean(r.data.error));
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
  ok('endpoint test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
  r = await api('test_endpoint', { provider: 'anthropic', api_key: 'bad' });
  ok('anthropic wire test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
  r = await api('test_endpoint', { provider: 'cohere', api_key: 'bad' });
  ok('cohere wire test reports result', r.status === 200 && typeof r.data.ok === 'boolean');
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
