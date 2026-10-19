// ANTICODEX Desktop — Electron main process.
// Features: bundled web UI, computer-use bridge, auto-update with accept flow,
// desktop↔website account pairing, deep links (anticodex://).

import { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, screen, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createComputerUse } from './computer-use.mjs';
import { createUpdater } from './updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.7';
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

// Runtime data (config.json / db.json) lives in userData so the packaged app is
// writable everywhere.
process.env.ANTICODEX_DATA = process.env.ANTICODEX_DATA || path.join(app.getPath('userData'), 'data');

// --- in-process API + static server (the .exe is self-sufficient) -----------

let apiBase = '';
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
      sandbox: false
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

ipcMain.handle('acx:saveKeys', (_e, keys) => {
  const state = loadState();
  const merged = { ...(state.providerKeys || {}), ...(keys || {}) };
  saveState({ providerKeys: merged });
  return { ok: true, saved: Object.keys(keys || {}) };
});

ipcMain.handle('acx:getKeys', () => loadState().providerKeys || {});

ipcMain.handle('acx:api', async (_e, action, payload) => {
  // Provider calls run in the main process — no CORS, keys stay local.
  const state = loadState();
  const base = state.apiBase || apiBase || 'http://127.0.0.1:8787';
  const headers = { 'Content-Type': 'application/json' };
  // Carry the signed-in session through the proxy hop so /me, threads and
  // per-user keys authenticate exactly like they do in the browser.
  if (state.desktopToken) headers.Authorization = `Bearer ${state.desktopToken}`;
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action, ...payload, token: payload?.token || state.desktopToken || undefined,
      provider_keys: state.providerKeys || {}, _desktop: true
    })
  });
  return res.json();
});

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
  if (patch) return saveState(patch);
  return loadState();
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
      const s = await siteBridge({ action: 'pair', op: 'status', code });
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
        if (mirrored.length) {
          const state = loadState();
          saveState({ providerKeys: { ...(state.providerKeys || {}), ...s.service_keys } });
        }
        return { ok: true, token: s.token, user: s.user, synced_keys: mirrored.length };
      }
    } catch { /* network hiccup — keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, error: 'pairing timed out' };
});

ipcMain.handle('acx:pair', async (_e, code) => {
  const state = loadState();
  const base = state.apiBase || 'http://127.0.0.1:8787';
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair', op: 'claim', code, user_id: 'desktop' })
  });
  const data = await res.json();
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const deep = argv.find((a) => a.startsWith('anticodex://'));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (deep) win.webContents.send('acx:deep-link', deep);
    }
  });

  app.whenReady().then(async () => {
    try { app.setAsDefaultProtocolClient('anticodex'); } catch { /* non-fatal */ }
    await startLocalServer();
    createWindow();
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
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

export { VERSION };
