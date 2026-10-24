// ANTICODEX Desktop — Electron main process.
// Features: bundled web UI, computer-use bridge, auto-update with accept flow,
// desktop↔website account pairing, deep links (anticodex://).

import { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, screen, globalShortcut, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createComputerUse } from './computer-use.mjs';
import { createUpdater } from './updater.mjs';
import { createKeychain } from './keychain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One source of truth for the version: the packager stamps this same string into
// the .exe and the zip name, and the updater compares it with the latest GitHub
// Release tag — so getting fixes onto installed desktops is this number.
function readAppVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}
const VERSION = readAppVersion();
// Works both from the repo (../web/dist) and packaged (extra-resource dist).
const RES_ROOT = process.resourcesPath || path.join(__dirname, '..');
const WEB_DIST_CANDIDATES = [
  path.join(__dirname, '..', 'web', 'dist'),
  path.join(__dirname, '..', 'dist'),
  path.join(RES_ROOT, 'dist')
];
const WEB_DIST = WEB_DIST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'index.html'))) || WEB_DIST_CANDIDATES[0];
const BRIDGE_CANDIDATES = [
  path.join(__dirname, '..', 'api', 'bridge.js'),
  path.join(RES_ROOT, 'api', 'bridge.js')
];
const STATE_FILE = path.join(app.getPath('userData'), 'anticodex-state.json');

// A `.skill` is a ZIP holding `<name>/SKILL.md` — the packaged form both shipped
// desktop assistants exchange. The installer is the registry's own, so the app
// and the bridge cannot disagree about what a valid archive is.
async function installSkillArchive() {
  const { extractSkillArchive, readSkillArchive } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'skills.js')).href);
  const parent = win && !win.isDestroyed() ? win : null;
  const dialogOpts = {
    title: 'Install a skill',
    properties: ['openFile'],
    filters: [{ name: 'Skill archive', extensions: ['skill', 'zip'] }]
  };
  const picked = parent ? await dialog.showOpenDialog(parent, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
  const file = picked.filePaths[0];
  const peek = readSkillArchive(file, { scope: 'user' });
  // A file that is not a skill is refused before anything is written.
  if (!peek.skills.length) {
    return { ok: false, error: peek.errors[0]?.message || 'that archive does not contain a SKILL.md' };
  }
  const dest = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
  try {
    const result = extractSkillArchive(file, dest);
    return { ok: true, ...result, description: peek.skills[0].description };
  } catch (e) {
    if (e.code === 'Exists') {
      const boxOpts = {
        type: 'question', buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `${peek.skills[0].name} is already installed`,
        detail: 'Replacing it overwrites the copy on this machine.'
      };
      const go = parent ? await dialog.showMessageBox(parent, boxOpts) : await dialog.showMessageBox(boxOpts);
      if (go.response !== 0) return { ok: false, canceled: true };
      const result = extractSkillArchive(file, dest, { overwrite: true });
      return { ok: true, ...result, replaced: true, description: peek.skills[0].description };
    }
    return { ok: false, error: String(e.message || e) };
  }
}

// Runtime data (config.json / db.json) lives in userData so the packaged app is
// writable everywhere.
process.env.ANTICODEX_DATA = process.env.ANTICODEX_DATA || path.join(app.getPath('userData'), 'data');

// --- in-process API + static server (the .exe is self-sufficient) -----------

let apiBase = '';
// A per-install secret that lets *this* app's own UI (bundled, possibly offline,
// possibly signed out) through the gates a public deployment has to keep: testing
// an endpoint, syncing a model list, or pointing a chat at a gateway on the LAN.
// Memory-only, never written to disk, and the bridge honours it only from a
// loopback peer — see isDesktopLocal() in api/bridge.js.
process.env.ANTICODEX_LOCAL_TOKEN = crypto.randomBytes(24).toString('hex');

