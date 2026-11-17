import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useApp, loadThreads, mergeThreads, deleteThreadLocal, threadsChanged } from './lib/state.jsx';
import * as api from './lib/api.js';
import { Brand, Toast } from './ui.jsx';
import Icon from './Icon.jsx';
import ModelPicker from './ModelPicker.jsx';
import EffortPicker from './EffortPicker.jsx';
import SearchChats from './SearchChats.jsx';
import ChatPage from './pages/Chat.jsx';
import CodexPage from './pages/Codex.jsx';
import ClaudePage from './pages/Claude.jsx';
import LibraryPage from './pages/Library.jsx';
import ImagesPage from './pages/Images.jsx';
import VideoPage from './pages/Video.jsx';
import McpPage from './pages/Mcp.jsx';
import SkillsPage from './pages/Skills.jsx';
import ReaPage from './pages/Rea.jsx';
import QoderPage from './pages/Qoder.jsx';
import SandboxPage from './pages/Sandbox.jsx';
import ComputerPage from './pages/Computer.jsx';
import SettingsPage from './pages/Settings.jsx';
import AdminPage from './pages/Admin.jsx';
import SetupPage from './pages/Setup.jsx';
import InstallPage from './pages/Install.jsx';
import { LoginPage, SignupPage, ForgotPage, ResetPage, VerifyPage, CallbackPage, EmailLinkHandler, DesktopLinkHandler, DesktopDeepLinkHandler } from './pages/Auth.jsx';

// Sidebar nav mirrors the reverse-engineered ChatGPT/Codex desktop rail (new
// chat, search, library, then the agent surfaces) with ANTICODEX sections below.
export const NAV = [
  { to: '/', icon: 'chat', label: 'Chat', end: true, main: true, section: 'work' },
  { to: '/codex', icon: 'codex', label: 'Codex', main: true, section: 'work' },
  { to: '/claude', icon: 'agent', label: 'Agent Studio', main: true, section: 'work' },
  { to: '/sandbox', icon: 'sandbox', label: 'Sandbox', section: 'create' },
  { to: '/images', icon: 'images', label: 'Images', section: 'create' },
  { to: '/video', icon: 'video', label: 'Video', section: 'create' },
  { to: '/library', icon: 'library', label: 'Library', section: 'create' },
  { to: '/mcp', icon: 'connectors', label: 'Connectors', section: 'connect' },
  { to: '/computer', icon: 'computer', label: 'Computer Use', section: 'connect' },
  { to: '/skills', icon: 'skills', label: 'Skills', section: 'intelligence' },
  { to: '/rea', icon: 'rea', label: 'REA', section: 'intelligence' },
  { to: '/qoder', icon: 'qoder', label: 'Qoder', section: 'intelligence' },
  { to: '/setup', icon: 'setup', label: 'Bring your setup', section: 'intelligence' }
];

const NAV_SECTIONS = [
  { id: 'work', label: 'Work' },
  { id: 'create', label: 'Create' },
  { id: 'connect', label: 'Connect' },
  { id: 'intelligence', label: 'Intelligence' }
];


function groupThreads(list) {
  const now = Date.now();
  const day = 86400000;
  const groups = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  for (const t of list) {
    const at = new Date(t.updated_at || t.created_at || 0).getTime();
    const diff = now - at;
    if (diff < day) groups.Today.push(t);
    else if (diff < 2 * day) groups.Yesterday.push(t);
    else if (diff < 8 * day) groups['Previous 7 days'].push(t);
    else groups.Older.push(t);
  }
  return groups;
}

