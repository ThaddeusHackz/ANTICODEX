// Desktop parity tests — the .exe is a second product, and every fix that only
// lives in the web path is a fix the packaged app never got. This suite pins the
// things that make the desktop copy actually equal to the website: the same
// bridge in-process (so live model ids, verify-on-save and the retry apply),
// keys that are encrypted where the OS allows it and honestly reported where it
// does not, gateways on the machine's own network, and a version number that the
// updater can compare with a real GitHub Release.
//
// Run: node tests/test-desktop.mjs

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createKeychain } from '../desktop/keychain.mjs';
import { createUpdater } from '../desktop/updater.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const DESKTOP_PKG = JSON.parse(read('desktop/package.json'));

// ---------------------------------------------------------------------------
// A fake OpenAI-compatible gateway on loopback: the address a desktop user's
// Ollama / LM Studio / vLLM box would have, and the only kind of upstream this
// sandbox can reach.
// ---------------------------------------------------------------------------
const LIVE = ['mock/desktop-live', 'mock/desktop-big'];
const hits = [];
const UPSTREAM = await new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not json */ }
      hits.push({ url: req.url, auth: req.headers.authorization || '', body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/models')) return res.end(JSON.stringify({ object: 'list', data: LIVE.map((id) => ({ id })) }));
      if (!LIVE.includes(String(body.model || ''))) {
        return res.end(JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist or you are not allowed to access it` } }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `gateway answered with ${body.model}` } }], model: body.model, usage: { total_tokens: 4 } }));
    });
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const UP = `http://127.0.0.1:${UPSTREAM.address().port}/v1`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

const LOCAL_TOKEN = 'a'.repeat(48);
async function bootServer({ local }) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `acx-desktop-${local ? 'local' : 'pub'}-`));
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', ANTICODEX_DATA: data,
    // exactly what main.mjs does for the in-process bridge — and nothing else
    // ever sets it
    ...(local ? { ANTICODEX_LOCAL_TOKEN: LOCAL_TOKEN } : {})
  };
  if (!local) delete env.ANTICODEX_LOCAL_TOKEN;
  const proc = spawn('node', ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'health' }) }); up = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert(up, `test server (${local ? 'local' : 'public'}) did not start`);
  return { proc, base, data };
}

async function call(base, action, payload = {}, headers = {}) {
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...payload })
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const DESKTOP_DEF = {
  id: 'custom_desktop', name: 'Ollama (this machine)', type: 'openai',
  endpoint: UP, key_env: 'CUSTOM_DESKTOP_API_KEY',
  // A key inside a gateway row is never honoured — only the key_env name is, and
  // the value comes from the account / the machine's own keychain.
  api_key: 'LEAKED-FROM-PAYLOAD',
  default_model: 'mock/stale-catalog', models: [{ id: 'mock/stale-catalog', label: 'Stale Guess' }]
};
const LOCAL_HDR = { 'x-anticodex-local': LOCAL_TOKEN };