async function startLocalServer() {
  const bridgePath = BRIDGE_CANDIDATES.find((p) => fs.existsSync(p));
  const http = await import('node:http');
  let bridge = null;
  if (bridgePath) {
    try { bridge = (await import(pathToFileURL(bridgePath))).default; } catch (e) {
      console.error('bridge import failed', e);
    }
  }
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (bridge) return bridge(req, res);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bridge unavailable' }));
    }
    let filePath = path.join(WEB_DIST, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(WEB_DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(WEB_DIST, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:system-ui;background:#0b0d14;color:#e8ebf6;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1>ANTICODEX</h1><p>Web bundle missing — reinstall the app.</p></div></body></html>');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}`;
  return apiBase;
}

let win = null;
const computer = createComputerUse();
const updater = createUpdater(VERSION);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 960, minHeight: 640,
    backgroundColor: '#0b0d14',
    title: 'ANTICODEX',
    icon: fs.existsSync(path.join(__dirname, 'icons', 'icon.png')) ? path.join(__dirname, 'icons', 'icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The renderer may not read package.json or app paths, so what it needs in
      // order to be honest (app version, whether keys are encrypted at rest) is
      // passed as launch arguments instead of through an extra IPC round-trip.
      additionalArguments: [
        `--anticodex-version=${VERSION}`,
        `--anticodex-keychain=${getKeychain().status().backend}`
      ]
    }
  });

  const startUrl = loadState().startUrl;
  if (startUrl) win.loadURL(startUrl);
  else if (apiBase) win.loadURL(`${apiBase}/`);
  else if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) win.loadFile(path.join(WEB_DIST, 'index.html'));
  else win.loadURL('https://github.com/ThaddeusHackz/ANTICODEX');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- IPC: bridge visible to the renderer as window.anticodexDesktop ----------

// --- provider keys on this machine -----------------------------------------
// These used to sit in anticodex-state.json as readable JSON. They now go through
// Electron's safeStorage when the OS offers it (DPAPI / Keychain / libsecret), and
// when it does not, the renderer is told so in as many words rather than being
// shown a lock icon.
let keychain = null;
function getKeychain() {
  if (!keychain) {
    keychain = createKeychain({
      safeStorage,
      readState: () => loadState(),
      writeState: (patch) => saveState(patch),
      log: (m) => console.warn('[keychain]', m)
    });
  }
  return keychain;
}

ipcMain.handle('acx:saveKeys', (_e, keys) => {
  const kc = getKeychain();
  const out = kc.save({ ...kc.load().keys, ...(keys || {}) });
  return { ...out, backend: kc.status().backend };
});

ipcMain.handle('acx:getKeys', () => getKeychain().load().keys);

ipcMain.handle('acx:keychainStatus', () => getKeychain().status());

// Custom gateways (Ollama, LM Studio, a LAN vLLM box) belong to this machine, so
// the main process keeps the list and attaches it to every request it makes. The
// website has no reason to know they exist, and a public server must not be made
// to dial them — the bridge only honours private addresses for a local instance.
ipcMain.handle('acx:saveCustoms', (_e, list) => {
  const next = Array.isArray(list) ? list.slice(0, 40) : [];
  saveState({ customProviders: next });
  return { ok: true, count: next.length };
});

ipcMain.handle('acx:getCustoms', () => {
  const list = loadState().customProviders;
  return Array.isArray(list) ? list : [];
});

