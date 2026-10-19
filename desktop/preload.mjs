// Preload — exposes the ANTICODEX desktop bridge to the bundled web UI.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anticodexDesktop', {
  version: '0.1.6',
  api: (action, payload) => ipcRenderer.invoke('acx:api', action, payload),
  computer: (cmd, args) => ipcRenderer.invoke('acx:computer', cmd, args),
  state: (patch) => ipcRenderer.invoke('acx:state', patch),
  pair: (code) => ipcRenderer.invoke('acx:pair', code),
  githubLogin: () => ipcRenderer.invoke('acx:githubLogin'),
  pairWait: (code) => ipcRenderer.invoke('acx:pairWait', code),
  saveKeys: (keys) => ipcRenderer.invoke('acx:saveKeys', keys),
  getKeys: () => ipcRenderer.invoke('acx:getKeys'),
  checkUpdate: () => ipcRenderer.invoke('acx:update'),
  downloadUpdate: () => ipcRenderer.invoke('acx:update:download'),
  onUpdateAvailable: (cb) => ipcRenderer.on('acx:update-available', (_e, info) => cb(info)),
  onDeepLink: (cb) => ipcRenderer.on('acx:deep-link', (_e, url) => cb(url))
});