// ===========================================================================
console.log('— the sources the .exe is built from —');
for (const f of ['desktop/main.mjs', 'desktop/preload.mjs', 'desktop/updater.mjs', 'desktop/keychain.mjs', 'desktop/computer-use.mjs', 'desktop/package-win.mjs']) {
  let parses = true;
  try { execFileSync(process.execPath, ['--check', f], { cwd: ROOT }); } catch { parses = false; }
  ok(`${f} parses`, parses);
}
ok('desktop main loads the same bridge the website runs', /api\/bridge\.js|'bridge\.js'/.test(read('desktop/main.mjs')) && read('desktop/main.mjs').includes('BRIDGE_CANDIDATES'));
{
  const main = read('desktop/main.mjs');
  const at = main.indexOf('ANTICODEX_LOCAL_TOKEN');
  ok('the local trust secret is minted before the bridge is imported', at > 0 && at < main.indexOf("await import(pathToFileURL(bridgePath))"));
  ok('and it is random per install, never a constant', /crypto\.randomBytes\(24\)\.toString\('hex'\)/.test(main));
}
{
  const main = read('desktop/main.mjs');
  const proxy = main.slice(main.indexOf("ipcMain.handle('acx:api'"), main.indexOf("ipcMain.handle('acx:computer'"));
  ok('every desktop request carries this machine’s keys', /provider_keys:\s*getKeychain\(\)\.load\(\)\.keys/.test(proxy));
  ok('…and its own gateway list', /provider_defs\s*=\s*state\.customProviders/.test(proxy));
  ok('…and the local token only to the in-process server', /base === apiBase.*x-anticodex-local/s.test(proxy.replace(/\n\s*/g, ' ')));
  ok('a non-JSON bridge answer becomes a readable error, not a crash', /bridge answered HTTP/.test(proxy));
}
{
  const preload = read('desktop/preload.mjs');
  const main = read('desktop/main.mjs');
  const wanted = [...preload.matchAll(/invoke\('(acx:[A-Za-z:_-]+)'/g)].map((m) => m[1]);
  const offered = new Set([...main.matchAll(/ipcMain\.handle\('(acx:[A-Za-z:_-]+)'/g)].map((m) => m[1]));
  const missing = wanted.filter((c) => !offered.has(c));
  ok(`every channel the UI invokes is handled (${wanted.length} checked)`, missing.length === 0, `missing: ${missing.join(', ')}`);
  ok('the app version reaches the UI without reading from disk', /additionalArguments/.test(main) && /--anticodex-version=\$\{VERSION\}/.test(main) && /flag\('version'/.test(preload));
  ok('so does whether the keychain is really encrypted', /--anticodex-keychain=/.test(main) && /flag\('keychain'/.test(preload));
}
{
  const packager = read('desktop/package-win.mjs');
  ok('the packager ships the bridge with the .exe', /--extra-resource=.*'api'/.test(packager));
  ok('…and the provider catalog / key registry', /--extra-resource=.*'lib'/.test(packager));
  ok('…and a freshly built web bundle', /npm', \['run', 'build'\]/.test(packager) && /'web', 'dist'/.test(packager));
  ok('the version comes from package.json, not a literal in the script', /--app-version=\$\{appVersion\}/.test(packager) && !/0\.1\.\d/.test(packager));
}
{
  const main = read('desktop/main.mjs');
  const updater = read('desktop/updater.mjs');
  const preload = read('desktop/preload.mjs');
  ok('no source hardcodes its own version number', !/['"]0\.1\.\d['"]/.test(main) && !/['"]0\.1\.\d['"]/.test(updater) && !/['"]0\.1\.\d['"]/.test(preload));
  ok('the version the app reports matches the packaged app', new RegExp(`"version":\\s*"${DESKTOP_PKG.version}"`).test(read('desktop/package.json')));
  ok('and matches what the website shows as its build', read('lib/keys.js').includes(`export const VERSION = '${DESKTOP_PKG.version}';`));
  const yml = read('.github/workflows/release.yml');
  ok('the release workflow does not pin a version in the asset name', !/ANTICODEX-0\.1\.\d/.test(yml));
  ok('this suite runs in CI', /test-desktop\.mjs/.test(yml) && /test-desktop\.mjs/.test(read('package.json')));
}

// ===========================================================================
console.log('— the updater can only help if the version moved —');
{
  const realFetch = globalThis.fetch;
  const release = (tag) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: tag, body: 'notes', published_at: '2026-10-19T00:00:00Z', assets: [{ name: 'ANTICODEX.zip', size: 10, browser_download_url: 'https://example.invalid/a.zip' }] }) }); };
  try {
    release(`v${DESKTOP_PKG.version}`);
    const same = await createUpdater(DESKTOP_PKG.version).check();
    ok('the installed build is not offered an update to itself', same.ok === true && same.available === false, JSON.stringify(same));
    release(`v${DESKTOP_PKG.version}`);
    const older = await createUpdater('0.0.1').check();
    ok('an older install IS offered this release (that is how it gets the fixes)', older.available === true && older.version === DESKTOP_PKG.version, JSON.stringify(older));
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const gone = await createUpdater(DESKTOP_PKG.version).check();
    ok('a missing release feed is reported, not thrown', gone.ok === false && /release feed/.test(gone.error), JSON.stringify(gone));
  } finally { globalThis.fetch = realFetch; }
}