ipcMain.handle('acx:skillInstall', async () => {
  try { return await installSkillArchive(); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

ipcMain.handle('acx:api', async (_e, action, payload) => {
  // Provider calls run in the main process — no CORS, keys stay local.
  const state = loadState();
  const base = state.apiBase || apiBase || 'http://127.0.0.1:8787';
  const headers = { 'Content-Type': 'application/json' };
  // Carry the signed-in session through the proxy hop so /me, threads and
  // per-user keys authenticate exactly like they do in the browser.
  if (state.desktopToken) headers.Authorization = `Bearer ${state.desktopToken}`;
  // The in-process server is the only peer that gets the local token.
  if (apiBase && base === apiBase) headers['x-anticodex-local'] = process.env.ANTICODEX_LOCAL_TOKEN || '';
  const body = {
    action,
    ...payload,
    token: payload?.token || state.desktopToken || undefined,
    provider_keys: getKeychain().load().keys,
    _desktop: true
  };
  if (Array.isArray(state.customProviders) && state.customProviders.length) body.provider_defs = state.customProviders;
  const res = await fetch(`${base}/api/bridge`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: `bridge answered HTTP ${res.status}: ${text.slice(0, 200)}` }; }
});

// --- streamed chat -----------------------------------------------------------
// The renderer cannot call /api/bridge itself for a streamed answer: it would
// arrive without this machine's keychain keys and without the local token that
// lets a loopback request reach a LAN gateway. So the main process makes the
// request exactly like `acx:api` does and forwards the events as they arrive.
//
// Events go to the window that asked, tagged with an id, so two streams (or a
// stream and a stale one) can never interleave.
const streamControllers = new Map();

ipcMain.handle('acx:api:stream', async (event, action, payload, streamId) => {
  const state = loadState();
  const base = state.apiBase || apiBase || 'http://127.0.0.1:8787';
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (state.desktopToken) headers.Authorization = `Bearer ${state.desktopToken}`;
  if (apiBase && base === apiBase) headers['x-anticodex-local'] = process.env.ANTICODEX_LOCAL_TOKEN || '';
  const body = {
    action,
    ...payload,
    token: payload?.token || state.desktopToken || undefined,
    provider_keys: getKeychain().load().keys,
    _desktop: true
  };
  if (Array.isArray(state.customProviders) && state.customProviders.length) body.provider_defs = state.customProviders;

  const controller = new AbortController();
  streamControllers.set(streamId, controller);
  const send = (evt) => {
    try { if (!event.sender.isDestroyed()) event.sender.send('acx:stream:event', { streamId, evt }); } catch { /* window gone */ }
  };
  try {
    const res = await fetch(`${base}/api/bridge`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
    });
    if (!res.ok || !String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { ok: false, error: `bridge answered HTTP ${res.status}: ${text.slice(0, 200)}` }; }
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.type === 'delta') text += evt.text || '';
        send(evt);
        if (evt.type === 'done' || evt.type === 'error' || evt.type === 'aborted') final = evt;
      }
    }
    if (final?.type === 'error') return { ok: false, ...final };
    return { ok: true, text, content: text, model: final?.model, first_token_ms: final?.first_token_ms, elapsed_ms: final?.elapsed_ms, aborted: final?.type === 'aborted' };
  } catch (e) {
    if (controller.signal.aborted) return { ok: true, aborted: true, text: '' };
    return { ok: false, error: String(e?.message || e) };
  } finally {
    streamControllers.delete(streamId);
  }
});

ipcMain.handle('acx:api:stream:abort', (_e, streamId) => {
  const c = streamControllers.get(streamId);
  if (!c) return { ok: false };
  c.abort();
  streamControllers.delete(streamId);
  return { ok: true };
});

// Why the desktop can run REA: the setup command and the MCP server are local
// processes, and the app is the thing that owns them. This is only a fact the
// UI shows next to the Node version.
ipcMain.handle('acx:reaEnv', () => ({
  node: process.version,
  platform: process.platform,
  canSpawn: true,
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}));

ipcMain.handle('acx:computer', async (_e, cmd, args) => {
  switch (cmd) {
    case 'screenshot': {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } });
      const img = sources[0]?.thumbnail?.toDataURL();
      return { image: img, width: 1600, height: 900 };
    }
    case 'move': return computer.moveMouse(args.x, args.y);
    case 'click': return computer.click(args.x, args.y, args.button || 'left', args.count || 1);
    case 'type': return computer.type(args.text || '');
    case 'key': return computer.key(args.combo || '');
    case 'windows': return computer.listWindows();
    case 'launch': {
      const okToRun = args.confirmed === true;
      if (!okToRun) return { needsConfirmation: true, action: 'launch', target: args.target };
      return computer.launch(args.target, args.args || []);
    }
    case 'shell': {
      if (args.confirmed !== true) return { needsConfirmation: true, action: 'shell', command: args.command };
      return computer.shell(args.command);
    }
    default: return { error: `unknown computer command: ${cmd}` };
  }
});

