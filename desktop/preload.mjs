// Preload — exposes the ANTICODEX desktop bridge to the bundled web UI.
// Context isolation is on and node integration is off, so the only things the
// page can reach are the methods below. What the UI needs to tell the truth
// about (app version, whether the keys on this machine are encrypted at rest) is
// handed over by the main process as launch arguments, never read from disk here.

import { contextBridge, ipcRenderer } from 'electron';

const flag = (name, fallback = '') => {
  const hit = (process.argv || []).find((a) => a.startsWith(`--anticodex-${name}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : fallback;
};

contextBridge.exposeInMainWorld('anticodexDesktop', {
  version: flag('version', '0.0.0'),
  // 'safeStorage' | 'plaintext-file' — the Desktop tab shows what that means.
  keychain: flag('keychain', 'unknown'),
  api: (action, payload) => ipcRenderer.invoke('acx:api', action, payload),
  computer: (cmd, args) => ipcRenderer.invoke('acx:computer', cmd, args),
  state: (patch) => ipcRenderer.invoke('acx:state', patch),
  pair: (code) => ipcRenderer.invoke('acx:pair', code),
  githubLogin: () => ipcRenderer.invoke('acx:githubLogin'),
  pairWait: (code) => ipcRenderer.invoke('acx:pairWait', code),
  saveKeys: (keys) => ipcRenderer.invoke('acx:saveKeys', keys),
  getKeys: () => ipcRenderer.invoke('acx:getKeys'),
  keychainStatus: () => ipcRenderer.invoke('acx:keychainStatus'),
  saveCustoms: (list) => ipcRenderer.invoke('acx:saveCustoms', list),
  getCustoms: () => ipcRenderer.invoke('acx:getCustoms'),
  checkUpdate: () => ipcRenderer.invoke('acx:update'),
  downloadUpdate: () => ipcRenderer.invoke('acx:update:download'),
  onUpdateAvailable: (cb) => ipcRenderer.on('acx:update-available', (_e, info) => cb(info)),
  onDeepLink: (cb) => ipcRenderer.on('acx:deep-link', (_e, url) => cb(url))
});
