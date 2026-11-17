import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useApp, loadThreads, mergeThreads } from './lib/state.jsx';
import * as api from './lib/api.js';
import { Brand, Toast, CommandPalette } from './ui.jsx';
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
import QoderPage from './pages/Qoder.jsx';
import SandboxPage from './pages/Sandbox.jsx';
import ComputerPage from './pages/Computer.jsx';
import SettingsPage from './pages/Settings.jsx';
import AdminPage from './pages/Admin.jsx';
import SetupPage from './pages/Setup.jsx';
import LibraryPage from './pages/Library.jsx';
import AgentPage from './pages/Agent.jsx';
import ApisPage from './pages/Apis.jsx';
import ParityPage from './pages/Parity.jsx';
import EvidencePage from './pages/Evidence.jsx';
import InstallPage from './pages/Install.jsx';
import { LoginPage, SignupPage, ForgotPage, ResetPage, VerifyPage, CallbackPage, EmailLinkHandler, DesktopLinkHandler, DesktopDeepLinkHandler } from './pages/Auth.jsx';

// ---------------------------------------------------------------------------
// The rail. Order is the spec the product is judged against (see
// lib/qoder-fieldkit.js → NAV_SPEC, which is what this list mirrors): the things
// you do every day at the top, the workspace tools in the middle, the settings and
// evidence at the bottom. Icons are monochrome glyphs so they line up at 64px.
// ---------------------------------------------------------------------------
// The rail, in the order it was specified:
//
//   ＋ New chat / ⌕ Search chats / ▤ Library
//   ⌗ Chat / ⌘ Codex / ✳ Agent Studio
//   Workspace: ⌥ Sandbox, ▦ Images, ▶ Video, ⇄ Connectors, ▣ Computer Use,
//              ✦ Skills, ⟲ REA, ◈ Qoder, ⇪ Bring your setup
//   Chats
//
// `tests/test-web-mount.mjs` asserts that order and that no destination appears
// twice — Library used to be in both the top actions and the Workspace group, which
// reads as two different pages.
const NAV_TOP = [
  { to: '/', icon: '⌗', label: 'Chat', end: true, title: 'Multi-model chat' },
  { to: '/codex', icon: '⌘', label: 'Codex', title: 'Code workspace' },
  { to: '/studio', icon: '✳', label: 'Agent Studio', title: 'Plans, memory, skills, tool log' }
];

const NAV_WORKSPACE = [
  { to: '/sandbox', icon: '⌥', label: 'Sandbox', title: 'Run code locally or on Daytona' },
  { to: '/images', icon: '▦', label: 'Images', title: 'Flux image generation' },
  { to: '/video', icon: '▶', label: 'Video', title: 'Hailuo text-to-video' },
  { to: '/mcp', icon: '⇄', label: 'Connectors', title: 'MCP servers' },
  { to: '/computer', icon: '▣', label: 'Computer Use', title: 'Screen + input control' },
  { to: '/skills', icon: '✦', label: 'Skills', title: '2,208 indexed skills' },
  { to: '/rea', icon: '⟲', label: 'REA', title: 'Reverse Engineer Anything' },
  { to: '/qoder', icon: '◈', label: 'Qoder', title: 'Qoder field guide' },
  { to: '/setup', icon: '⇪', label: 'Bring your setup', title: 'Import Codex/Claude config' }
];

