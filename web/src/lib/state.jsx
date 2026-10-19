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

  useEffect(() => { localStorage.setItem('acx_model', model); }, [model]);

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
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

// --- Local thread storage (synced to /api/threads when signed in) -----------

export function loadThreads() {
  try { return JSON.parse(localStorage.getItem('acx_threads') || '[]'); } catch { return []; }
}

export function saveThreadLocal(thread) {
  const all = loadThreads();
  const idx = all.findIndex((t) => t.id === thread.id);
  const next = { ...thread, updated_at: new Date().toISOString() };
  if (idx >= 0) all[idx] = next; else all.unshift(next);
  all.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  localStorage.setItem('acx_threads', JSON.stringify(all.slice(0, 200)));
  return next;
}

export function deleteThreadLocal(id) {
  localStorage.setItem('acx_threads', JSON.stringify(loadThreads().filter((t) => t.id !== id)));
}

export function syncThread(thread) {
  api.threads.save(thread).catch(() => {});
}