// ===========================================================================
console.log('— keys on this machine are protected where the OS allows it —');
{
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  };
  let file = {};
  const state = () => file;
  const write = (patch) => { file = { ...file, ...patch }; };

  let kc = createKeychain({ safeStorage: fakeSafe, readState: state, writeState: write });
  const r = kc.save({ NVIDIA_API_KEY: 'nvapi-secret-1234', lowercase_ok: 'ignored', A: 'too short', EMPTY_KEY: '  ' });
  ok('a save reports what it stored', r.ok === true && r.encrypted === true && r.saved.join(',') === 'NVIDIA_API_KEY', JSON.stringify(r));
  ok('the value on disk is not the value you typed', !JSON.stringify(file).includes('nvapi-secret-1234'), JSON.stringify(file));
  ok('…but reading it back gives you exactly that key', kc.load().keys.NVIDIA_API_KEY === 'nvapi-secret-1234');
  ok('anything that is not an env name never reaches disk', !JSON.stringify(file).includes('ignored') && !JSON.stringify(file).includes('too short'));

  // the older layout: plaintext map, no ciphertext field
  file = { providerKeys: { OPENAI_API_KEY: 'sk-old-plaintext' }, theme: 'dark' };
  const log = [];
  kc = createKeychain({ safeStorage: fakeSafe, readState: state, writeState: write, log: (m) => log.push(m) });
  const migrated = kc.load();
  ok('an existing plaintext keychain is read, then upgraded', migrated.keys.OPENAI_API_KEY === 'sk-old-plaintext' && migrated.migrated === true, JSON.stringify(migrated));
  ok('and the plaintext copy is gone afterwards', file.providerKeys === null && !JSON.stringify(file).includes('sk-old-plaintext'), JSON.stringify(file));
  ok('unrelated app state survives the migration', file.theme === 'dark');

  // a DPAPI blob belongs to one Windows user; a copied profile cannot read it
  file = { providerKeysEnc: 'not-a-real-ciphertext' };
  kc = createKeychain({
    safeStorage: { ...fakeSafe, decryptString: () => { throw new Error('Unable to decrypt'); } },
    readState: state, writeState: write, log: (m) => log.push(m)
  });
  const broken = kc.load();
  ok('an unreadable blob comes back empty instead of as a corrupt key', broken.keys && Object.keys(broken.keys).length === 0, JSON.stringify(broken));
  ok('and the reason is written to the app log', log.some((m) => /keychain unreadable/i.test(m)), log.join('|'));

  // no OS keyring (Linux without libsecret): say so, do not pretend
  file = {};
  kc = createKeychain({ safeStorage: { isEncryptionAvailable: () => false }, readState: state, writeState: write });
  const plain = kc.save({ NVIDIA_API_KEY: 'nvapi-visible' });
  ok('without secure storage the keys still work', plain.ok === true && kc.load().keys.NVIDIA_API_KEY === 'nvapi-visible');
  ok('…and the app records that they are NOT encrypted', plain.encrypted === false && kc.status().backend === 'plaintext-file' && kc.status().encrypted === false, JSON.stringify(kc.status()));

  file = { providerKeysEnc: 'x' };
  kc = createKeychain({ safeStorage: fakeSafe, readState: state, writeState: write });
  kc.setOne('GROQ_API_KEY', 'gsk_1');
  ok('one key can be set without touching the others', kc.load().keys.GROQ_API_KEY === 'gsk_1');
  kc.remove('GROQ_API_KEY');
  ok('and removed again', !('GROQ_API_KEY' in kc.load().keys));
}

