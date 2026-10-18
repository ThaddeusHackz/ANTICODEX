import React from 'react';
import { Routes, Route, NavLink, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useApp, loadThreads } from './lib/state.jsx';
import { Brand, Logo, Toast } from './ui.jsx';
import ChatPage from './pages/Chat.jsx';
import CodexPage from './pages/Codex.jsx';
import ClaudePage from './pages/Claude.jsx';
import ImagesPage from './pages/Images.jsx';
import VideoPage from './pages/Video.jsx';
import McpPage from './pages/Mcp.jsx';
import ComputerPage from './pages/Computer.jsx';
import SettingsPage from './pages/Settings.jsx';
import AdminPage from './pages/Admin.jsx';
import { LoginPage, SignupPage, ForgotPage, ResetPage } from './pages/Auth.jsx';

const NAV = [
  { to: '/', icon: '◉', label: 'Chat', end: true },
  { to: '/codex', icon: '⌘', label: 'Codex Workspace' },
  { to: '/claude', icon: '✳', label: 'Agent Studio' },
  { to: '/images', icon: '▦', label: 'Images · Flux' },
  { to: '/video', icon: '▶', label: 'Video · Hailuo' },
  { to: '/mcp', icon: '⇄', label: 'MCP Connectors' },
  { to: '/computer', icon: '▣', label: 'Computer Use' },
  { to: '/settings', icon: '⚙', label: 'Settings' },
  { to: '/admin', icon: '◈', label: 'Admin' }
];

function Sidebar() {
  const { user, signOut, sidebarOpen, theme, setTheme } = useApp();
  const nav = useNavigate();
  const threads = loadThreads().slice(0, 12);

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-head"><Brand small /></div>
      <button className="btn primary small" style={{ margin: '0 12px 10px' }} onClick={() => nav('/')}>
        + New chat
      </button>
      <nav className="nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="ico">{n.icon}</span>{n.label}
          </NavLink>
        ))}
      </nav>
      {threads.length > 0 && (
        <div className="sidebar-scroll">
          <div className="nav-section">Recent</div>
          {threads.map((t) => (
            <button key={t.id} className="thread-item" onClick={() => nav(`/?t=${t.id}`)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || 'Untitled'}</span>
            </button>
          ))}
        </div>
      )}
      <div className="sidebar-foot">
        <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        {user ? (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</div>
              <div className="tiny">{user.email}</div>
            </div>
            <button className="icon-btn" title="Sign out" onClick={() => { signOut(); nav('/login'); }}>⏻</button>
          </>
        ) : (
          <button className="btn small" style={{ flex: 1 }} onClick={() => nav('/login')}>Sign in</button>
        )}
      </div>
    </aside>
  );
}

function Shell({ children, wide = false }) {
  const { sidebarOpen, setSidebarOpen, toast } = useApp();
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar">☰</button>
          <div className="row" style={{ gap: 8 }}>
            <PillLive />
          </div>
          <div style={{ flex: 1 }} />
          <a className="icon-btn" href="https://github.com/ThaddeusHackz/ANTICODEX" target="_blank" rel="noreferrer" title="GitHub">⌥</a>
        </div>
        <div className="content">{children}</div>
      </main>
      <Toast toast={toast} />
    </div>
  );
}

function PillLive() {
  const { cfg } = useApp();
  return (
    <span className="pill ok">
      <span className="status-dot ok" /> v{cfg?.version || '0.1.0'} · all systems
    </span>
  );
}

function Private({ children }) {
  const { user } = useApp();
  const loc = useLocation();
  if (!user && loc.pathname !== '/login') return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/mcp/authorize" element={<McpPage authorizeOnly />} />
      <Route path="/*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<Private><ChatPage /></Private>} />
            <Route path="/codex" element={<Private><CodexPage /></Private>} />
            <Route path="/claude" element={<Private><ClaudePage /></Private>} />
            <Route path="/images" element={<Private><ImagesPage /></Private>} />
            <Route path="/video" element={<Private><VideoPage /></Private>} />
            <Route path="/mcp" element={<Private><McpPage /></Private>} />
            <Route path="/computer" element={<Private><ComputerPage /></Private>} />
            <Route path="/settings" element={<Private><SettingsPage /></Private>} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