ipcMain.handle('acx:state', (_e, patch) => {
  const next = (patch ? saveState(patch) : loadState()) || {};
  // Key material never travels on the generic state channel: the renderer reads it
  // through acx:getKeys, which is where encryption is actually applied.
  const { providerKeys, providerKeysEnc, ...rest } = next;
  return { ...rest, keychain: getKeychain().status() };
});

// --- GitHub sign-in / account linking --------------------------------------
// The desktop opens the SYSTEM browser at the website's GitHub login with a
// pairing code; when the user finishes signing in there, the site claims the
// code and the desktop picks up the linked account automatically.
const SITE = process.env.ANTICODEX_SITE || 'https://anticodex.vercel.app';

async function siteBridge(body) {
  const res = await fetch(`${SITE}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  return res.json();
}

async function localBridge(body) {
  const base = loadState().apiBase || apiBase;
  if (!base) return null;
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  return res.json();
}

/**
 * Read a pairing code from whichever ledger actually owns it.
 *
 * `acx:githubLogin` mints the code with `siteBridge` (the website), so the row
 * lives in the site's ledger. Polling the *local* bridge first meant a user who
 * was already signed in on the website claimed the code remotely while this
 * process watched a local table that never saw the claim — the app "opened the
 * browser and never logged in". Website first, this machine second.
 */
async function pairStatus(code) {
  let lastError = null;
  for (const attempt of [
    () => siteBridge({ action: 'pair', op: 'status', code }),
    () => localBridge({ action: 'pair', op: 'status', code })
  ]) {
    try {
      const s = await attempt();
      if (s && !s.error) return s;
      if (s?.error) lastError = s.error;
    } catch (e) { lastError = lastError || String(e.message || e); }
  }
  return { ok: false, error: lastError || 'pairing unavailable' };
}

/** Same provenance rule for claiming: the website minted it, the website claims it. */
async function pairClaim(code, extra = {}) {
  let lastError = null;
  for (const attempt of [
    () => siteBridge({ action: 'pair', op: 'claim', code, ...extra }),
    () => localBridge({ action: 'pair', op: 'claim', code, ...extra })
  ]) {
    try {
      const s = await attempt();
      if (s?.ok) return s;
      if (s?.error) lastError = s.error;
    } catch (e) { lastError = lastError || String(e.message || e); }
  }
  return { ok: false, error: lastError || 'pairing unavailable' };
}

ipcMain.handle('acx:githubLogin', async () => {
  // Preferred: sign in on the website, which claims a pairing code and hands
  // this install the session (plus the shared provider keys).
  let code = null;
  let online = true;
  try {
    const data = await siteBridge({ action: 'pair', op: 'create' });
    code = data?.code || null;
  } catch { online = false; }

  if (code) {
    let url = `${SITE}/login?desktop=${code}&provider=github`;
    try {
      // Ask the site where GitHub sign-in points, so a half-configured server
      // does not open a browser tab that dead-ends.
      const gh = await siteBridge({ action: 'github_login', redirect_to: `${SITE}/`, pair_code: code });
      if (gh?.url) {
        await shell.openExternal(gh.url);
        return { ok: true, code, url: gh.url, mode: 'site-oauth' };
      }
      if (gh?.needs_setup) {
        await shell.openExternal(url);
        return { ok: true, code, url, mode: 'pairing', notice: gh.error || 'GitHub sign-in is not configured on the website yet — sign in with email there and this app links automatically.' };
      }
    } catch { /* fall through to the plain login link */ }
    await shell.openExternal(url);
    return { ok: true, code, url, mode: 'pairing' };
  }

  // Offline / no website: link whatever session this install already has, or
  // send the user to the local sign-in screen.
  const state = loadState();
  if (state.desktopToken && state.user) return { ok: true, signedIn: true, user: state.user };
  const local = `${apiBase || 'http://127.0.0.1:8787'}/login?desktop=local`;
  if (online) { await shell.openExternal(local).catch(() => {}); }
  return {
    ok: false, offline: true, url: local,
    error: 'ANTICODEX could not reach the website to link a GitHub account. Sign in on this machine instead — your email and password work here too.',
    local_login: local
  };
});

ipcMain.handle('acx:pairWait', async (_e, code) => {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const s = await pairStatus(code);
      if (s?.claimed) {
        saveState({ desktopToken: s.token, user: s.user, pairedAt: new Date().toISOString() });
        // Teach this install's own bridge about the linked session, otherwise
        // /me and /threads would 401 against the local copy of the ledger.
        try { await localBridge({ action: 'pair', op: 'adopt', token: s.token, user: s.user }); } catch { /* non-fatal */ }
        // Bring the account's keys (NVIDIA, Tavily, Flux, MiniMax, ElevenLabs,
        // Whisper, …) across so the desktop works exactly like the website. They
        // land in this install's own keychain — which every provider call in this
        // app resolves *first* — instead of being POSTed into the bridge as
        // server-global config (an admin-level write that a paired user must not
        // need, and that silently 401s now that global keys are admin-only).
        const mirrored = s.service_keys ? Object.keys(s.service_keys) : [];
        if (mirrored.length) getKeychain().save({ ...getKeychain().load().keys, ...s.service_keys });
        return {
          ok: true, token: s.token, user: s.user, synced_keys: mirrored.length,
          keys_encrypted: getKeychain().status().encrypted, keychain: getKeychain().status().backend
        };
      }
    } catch { /* network hiccup — keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, error: 'pairing timed out' };
});

ipcMain.handle('acx:pair', async (_e, code) => {
  const data = await pairClaim(code, { user_id: 'desktop' });
  if (data.ok) {
    saveState({ desktopToken: data.token, pairedAt: new Date().toISOString() });
    try { await localBridge({ action: 'pair', op: 'adopt', token: data.token, user: data.user || { email: data.email } }); } catch { /* non-fatal */ }
  }
  return data;
});

ipcMain.handle('acx:update', async () => {
  const info = await updater.check();
  return info;
});

ipcMain.handle('acx:update:download', async () => {
  return updater.downloadAndInstall(() => win);
});

// --- lifecycle --------------------------------------------------------------

// --- deep links -------------------------------------------------------------
// `anticodex://pair?code=123456` is how the website hands a session to this app.
// Windows/Linux deliver it as an argv on a *second* launch, macOS through
// `open-url`, and both can deliver it on a **cold start**, before any window (or
// renderer listener) exists. Queue those instead of dropping them.
const deepLinks = [];
const deepArgv = (argv = process.argv) => argv.find((a) => typeof a === 'string' && a.startsWith('anticodex://')) || null;

function deliverDeepLink(url) {
  if (!url) return;
  if (!win || win.webContents.isLoading()) { deepLinks.push(url); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('acx:deep-link', url);
}

function flushDeepLinks() {
  while (deepLinks.length) {
    const url = deepLinks.shift();
    win?.webContents.send('acx:deep-link', url);
  }
}

// Must be registered before `whenReady` for macOS to route the link here.
app.on('open-url', (e, url) => { e.preventDefault(); deliverDeepLink(url); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const deep = deepArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (deep) win.webContents.send('acx:deep-link', deep);
    } else if (deep) {
      deepLinks.push(deep);
    }
  });

  app.whenReady().then(async () => {
    try { app.setAsDefaultProtocolClient('anticodex'); } catch { /* non-fatal */ }
    await startLocalServer();
    createWindow();
    win?.webContents.on('did-finish-load', flushDeepLinks);
    // Cold start from a link: the argv that launched us, or one macOS queued
    // while the app was booting.
    const cold = deepArgv();
    if (cold) deliverDeepLink(cold);
    // Offer updates once per session after a delay (user must accept).
    setTimeout(async () => {
      try {
        const info = await updater.check();
        if (info.available && win) {
          win.webContents.send('acx:update-available', info);
        }
      } catch { /* offline is fine */ }
    }, 15000);
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      win?.webContents.on('did-finish-load', flushDeepLinks);
    }
  });
}

export { VERSION };
