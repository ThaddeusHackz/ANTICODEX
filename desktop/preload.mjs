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
  // Opens a file picker for a `.skill` archive and installs it into ~/.codex/skills.
  installSkill: () => ipcRenderer.invoke('acx:skillInstall'),
  // Streamed chat: events arrive on a private channel, filtered by stream id.
  streamApi: (action, payload, onEvent) => {
    const streamId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const listener = (_e, msg) => {
      if (msg?.streamId !== streamId) return;
      try { onEvent?.(msg.evt); } catch { /* a view error must not kill the stream */ }
    };
    ipcRenderer.on('acx:stream:event', listener);
    return ipcRenderer.invoke('acx:api:stream', action, payload, streamId)
      .finally(() => ipcRenderer.removeListener('acx:stream:event', listener));
  },
  abortStream: (streamId) => ipcRenderer.invoke('acx:api:stream:abort', streamId),
  reaEnv: () => ipcRenderer.invoke('acx:reaEnv'),
  checkUpdate: () => ipcRenderer.invoke('acx:update'),
  downloadUpdate: () => ipcRenderer.invoke('acx:update:download'),
  onUpdateAvailable: (cb) => ipcRenderer.on('acx:update-available', (_e, info) => cb(info)),
  onDeepLink: (cb) => ipcRenderer.on('acx:deep-link', (_e, url) => cb(url))
});