// Beyond the specified rail: the pages that back up what the app claims. Kept in
// their own group so the named list above stays exactly the named list.
const NAV_INTEL = [
  { to: '/agent', icon: '⚙', label: 'Agent', title: 'OpenCode-style agent: read, write, edit, bash on Daytona' },
  { to: '/apis', icon: '⛁', label: 'Public APIs', title: '2,335 free endpoints the agent can call' },
  { to: '/parity', icon: '◎', label: 'Codex parity', title: 'Every crate, and where we implement it' },
  { to: '/evidence', icon: '⌸', label: 'Evidence', title: 'The reverse-engineering record' },
  { to: '/install', icon: '⤓', label: 'Install', title: 'macOS app, iPhone app, PWA' }
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

function NavButton({ item, active, railed, count, onClick }) {
  return (
    <button
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={onClick}
      title={railed ? item.title || item.label : item.title || undefined}
    >
      <span className="ico" aria-hidden="true">{item.icon}</span>
      <span className="label">{item.label}</span>
      {count != null && <span className="nav-count">{count}</span>}
    </button>
  );
}

const newChatCounter = { current: 0 };

function Sidebar({ threads, onOpenPalette, onSearch, searching, setSearching, searchQuery, setSearchQuery, searchHits, searchGroups }) {
  const { user, signOut, sidebarOpen, setSidebarOpen, cfg, railed, setRailed } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  // The thread list lives in Shell so the rail and chat search cannot disagree
  // about what exists. It used to be two copies — the rail's (server + local) and
  // Shell's (local only) — so searching found only chats written on this device.
  const [menuOpen, setMenuOpen] = useState(false);
  const groups = useMemo(() => groupThreads(threads || []), [threads]);
  const isActive = (item) => (item.end ? loc.pathname === item.to : loc.pathname === item.to || loc.pathname.startsWith(item.to + '/'));
  const wide = sidebarOpen && !railed;

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'closed'} ${railed ? 'rail' : ''}`}>
      <div className="sidebar-head">
        <button className="brand" onClick={() => nav('/')} title="ANTICODEX">
          <Brand />
        </button>
        <div className="between" />
        {wide && (
          <button className="icon-btn" title="Command palette (⌘K)" onClick={onOpenPalette}>⌕</button>
        )}
        {wide ? (
          <button className="icon-btn" title="Collapse to icons" onClick={() => setRailed(true)}>⇤</button>
        ) : (
          <button className="icon-btn" title="Expand" onClick={() => { setRailed(false); setSidebarOpen(true); }}>⇥</button>
        )}
      </div>

      <div className="sidebar-scroll">
        {/* New chat / search / library — the three actions above the sections */}
        {/* A monotonically increasing counter, not a timestamp: two taps in the
            same millisecond must still be two distinct navigations. */}
        <NavButton item={{ icon: '＋', label: 'New chat' }} railed={railed} onClick={() => nav(`/?new=${++newChatCounter.current}`)} />
        <NavButton item={{ icon: '⌕', label: 'Search chats' }} railed={railed} onClick={onSearch} active={searching} />
        <NavButton item={{ icon: '▤', label: 'Library' }} railed={railed} active={loc.pathname === '/library'} onClick={() => nav('/library')} />

        <div style={{ height: 6 }} />
        {NAV_TOP.map((item) => (
          <NavButton key={item.to} item={item} railed={railed} active={isActive(item)} onClick={() => nav(item.to)} />
        ))}

        <div className="nav-label">Workspace</div>
        {NAV_WORKSPACE.map((item) => (
          <NavButton key={item.to} item={item} railed={railed} active={isActive(item)} onClick={() => nav(item.to)} />
        ))}

        <div className="nav-label">Intelligence</div>
        {NAV_INTEL.map((item) => (
          <NavButton key={item.to} item={item} railed={railed} active={isActive(item)} onClick={() => nav(item.to)} />
        ))}

        {searching && wide && (
          <div className="thread-group" style={{ padding: '4px 2px' }}>
            <div className="nav-label" style={{ padding: '10px 8px 4px' }}>Chat search</div>
            <input
              autoFocus
              type="search"
              placeholder="Search titles and messages…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)',
                color: 'var(--text)', borderRadius: 9, padding: '7px 9px', fontSize: 12.5, outline: 'none'
              }}
            />
            {searchQuery.trim() ? (
              (searchGroups?.total || searchHits.length) ? (
                <>
                  {(searchGroups?.groups || []).map((g) => (
                    <div key={g.id} className="thread-group">
                      <div className="tiny thread-group-label"><span aria-hidden="true">{g.icon}</span> {g.label} · {g.items.length}</div>
                      {g.items.map((it) => (
                        <button
                          key={`${g.id}-${it.id}`}
                          className="thread-item search-hit"
                          onClick={() => { nav(it.to); setSearching(false); }}
                          title={it.title}
                        >
                          <span className="search-hit-title">{it.title}</span>
                          {(it.subtitle || it.snippet) && (
                            <span className="search-hit-sub">{it.subtitle || it.snippet}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                  {searchHits.length > 0 && (
                    <div className="thread-group">
                      <div className="tiny thread-group-label"><span aria-hidden="true">⌗</span> Chat snippets</div>
                      {searchHits.slice(0, 6).map((t) => (
                        <button key={t.id} className="thread-item" onClick={() => { nav(`/?thread=${encodeURIComponent(t.id)}`); setSearching(false); }}>
                          <span className="search-hit-title">{t.title || 'Untitled chat'}</span>
                          {t.snippet && <span className="search-hit-sub">{t.snippet}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : <div className="tiny" style={{ padding: '6px 8px' }}>Nothing matches “{searchQuery}” in chats, APIs, skills or connectors.</div>
            ) : (
              <div className="tiny" style={{ padding: '6px 8px' }}>
                Searches {threads.length} chat{threads.length === 1 ? '' : 's'}, the API catalogue, the skill atlas and your connectors.
              </div>
            )}
          </div>
        )}

        {!searching && user && threads.length > 0 && <div className="nav-label">Chats</div>}
        {!searching && Object.entries(groups).map(([label, items]) => items.length ? (
          <div className="thread-group" key={label}>
            {wide && <div className="tiny" style={{ padding: '6px 9px 2px', opacity: .75 }}>{label}</div>}
            {items.slice(0, wide ? 20 : 0).map((t) => (
              <button
                key={t.id}
                className={`thread-item ${loc.search.includes(t.id) ? 'active' : ''}`}
                title={t.title || 'Untitled chat'}
                onClick={() => nav(`/?thread=${encodeURIComponent(t.id)}`)}
              >
                {t.title || 'Untitled chat'}
              </button>
            ))}
          </div>
        ) : null)}
      </div>

      <div className="sidebar-foot" style={{ position: 'relative' }}>
        {menuOpen && wide && (
          <div className="model-menu" style={{ bottom: 62, top: 'auto', left: 8, width: 250 }}>
            <button className="m-item" onClick={() => { setMenuOpen(false); nav('/settings'); }}>
              <span>⚙ Settings</span><span className="desc">Providers, keys, personalization, data</span>
            </button>
            <button className="m-item" onClick={() => { setMenuOpen(false); nav('/parity'); }}>
              <span>◎ Codex parity</span><span className="desc">What we implement, and what is missing</span>
            </button>
            {user?.role === 'admin' && (
              <button className="m-item" onClick={() => { setMenuOpen(false); nav('/admin'); }}>
                <span>◈ Admin</span><span className="desc">Platform console</span>
              </button>
            )}
            <button className="m-item" onClick={() => { setMenuOpen(false); signOut(); nav('/login'); }}>
              <span>⇥ Log out</span>
            </button>
          </div>
        )}
        <button className="user-pill" onClick={() => setMenuOpen((v) => !v)}>
          <div className="avatar">{(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}</div>
          <div className="who">
            <b>{user ? user.name || user.email : 'Sign in'}</b>
            <span>{user ? (cfg?.name || 'ANTICODEX') : 'Sync your chats'}</span>
          </div>
        </button>
      </div>
    </aside>
  );
}

/** A tap-anywhere-to-close backdrop, only while the drawer is open on a phone. */
function MobileScrim() {
  const { sidebarOpen, setSidebarOpen, railed } = useApp();
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!narrow || !sidebarOpen || railed) return null;
  return <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" role="presentation" />;
}

function Topbar({ onOpenPalette }) {
  const { sidebarOpen, setSidebarOpen, railed } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const title = useMemo(() => {
    const all = [...NAV_TOP, ...NAV_WORKSPACE, ...NAV_INTEL,
      { to: '/settings', label: 'Settings' }, { to: '/admin', label: 'Admin' }];
    const hit = all.find((n) => (n.end ? loc.pathname === n.to : loc.pathname === n.to || loc.pathname.startsWith(n.to + '/')));
    return hit?.label || 'ANTICODEX';
  }, [loc.pathname]);

  return (
    <div className="topbar">
      {(!sidebarOpen || railed) && (
        <button className="icon-btn" title="Open the rail" onClick={() => setSidebarOpen(true)}>☰</button>
      )}
      <div className="crumb"><b>{title}</b></div>
      <ModelPicker />
      <EffortPicker />
      <div className="spacer" />
      <button className="icon-btn" title="Command palette (⌘K)" onClick={onOpenPalette}>⌕<span className="tiny" style={{ opacity: .6 }}>K</span></button>
      <button className="icon-btn" title="Connectors" onClick={() => nav('/mcp')}>⇄</button>
      <button className="icon-btn" title="Settings" onClick={() => nav('/settings')}>⚙</button>
    </div>
  );
}

function Shell({ children }) {
  const { setSidebarOpen } = useApp();
  const loc = useLocation();
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { user } = useApp();
  // Local first (instant, works offline), then the account copy, merged by id.
  const [threads, setThreads] = useState(() => loadThreads());
  const nav = useNavigate();

  // A drawer that stays open after you tap a destination covers the page you
  // just asked for. Close it on every navigation below the 900px breakpoint.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) setSidebarOpen(false);
  }, [loc.pathname, loc.search, setSidebarOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setThreads(loadThreads());
    if (!user?.id) return undefined;
    let alive = true;
    const pull = () => api.threads.list()
      .then((r) => { if (alive) setThreads(mergeThreads(loadThreads(), (r && r.threads) || [])); })
      .catch(() => {});
    pull();
    window.addEventListener('acx:threads', pull);
    return () => { alive = false; window.removeEventListener('acx:threads', pull); };
  }, [user?.id, loc.pathname]);

  const searchHits = useMemo(() => api.searchThreads(threads, searchQuery), [threads, searchQuery]);
  // The local hits appear on the first keystroke; the cross-corpus groups arrive a
  // moment later from the bridge. Debounced because the API catalogue is 2,335
  // entries and typing "weather" should not run five full scans.
  const [searchGroups, setSearchGroups] = useState(null);
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchGroups(null); return; }
    const t = setTimeout(() => {
      api.searchAll(q).then(setSearchGroups).catch(() => setSearchGroups(null));
    }, 140);
    return () => clearTimeout(t);
  }, [searchQuery]);

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        onOpenPalette={() => setPaletteOpen(true)}
        onSearch={() => setSearching((v) => !v)}
        searching={searching}
        setSearching={setSearching}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchHits={searchHits}
        searchGroups={searchGroups}
      />
      <MobileScrim />
      <main className="main">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        {children}
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={(to) => { setPaletteOpen(false); nav(to); }} />}
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
        <Route path="/studio" element={<Shell><Guarded><ClaudePage /></Guarded></Shell>} />
        <Route path="/claude" element={<Navigate to="/studio" replace />} />
        <Route path="/workspace" element={<Navigate to="/codex" replace />} />
        <Route path="/sandbox" element={<Shell><Guarded><SandboxPage /></Guarded></Shell>} />
        <Route path="/images" element={<Shell><Guarded><ImagesPage /></Guarded></Shell>} />
        <Route path="/video" element={<Shell><Guarded><VideoPage /></Guarded></Shell>} />
        <Route path="/library" element={<Shell><Guarded><LibraryPage /></Guarded></Shell>} />
        <Route path="/agent" element={<Shell><Guarded><AgentPage /></Guarded></Shell>} />
        <Route path="/apis" element={<Shell><Guarded><ApisPage /></Guarded></Shell>} />
        <Route path="/skills" element={<Shell><Guarded><SkillsPage /></Guarded></Shell>} />
        <Route path="/rea" element={<Shell><Guarded><ReaPage /></Guarded></Shell>} />
        <Route path="/qoder" element={<Shell><Guarded><QoderPage /></Guarded></Shell>} />
        <Route path="/parity" element={<Shell><Guarded><ParityPage /></Guarded></Shell>} />
        <Route path="/evidence" element={<Shell><Guarded><EvidencePage /></Guarded></Shell>} />
        <Route path="/install" element={<Shell><InstallPage /></Shell>} />
        <Route path="/mcp" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/mcp/callback" element={<Shell><Guarded><McpPage /></Guarded></Shell>} />
        <Route path="/computer" element={<Shell><Guarded><ComputerPage /></Guarded></Shell>} />
        <Route path="/setup" element={<Shell><Guarded><SetupPage /></Guarded></Shell>} />
        <Route path="/settings" element={<Shell><Guarded><SettingsPage /></Guarded></Shell>} />
        <Route path="/admin" element={<Shell><AdminPage /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {toast && <Toast toast={toast} />}
    </>
  );
}
