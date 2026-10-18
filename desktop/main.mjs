// ANTICODEX Desktop — Electron main process.
// Features: bundled web UI, computer-use bridge, auto-update with accept flow,
// desktop↔website account pairing, deep links (anticodex://).

import { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, screen, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createComputerUse } from './computer-use.mjs';
import { createUpdater } from './updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.1';
// Works both from the repo (../web/dist) and packaged (extra-resource dist).
const WEB_DIST_CANDIDATES = [
  path.join(__dirname, '..', 'web', 'dist'),
  path.join(__dirname, '..', 'dist'),
  path.join(process.resourcesPath || '', 'dist')
];
const WEB_DIST = WEB_DIST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'index.html'))) || WEB_DIST_CANDIDATES[0];
const STATE_FILE = path.join(app.getPath('userData'), 'anticodex-state.json');

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
  const base = state.apiBase || 'http://127.0.0.1:8787';
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload, provider_keys: state.providerKeys || {}, _desktop: true })
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

ipcMain.handle('acx:pair', async (_e, code) => {
  const state = loadState();
  const base = state.apiBase || 'http://127.0.0.1:8787';
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair', op: 'claim', code, user_id: 'desktop' })
  });
  const data = await res.json();
  if (data.ok) saveState({ desktopToken: data.token, pairedAt: new Date().toISOString() });
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

  app.whenReady().then(() => {
    try { app.setAsDefaultProtocolClient('anticodex'); } catch { /* non-fatal */ }
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
