import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executableAllowed,
  filterStatePatch,
  isTrustedFrameUrl,
  isTrustedSender,
  navigationAllowed,
  parseUpdateDigest,
  updateUrlAllowed,
  validateComputerArgs,
  validatedAppUrl
} from '../desktop/security.mjs';
import { createUpdater } from '../desktop/updater.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const test = async (name, run) => {
  try { await run(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name} — ${error.stack || error}`); process.exitCode = 1; }
};

console.log('— desktop sender and navigation policy —');
await test('trusted senders are top-level local app frames or file URLs only', () => {
  assert.equal(isTrustedFrameUrl('http://127.0.0.1:4567/', 'http://127.0.0.1:4567/'), true);
  assert.equal(isTrustedFrameUrl('https://evil.example/', 'http://127.0.0.1:4567/'), false);
  assert.equal(isTrustedFrameUrl('file:///app/index.html', null), true);
  assert.equal(isTrustedSender({ senderFrame: { url: 'http://127.0.0.1:4567/', parent: null } }, 'http://127.0.0.1:4567/'), true);
  assert.equal(isTrustedSender({ senderFrame: { url: 'http://127.0.0.1:4567/', parent: {} } }, 'http://127.0.0.1:4567/'), false);
});
await test('navigation stays on configured origins', () => {
  const policy = { appOrigin: 'http://127.0.0.1:4567/', startUrl: 'https://app.example/' };
  assert.equal(navigationAllowed('http://127.0.0.1:4567/settings', policy), true);
  assert.equal(navigationAllowed('https://app.example/login', policy), true);
  assert.equal(navigationAllowed('https://evil.example/', policy), false);
});
await test('read-only desktop URLs accept HTTPS or loopback only', () => {
  assert.ok(validatedAppUrl('https://app.example'));
  assert.ok(validatedAppUrl('http://localhost:8787'));
  assert.equal(validatedAppUrl('http://evil.example'), null);
  assert.equal(validatedAppUrl('javascript:alert(1)'), null);
});

console.log('— desktop state and computer validation —');
await test('renderer state allowlist drops identities, keys, and URLs', () => {
  const filtered = filterStatePatch({ theme: 'dark', sidebar: true, desktopToken: 'secret', user: { id: 1 }, providerKeysEnc: 'secret', apiBase: 'https://evil', startUrl: 'https://evil' });
  assert.deepEqual(filtered, { theme: 'dark', sidebar: true });
});
await test('coordinates, buttons, counts, text, keys, and launch paths validate', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(validateComputerArgs('click', { x: 10, y: 20, button: 'right', count: 2 }, bounds), { x: 10, y: 20, button: 'right', count: 2 });
  assert.throws(() => validateComputerArgs('click', { x: 100, y: 0, count: 1 }, bounds), /range/);
  assert.throws(() => validateComputerArgs('type', { text: 'x'.repeat(10001) }, bounds), /10000/);
  assert.throws(() => validateComputerArgs('key', { combo: "ctrl+'" }, bounds), /invalid/);
  assert.throws(() => validateComputerArgs('launch', { target: 'relative.exe', args: [] }, bounds), /absolute/);
});
await test('executable allowlist accepts exact absolute paths or basenames', () => {
  const target = path.resolve('/opt/tools/safe-tool');
  assert.equal(executableAllowed(target, [target]), true);
  assert.equal(executableAllowed(target, ['safe-tool']), true);
  assert.equal(executableAllowed(target, ['other-tool']), false);
});

console.log('— verified updater metadata —');
await test('digest parser accepts GitHub digest and SHA256SUMS formats', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseUpdateDigest(`sha256:${hash}`, 'app.zip'), hash);
  assert.equal(parseUpdateDigest(null, 'app.zip', `${hash} *app.zip\n`), hash);
  assert.equal(parseUpdateDigest(null, 'other.zip', `${hash} *app.zip\n`), null);
});
await test('update assets allow only required HTTPS hosts', () => {
  assert.equal(updateUrlAllowed('https://github.com/o/r/releases/download/v/a.zip'), true);
  assert.equal(updateUrlAllowed('https://objects.githubusercontent.com/a.zip'), true);
  assert.equal(updateUrlAllowed('https://release-assets.githubusercontent.com/a.zip'), true);
  assert.equal(updateUrlAllowed('https://evil.example/a.zip'), false);
  assert.equal(updateUrlAllowed('http://github.com/a.zip'), false);
});
await test('updater verifies digest and size before accepting a ZIP', async () => {
  const bytes = Buffer.from('verified update');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const metadata = {
    tag_name: 'v9.0.0', body: '', published_at: '2026-10-25T00:00:00Z',
    assets: [{ name: 'ANTICODEX.zip', size: bytes.length, digest: `sha256:${digest}`, browser_download_url: 'https://github.com/o/r/releases/download/v9/ANTICODEX.zip' }]
  };
  const fetch = async (url) => url.includes('api.github.com')
    ? new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const updater = createUpdater('1.0.0', { fetch, platform: 'linux' });
  assert.equal((await updater.check()).available, true);
  const result = await updater.downloadAndInstall();
  assert.equal(result.ok, true);
  assert.equal(result.version, '9.0.0');
});
await test('updater refuses a digest mismatch', async () => {
  const bytes = Buffer.from('tampered');
  const metadata = {
    tag_name: 'v9.0.0', assets: [{ name: 'ANTICODEX.zip', size: bytes.length, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: 'https://github.com/o/r/releases/download/v9/ANTICODEX.zip' }]
  };
  const fetch = async (url) => url.includes('api.github.com')
    ? new Response(JSON.stringify(metadata), { status: 200 })
    : new Response(bytes, { status: 200 });
  const updater = createUpdater('1.0.0', { fetch, platform: 'linux' });
  await updater.check();
  assert.match((await updater.downloadAndInstall()).error, /SHA-256/);
});

console.log('— source wiring —');
await test('every IPC endpoint uses the trusted wrapper', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.mjs'), 'utf8');
  const direct = [...main.matchAll(/ipcMain\.handle\(/g)];
  assert.equal(direct.length, 1);
  assert.match(main, /function handleIpc[\s\S]*isTrustedSender/);
  for (const channel of ['acx:api', 'acx:computer', 'acx:state', 'acx:config', 'acx:update:download']) assert.match(main, new RegExp(`handleIpc\\('${channel.replace(/:/g, ':')}'`));
});
await test('PowerShell is encoded and renderer confirmation is not trusted', () => {
  const computer = fs.readFileSync(path.join(ROOT, 'desktop/computer-use.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.mjs'), 'utf8');
  assert.match(computer, /-EncodedCommand/);
  assert.doesNotMatch(computer, /Start-Process/);
  assert.doesNotMatch(main, /args\.confirmed/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /ANTICODEX_ALLOW_SHELL/);
});

console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
