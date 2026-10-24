import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useApp, loadThreads, mergeThreads } from './lib/state.jsx';
import * as api from './lib/api.js';
import { Brand, Toast } from './ui.jsx';
import ModelPicker from './ModelPicker.jsx';
import EffortPicker from './EffortPicker.jsx';
import ChatPage from './pages/Chat.jsx';
import CodexPage from './pages/Codex.jsx';
import ClaudePage from './pages/Claude.jsx';
import ImagesPage from './pages/Images.jsx';
import VideoPage from './pages/Video.jsx';
import McpPage from './pages/Mcp.jsx';
import SkillsPage from './pages/Skills.jsx';
import ReaPage from './pages/Rea.jsx';
import SandboxPage from './pages/Sandbox.jsx';
import ComputerPage from './pages/Computer.jsx';
import SettingsPage from './pages/Settings.jsx';
import AdminPage from './pages/Admin.jsx';
import SetupPage from './pages/Setup.jsx';
import { LoginPage, SignupPage, ForgotPage, ResetPage, VerifyPage, CallbackPage, EmailLinkHandler, DesktopLinkHandler, DesktopDeepLinkHandler } from './pages/Auth.jsx';

// Sidebar nav mirrors the reverse-engineered ChatGPT desktop rail (new chat,
// search, library, codex) with ANTICODEX sections added below.
const NAV = [
  { to: '/', icon: '⌗', label: 'Chat', end: true, main: true },
  { to: '/codex', icon: '⌘', label: 'Codex', main: true },
  { to: '/claude', icon: '✳', label: 'Agent Studio', main: true },
  { to: '/sandbox', icon: '⌥', label: 'Sandbox' },
  { to: '/images', icon: '▦', label: 'Images' },
  { to: '/video', icon: '▶', label: 'Video' },
  { to: '/mcp', icon: '⇄', label: 'Connectors' },
  { to: '/computer', icon: '▣', label: 'Computer Use' },
  { to: '/skills', icon: '✦', label: 'Skills' },
  { to: '/rea', icon: '⟲', label: 'REA' },
  { to: '/setup', icon: '⇪', label: 'Bring your setup' }
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

function Sidebar() {
  const { user, signOut, sidebarOpen, setSidebarOpen, cfg, notify } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  // `loadThreads()` is synchronous; the old `loadThreads().then(...)` call threw
  // a TypeError inside this effect and took the whole signed-in shell (every
  // page, workspace included) down to a blank screen. Threads now come from the
  // account on the server, with the local copy painted first and merged by id.
  const [threads, setThreads] = useState(() => loadThreads());
  const [menuOpen, setMenuOpen] = useState(false);

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

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
      <div className="sidebar-head">
        <Brand />
        <div className="between" />
        <button className="icon-btn" title="Close sidebar" onClick={() => setSidebarOpen(false)}>⇤</button>
      </div>
      <div style={{ padding: '2px 8px' }}>
        <button className="nav-item" onClick={() => nav('/')}>
          <span className="ico">＋</span> New chat
        </button>
        <button className="nav-item" onClick={() => notify('Search chats — full-text thread search is on the roadmap')}>
          <span className="ico">⌕</span> Search chats
        </button>
        <button className="nav-item" onClick={() => nav('/images')}>
          <span className="ico">▤</span> Library
        </button>
      </div>
      <div className="sidebar-scroll">
        {NAV.filter((n) => n.main).map((n) => (
          <button key={n.to} className={`nav-item ${loc.pathname === n.to ? 'active' : ''}`} onClick={() => nav(n.to)}>
            <span className="ico">{n.icon}</span> {n.label}
          </button>
        ))}
        <div className="nav-label">Workspace</div>
        {NAV.filter((n) => !n.main).map((n) => (
          <button key={n.to} className={`nav-item ${loc.pathname === n.to ? 'active' : ''}`} onClick={() => nav(n.to)}>
            <span className="ico">{n.icon}</span> {n.label}
          </button>
        ))}
        {user && threads.length > 0 && <div className="nav-label">Chats</div>}
        {Object.entries(groups).map(([label, items]) =>
          items.length ? (
            <div key={label}>
              {items.slice(0, 20).map((t) => (
                <button
                  key={t.id}
                  className={`thread-item ${loc.search.includes(t.id) ? 'active' : ''}`}
                  onClick={() => nav(`/?thread=${encodeURIComponent(t.id)}`)}
                >
                  {t.title || 'Untitled chat'}
                </button>
              ))}
            </div>
          ) : null
        )}
      </div>
      <div className="sidebar-foot" style={{ position: 'relative' }}>
        {menuOpen && (
          <div className="model-menu" style={{ bottom: 64, top: 'auto', left: 8, width: 240 }}>
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
            <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user ? user.name || user.email : 'Sign in'}
            </div>
            <div className="tiny">{user ? (cfg?.name || 'ANTICODEX') : 'Sync your chats'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  const { sidebarOpen, setSidebarOpen, cfg } = useApp();
  const loc = useLocation();
  return (
    <div className="topbar">
      {!sidebarOpen && (
        <>
          <button className="icon-btn" title="Open sidebar" onClick={() => setSidebarOpen(true)}>⇥</button>
          <Brand compact />
        </>
      )}
      <ModelPicker />
      <EffortPicker />
      <div className="spacer" />
      <button className="chip-toggle" onClick={() => { window.location.pathname = '/mcp'; }}>⇄ Connect</button>
      <button className="icon-btn" title="Settings" onClick={() => { window.location.pathname = '/settings'; }}>⚙</button>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Topbar />
        {children}
      </main>
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
        <Route path="/sandbox" element={<Shell><Guarded><SandboxPage /></Guarded></Shell>} />
        <Route path="/images" element={<Shell><Guarded><ImagesPage /></Guarded></Shell>} />
        <Route path="/video" element={<Shell><Guarded><VideoPage /></Guarded></Shell>} />
        <Route path="/skills" element={<Shell><Guarded><SkillsPage /></Guarded></Shell>} />
        <Route path="/rea" element={<Shell><Guarded><ReaPage /></Guarded></Shell>} />
        <Route path="/mcp" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/mcp/callback" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/computer" element={<Shell><Guarded><ComputerPage /></Guarded></Shell>} />
        <Route path="/setup" element={<Shell><Guarded><SetupPage /></Guarded></Shell>} />
        <Route path="/settings" element={<Shell><Guarded><SettingsPage /></Guarded></Shell>} />
        <Route path="/admin" element={<Shell><AdminPage /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* the prop used to be forgotten here, so notify() was invisible everywhere */}
      {toast && <Toast toast={toast} />}
    </>
  );
}
