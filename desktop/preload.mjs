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
  // Installs a skill. With a slug it writes the atlas copy (works offline);
  // without one it opens a picker for a `.skill` archive. `target` picks the root
  // (qoder|codex|claude) and defaults to qoder, matching the web UI.
  installSkill: (opts = {}) => ipcRenderer.invoke('acx:skillInstall', opts),
  skillRoots: () => ipcRenderer.invoke('acx:skillRoots'),
  // SSH to the Daytona workspace, executed in main so the key never reaches a page.
  daytona: (op, args = {}) => ipcRenderer.invoke('acx:daytona', op, args),
  // Streamed chat: events arrive on a private channel, filtered by stream id.
  // The caller generates the id (or gets one back) because cancelling needs the
  // same id: a stream the renderer cannot name is a Stop button that only hides
  // the typing dots while the provider keeps generating.
  streamApi: (action, payload, onEvent, streamId) => {
    const fresh = () => (globalThis.crypto?.randomUUID
      ? `s_${globalThis.crypto.randomUUID()}`
      : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    const id = String(streamId || fresh());
    const listener = (_e, msg) => {
      if (msg?.streamId !== id) return;
      try { onEvent?.(msg.evt); } catch { /* a view error must not kill the stream */ }
    };
    ipcRenderer.on('acx:stream:event', listener);
    return ipcRenderer.invoke('acx:api:stream', action, payload, id)
      .finally(() => ipcRenderer.removeListener('acx:stream:event', listener));
  },
  abortStream: (streamId) => ipcRenderer.invoke('acx:api:stream:abort', streamId),
  reaEnv: () => ipcRenderer.invoke('acx:reaEnv'),
  checkUpdate: () => ipcRenderer.invoke('acx:update'),
  downloadUpdate: () => ipcRenderer.invoke('acx:update:download'),
  applyUpdate: () => ipcRenderer.invoke('acx:update-apply'),
  dismissUpdate: (version) => ipcRenderer.invoke('acx:update-dismiss', version),
  updateStatus: () => ipcRenderer.invoke('acx:update-status'),
  onUpdateAvailable: (cb) => ipcRenderer.on('acx:update-available', (_e, info) => cb(info)),
  onDeepLink: (cb) => ipcRenderer.on('acx:deep-link', (_e, url) => cb(url))
});