function Sidebar({ onSearch }) {
  const { user, signOut, sidebarOpen, setSidebarOpen, cfg, notify } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  // `loadThreads()` is synchronous; the old `loadThreads().then(...)` call threw
  // a TypeError inside this effect and took the whole signed-in shell (every
  // page, workspace included) down to a blank screen. Threads now come from the
  // account on the server, with the local copy painted first and merged by id.
  const [threads, setThreads] = useState(() => loadThreads());
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('acx_nav_collapsed') || '[]')); } catch { return new Set(); }
  });

  function toggleSection(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('acx_nav_collapsed', JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  }

  useEffect(() => {
    if (!user) { setThreads([]); return; }
    let alive = true;
    const pull = () => api.threads.list()
      .then((r) => { if (alive) setThreads(mergeThreads(loadThreads(), (r && r.threads) || [])); })
      .catch(() => {});
    setThreads(loadThreads());
    pull();
    window.addEventListener('acx:threads', pull);
    return () => { alive = false; window.removeEventListener('acx:threads', pull); };
  }, [user, loc.pathname]);

  const groups = useMemo(() => groupThreads(threads), [threads]);

  async function removeThread(e, t) {
    e.stopPropagation();
    deleteThreadLocal(t.id);
    threadsChanged();
    setThreads(loadThreads());
    try { await api.threads.remove(t.id); } catch { /* offline ok */ }
    notify('Chat deleted');
    if (loc.search.includes(t.id)) nav('/');
  }

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
      <div className="sidebar-head">
        <Brand />
        <div className="between" />
        <button className="icon-btn" title="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon name="close" size={17} /></button>
      </div>
      <div className="sidebar-top">
        <button className="nav-item nav-new" onClick={() => nav(`/?new=${Date.now()}`)}>
          <span className="ico"><Icon name="plus" size={18} /></span> New chat
        </button>
        <button className="nav-item" onClick={onSearch}>
          <span className="ico"><Icon name="search" size={18} /></span> Search chats <kbd className="kbd nav-kbd">⌘K</kbd>
        </button>
      </div>
      <div className="sidebar-scroll">
        {NAV_SECTIONS.map((sec) => {
          const items = NAV.filter((n) => n.section === sec.id);
          if (!items.length) return null;
          const isCollapsed = collapsed.has(sec.id);
          return (
            <div className="nav-section" key={sec.id}>
              <button
                className={`nav-label nav-label-btn ${isCollapsed ? 'collapsed' : ''}`}
                onClick={() => toggleSection(sec.id)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? `Show ${sec.label}` : `Hide ${sec.label}`}
              >
                <span>{sec.label}</span>
                <span className="nav-count">{items.length}</span>
                <span className="nav-chev" aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
              </button>
              {!isCollapsed && (
                <div className="nav-group">
                  {items.map((n) => (
                    <button key={n.to} className={`nav-item ${loc.pathname === n.to ? 'active' : ''}`} onClick={() => nav(n.to)}>
                      <span className="ico"><Icon name={n.icon} size={18} /></span> {n.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {user && threads.length > 0 && <div className="nav-label">Chats</div>}
        {Object.entries(groups).map(([label, items]) =>
          items.length ? (
            <div key={label} className="thread-group">
              <div className="thread-group-label">{label}</div>
              {items.slice(0, 20).map((t) => (
                <button
                  key={t.id}
                  className={`thread-item ${loc.search.includes(t.id) ? 'active' : ''}`}
                  onClick={() => nav(`/?thread=${encodeURIComponent(t.id)}`)}
                >
                  <span className="thread-title">{t.title || 'Untitled chat'}</span>
                  <span className="thread-del" title="Delete chat" onClick={(e) => removeThread(e, t)}>🗑</span>
                </button>
              ))}
            </div>
          ) : null
        )}
      </div>
      <div className="sidebar-foot" style={{ position: 'relative' }}>
        {menuOpen && (
          <div className="model-menu" style={{ bottom: 64, top: 'auto', left: 8, width: 240 }}>
            <button className="m-item" onClick={() => { setMenuOpen(false); nav('/install'); }}>
              <span>⇩ Install apps</span>
              <span className="desc">macOS · Windows · iOS</span>
            </button>
            <button className="m-item" onClick={() => { setMenuOpen(false); nav('/settings'); }}>
              <span>⚙ Settings</span>
              <span className="desc">Provider API keys, personalization, data</span>
            </button>
            <button className="m-item" onClick={() => { setMenuOpen(false); nav('/admin'); }}>
              <span>◈ Admin</span>
              <span className="desc">Platform console</span>
            </button>
            <button className="m-item" onClick={() => { setMenuOpen(false); signOut(); nav('/login'); }}>
              <span>⇥ Log out</span>
            </button>
          </div>
        )}
        <div className="user-pill" onClick={() => setMenuOpen((v) => !v)}>
          <div className="avatar">{(user?.name || '?').slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div className="user-name">{user ? user.name || user.email : 'Sign in'}</div>
            <div className="tiny">{user ? (cfg?.name || 'ANTICODEX') : 'Sync your chats'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  const { sidebarOpen, setSidebarOpen } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const current = [...NAV, { to: '/library', label: 'Library' }, { to: '/install', label: 'Install' }, { to: '/settings', label: 'Settings' }]
    .find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)));
  return (
    <div className="topbar">
      {!sidebarOpen && (
        <>
          <button className="icon-btn" title="Open sidebar" onClick={() => setSidebarOpen(true)}><Icon name="menu" size={18} /></button>
          <Brand small />
        </>
      )}
      <div className="topbar-title">
        <span className="topbar-eyebrow">ANTICODEX</span>
        <span className="topbar-current">{current?.label || 'Workspace'}</span>
      </div>
      <div className="spacer" />
      <button className="topbar-action" title="New chat" onClick={() => nav(`/?new=${Date.now()}`)}>
        <Icon name="plus" size={16} /><span>New</span>
      </button>
      <ModelPicker />
      <EffortPicker />
      <button className="icon-btn topbar-connect" title="Connectors" onClick={() => nav('/mcp')}><Icon name="connectors" size={18} /></button>
      <button className="icon-btn" title="Settings" onClick={() => nav('/settings')}><Icon name="settings" size={18} /></button>
    </div>
  );
}

function Shell({ children }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((v) => !v); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); nav('/'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);

  return (
    <div className="app">
      <Sidebar onSearch={() => setSearchOpen(true)} />
      <main className="main">
        <Topbar />
        {children}
      </main>
      <SearchChats open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function Guarded({ children }) {
  const { user } = useApp();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { toast } = useApp();
  return (
    <>
      <EmailLinkHandler />
      <DesktopLinkHandler />
      <DesktopDeepLinkHandler />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route path="/" element={<Shell><Guarded><ChatPage /></Guarded></Shell>} />
        <Route path="/codex" element={<Shell><Guarded><CodexPage /></Guarded></Shell>} />
        <Route path="/claude" element={<Shell><Guarded><ClaudePage /></Guarded></Shell>} />
        <Route path="/library" element={<Shell><Guarded><LibraryPage /></Guarded></Shell>} />
        <Route path="/sandbox" element={<Shell><Guarded><SandboxPage /></Guarded></Shell>} />
        <Route path="/images" element={<Shell><Guarded><ImagesPage /></Guarded></Shell>} />
        <Route path="/video" element={<Shell><Guarded><VideoPage /></Guarded></Shell>} />
        <Route path="/skills" element={<Shell><Guarded><SkillsPage /></Guarded></Shell>} />
        <Route path="/rea" element={<Shell><Guarded><ReaPage /></Guarded></Shell>} />
        <Route path="/qoder" element={<Shell><Guarded><QoderPage /></Guarded></Shell>} />
        <Route path="/mcp" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/mcp/callback" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/computer" element={<Shell><Guarded><ComputerPage /></Guarded></Shell>} />
        <Route path="/setup" element={<Shell><Guarded><SetupPage /></Guarded></Shell>} />
        <Route path="/install" element={<Shell><Guarded><InstallPage /></Guarded></Shell>} />
        <Route path="/settings" element={<Shell><Guarded><SettingsPage /></Guarded></Shell>} />
        <Route path="/admin" element={<Shell><AdminPage /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* the prop used to be forgotten here, so notify() was invisible everywhere */}
      {toast && <Toast toast={toast} />}
    </>
  );
}