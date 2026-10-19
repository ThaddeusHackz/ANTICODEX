import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as api from './api.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_user') || 'null'); } catch { return null; }
  });
  const [theme, setTheme] = useState(localStorage.getItem('acx_theme') || 'dark');
  const [toast, setToast] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [model, setModel] = useState(localStorage.getItem('acx_model') || 'anticodex/demo-core');
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 900);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('acx_theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('acx_model', model);
    // keep a short "recently used" list for the model picker (setModel from any
    // page — chat, Codex, agent studio — lands here)
    import('../ModelPicker.jsx').then((m) => m.rememberModel(model)).catch(() => {});
  }, [model]);

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);

  // Restore the session from the token on disk, and drop tokens the server no
  // longer recognises (a reset or a sign-out elsewhere) so the app never sits
  // in a half-signed-in state.
  useEffect(() => { setDataNamespace(user?.id); }, [user?.id]);

  useEffect(() => {
    if (!localStorage.getItem('acx_token')) return;
    let alive = true;
    api.auth.me()
      .then((r) => {
        if (!alive) return;
        if (r?.user) { setUser(r.user); localStorage.setItem('acx_user', JSON.stringify(r.user)); }
      })
      .catch((e) => {
        if (!alive) return;
        if (e?.status === 401) { localStorage.removeItem('acx_token'); localStorage.removeItem('acx_user'); setUser(null); }
      });
    return () => { alive = false; };
  }, []);

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const signIn = useCallback((token, u) => {
    localStorage.setItem('acx_token', token);
    localStorage.setItem('acx_user', JSON.stringify(u));
    setUser(u);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem('acx_token');
    localStorage.removeItem('acx_user');
    setUser(null);
    api.auth.logout();
  }, []);

  return (
    <Ctx.Provider value={{
      user, setUser, signIn, signOut, theme, setTheme,
      toast, notify, cfg, setCfg, model, setModel, sidebarOpen, setSidebarOpen
    }}>
      {children}
    </Ctx.Provider>
  );
}

// --- Storage, per account ---------------------------------------------------
// localStorage belongs to the machine, not the user, and the desktop app is one
// install that can be paired to several accounts. Chats and the Codex workspace
// used to be shared through that single global bucket, so signing in as somebody
// else showed you their files and their threads. Everything is keyed by account
// id now, with a one-time move of the old unkeyed data into the first account
// that opens it, so nobody loses their history.

let NS = '';
const migrated = new Set();

export function userKey(base, id = NS) {
  return id ? `${base}:${id}` : base;
}

export function setDataNamespace(id) {
  const next = String(id || '');
  if (next === NS) return;
  NS = next;
  if (!NS) return;
  for (const base of ['acx_threads', 'acx_fs']) {
    if (migrated.has(base)) continue;
    migrated.add(base);
    try {
      const legacy = localStorage.getItem(base);
      if (legacy !== null && localStorage.getItem(userKey(base)) === null) localStorage.setItem(userKey(base), legacy);
    } catch { /* private mode / quota — the server copy is the source of truth */ }
  }
}

// --- Local thread storage (synced to /api/threads when signed in) -----------
// NOTE: these are synchronous on purpose — a previous caller wrote
// `loadThreads().then(...)`, which threw a TypeError inside the sidebar effect
// and blanked the whole signed-in app (every page, workspace included). Keep it
// sync, or make that explicit here.

export function loadThreads() {
  try { return JSON.parse(localStorage.getItem(userKey('acx_threads')) || '[]'); } catch { return []; }
}

export function saveThreadLocal(thread) {
  const all = loadThreads();
  const idx = all.findIndex((t) => t.id === thread.id);
  const next = { ...thread, updated_at: new Date().toISOString() };
  if (idx >= 0) all[idx] = next; else all.unshift(next);
  all.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  try { localStorage.setItem(userKey('acx_threads'), JSON.stringify(all.slice(0, 200))); } catch { /* quota */ }
  return next;
}

export function deleteThreadLocal(id) {
  try { localStorage.setItem(userKey('acx_threads'), JSON.stringify(loadThreads().filter((t) => t.id !== id))); } catch { /* quota */ }
}

/** Newest wins per id; the server is authoritative for other devices, the local
 *  copy for whatever you typed in the last second. */
export function mergeThreads(local = [], remote = []) {
  const stamp = (t) => Date.parse(t && (t.updated_at || t.created_at)) || 0;
  const byId = new Map();
  for (const t of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!t || !t.id) continue;
    const prev = byId.get(t.id);
    if (!prev || stamp(t) >= stamp(prev)) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
}

/** Tell the rail (and any other listener) that threads changed. */
export function threadsChanged() {
  try { window.dispatchEvent(new Event('acx:threads')); } catch { /* no DOM */ }
}

export function syncThread(thread) {
  saveThreadLocal(thread);
  api.threads.save(thread).then(threadsChanged).catch(() => {});
}