// ===========================================================================
const local = await bootServer({ local: true });
const pub = await bootServer({ local: false });
try {
  console.log('— an offline desktop still proves the key it just saved —');
  {
    const r = await call(local.base, 'test_endpoint', { provider: 'custom_desktop', provider_defs: [DESKTOP_DEF] }, LOCAL_HDR);
    ok('test_endpoint answers with no web session at all', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 200));
    ok('…and says which model replied', typeof r.data.model === 'string' && LIVE.includes(r.data.model), JSON.stringify(r.data).slice(0, 200));
    ok('the key from the payload never reaches the wire', !/LEAKED/.test(String(hits.at(-1)?.auth || '')), JSON.stringify(hits.at(-1)?.auth));
    ok('and no "Bearer undefined" is sent to an open gateway', !/undefined/.test(String(hits.at(-1)?.auth || '')), JSON.stringify(hits.at(-1)?.auth));
    const noHdr = await call(local.base, 'test_endpoint', { provider: 'custom_desktop', provider_defs: [DESKTOP_DEF] });
    ok('without the local token the gate is still closed', noHdr.status === 401, JSON.stringify(noHdr.data).slice(0, 120));
    const spoof = await call(local.base, 'test_endpoint', { provider: 'custom_desktop', provider_defs: [DESKTOP_DEF] }, { ...LOCAL_HDR, 'x-forwarded-for': '203.0.113.7' });
    ok('a proxied request cannot claim to be the machine itself', spoof.status === 401, JSON.stringify(spoof.data).slice(0, 120));
    const wrong = await call(local.base, 'test_endpoint', { provider: 'custom_desktop' }, { 'x-anticodex-local': 'guess'.repeat(4) });
    ok('a guessed token is refused', wrong.status === 401);

    const sync = await call(local.base, 'sync_models', { provider: 'custom_desktop', provider_defs: [DESKTOP_DEF] }, LOCAL_HDR);
    ok('a gateway on this machine can be synced while signed out', sync.data.ok === true && sync.data.models.some((m) => m.id === 'mock/desktop-live'), JSON.stringify(sync.data).slice(0, 200));

    const chat = await call(local.base, 'chat', {
      provider: 'custom_desktop', model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      provider_defs: [DESKTOP_DEF], provider_keys: { CUSTOM_DESKTOP_API_KEY: 'desktop-key' }
    }, LOCAL_HDR);
    ok('chat reaches the user’s own gateway', chat.data.model && String(chat.data.content || chat.data.text).includes('gateway answered with'), JSON.stringify(chat.data).slice(0, 200));
    const last = hits.at(-1);
    ok('with the key from the device store, not the key in the gateway row', last?.auth === 'Bearer desktop-key', JSON.stringify(last?.auth));
    ok('and a live model id, never the word “default”', LIVE.includes(String(last?.body?.model)), JSON.stringify(last?.body?.model));
    ok('a stale catalog id was replaced by one that exists', chat.data.retried_with || LIVE.includes(String(last?.body?.model)), JSON.stringify(chat.data).slice(0, 160));

    const cfg = await call(local.base, 'config', {
      provider_defs: [DESKTOP_DEF], provider_keys: { CUSTOM_DESKTOP_API_KEY: 'desktop-key' }
    }, LOCAL_HDR);
    const row = (cfg.data.providers || []).find((p) => p.id === 'custom_desktop');
    ok('the device gateway shows up as configured on this machine', Boolean(row) && row.configured === true, JSON.stringify(row).slice(0, 200));
    ok('with the ids the endpoint really listed', row?.models?.some((m) => m.id === 'mock/desktop-live' && m.live === true), JSON.stringify(row?.models).slice(0, 200));
    ok('and the row is marked verified', row?.verified === true, JSON.stringify(row).slice(0, 200));
    const pickerRow = (await call(local.base, 'models', {
      provider_defs: [DESKTOP_DEF], provider_keys: { CUSTOM_DESKTOP_API_KEY: 'desktop-key' }
    }, LOCAL_HDR)).data.picker?.providers?.find((p) => p.id === 'custom_desktop');
    ok('the top-bar picker lists this machine’s gateway too', pickerRow?.verified === true && pickerRow.models.some((m) => m.live === true), JSON.stringify(pickerRow).slice(0, 240));
    const keyless = await call(local.base, 'config', {
      provider_defs: [{ ...DESKTOP_DEF, key_env: undefined, api_key: 'LEAKED-FROM-PAYLOAD' }]
    }, LOCAL_HDR);
    ok('a keyless local gateway is still usable, not called unconfigured', (keyless.data.providers || []).find((p) => p.id === 'custom_desktop')?.models?.length > 0, JSON.stringify(keyless.data.providers?.find((p) => p.id === 'custom_desktop')).slice(0, 220));
    ok('config states that private gateways are allowed here', cfg.data.local_gateway_allowed === true, JSON.stringify(cfg.data.local_gateway_allowed));
    ok('nothing had to be dropped, so no warning is shown', cfg.data.provider_defs_note === undefined);
    ok('the desktop build reports its version', cfg.data.version === DESKTOP_PKG.version, JSON.stringify(cfg.data.version));
  }

  console.log('— the same server without that trust —');
  {
    const r = await call(pub.base, 'test_endpoint', { endpoint: UP, api_key: 'x' });
    ok('a public instance will not dial a loopback address', r.status === 401 || r.status === 403, JSON.stringify(r.data).slice(0, 140));
    const cfg = await call(pub.base, 'config', { provider_defs: [DESKTOP_DEF] });
    ok('and will not show a private gateway as usable', !(cfg.data.providers || []).some((p) => p.id === 'custom_desktop'));
    ok('it says so in one line the UI can print', /desktop/i.test(cfg.data.provider_defs_note || ''), JSON.stringify(cfg.data.provider_defs_note));
    ok('local_gateway_allowed is false for a browser', cfg.data.local_gateway_allowed === false);
    const chat = await call(pub.base, 'chat', { provider: 'custom_desktop', model: 'x', messages: [{ role: 'user', content: 'hi' }], provider_defs: [DESKTOP_DEF] });
    ok('and it refuses that chat rather than answering from another model', chat.data.ok === false && chat.data.verdict === 'blocked' && !/Demo Core/.test(chat.data.text || ''), JSON.stringify(chat.data).slice(0, 160));
  }

  console.log('— the web UI still matches the packaged one —');
  {
    const settings = read('web/src/pages/Settings.jsx');
    ok('Settings reads the gateway list from the app, not only localStorage', /desktop\?\.getCustoms/.test(settings));
    ok('one write path keeps both copies in step', /function writeCustoms/.test(settings) && /desktop\.saveCustoms/.test(settings));
    ok('a key typed into the gateway form is stored, not embedded in the row', !/acx_custom_providers',\s*JSON\.stringify\(\[\.\.\.customs,\s*\{\s*id:.*\.\.\.v\s*\}\]\)/.test(settings) && /storeKey\(key_env, v\.api_key\)/.test(settings));
    ok('custom gateways get the same card as every provider', /customs\.map[\s\S]{0,1800}<ProviderCard/.test(settings));
    ok('…including Sync, whose result decides whether it looks ready', /const live = providers\.find\(\(p\) => p\.id === c\.id\)/.test(settings));
    ok('the desktop tab tells the truth about the keychain', /encrypted \? 'encrypted' : 'plaintext'/.test(settings));
    ok('the default model is the real picker, not a stale <select>', !/Default model[\s\S]{0,200}<select/.test(settings) && /<ModelPicker \/>/.test(settings));
    const client = read('web/src/lib/api.js');
    ok('the browser sends its own gateways on the actions that need them', /GATEWAY_ACTIONS[\s\S]{0,400}provider_defs/.test(client));
  }
} finally {
  local.proc.kill('SIGTERM');
  pub.proc.kill('SIGTERM');
  UPSTREAM.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
