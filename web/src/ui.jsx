import React, { useState } from 'react';

// The ANTICODEX mark: a clean geometric prism/keystone — deliberately the
// opposite of organic knot/asterisk logos: sharp nested rhombus, void core.
export function Logo({ size = 32, mono = false }) {
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="logo" aria-label="ANTICODEX">
      <defs>
        <linearGradient id={`lg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="55%" stopColor="#6c7bff" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="52" height="52" rx="15" fill={mono ? 'currentColor' : `url(#lg${id})`} />
      <path d="M32 16 L46 40 L32 48 L18 40 Z" fill="none" stroke="#0b0d14" strokeWidth="3.4" strokeLinejoin="round" />
      <path d="M32 16 L32 48 M18 40 L46 40" stroke="#0b0d14" strokeWidth="2.4" opacity="0.75" />
      <circle cx="32" cy="34" r="4.6" fill="#0b0d14" />
    </svg>
  );
}

export function Brand({ small = false }) {
  return (
    <span className="brand" style={{ padding: 0 }}>
      <Logo size={small ? 24 : 26} />
      <b>ANTI<span>CODEX</span></b>
    </span>
  );
}

export function Modal({ title, onClose, children, width }) {
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Switch({ on, onChange }) {
  return <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="tiny" style={{ marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

export function Pill({ kind = '', children }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

export function Toast({ toast }) {
  if (!toast) return null;
  return <div className="toast spark">{toast.message}</div>;
}

export function CopyBtn({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn small ghost" onClick={() => {
      navigator.clipboard?.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>{done ? '✓ Copied' : label}</button>
  );
}

export function Empty({ icon = '◇', title, children }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 42 }}>
      <div style={{ fontSize: 34, marginBottom: 8 }}>{icon}</div>
      <h3>{title}</h3>
      <p className="muted" style={{ maxWidth: 460, margin: '6px auto 0' }}>{children}</p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Command palette — ⌘K. The rail is 20 destinations; a palette is how you reach
// the 21st without adding a 21st row. It also searches skills, because "find the
// skill that does X" is the action people actually want most often.
// ---------------------------------------------------------------------------
const PALETTE_DESTINATIONS = [
  { label: 'New chat', hint: 'start a fresh thread', to: '/', icon: '＋', keys: 'new chat thread' },
  { label: 'Chat', hint: 'multi-model chat', to: '/', icon: '⌗', keys: 'chat talk model' },
  { label: 'Codex', hint: 'files, diffs, approvals, terminal', to: '/codex', icon: '⌘', keys: 'code workspace editor files' },
  { label: 'Agent Studio', hint: 'plans, memory, tool log', to: '/studio', icon: '✳', keys: 'agent plan memory studio claude' },
  { label: 'Sandbox', hint: 'run code here or on Daytona', to: '/sandbox', icon: '⌥', keys: 'sandbox run code python node daytona ssh' },
  { label: 'Images', hint: 'Flux generation', to: '/images', icon: '▦', keys: 'image flux picture generate' },
  { label: 'Video', hint: 'Hailuo text-to-video', to: '/video', icon: '▶', keys: 'video hailuo minimax motion' },
  { label: 'Library', hint: 'everything this workspace made', to: '/library', icon: '▤', keys: 'library artifacts files gallery output' },
  { label: 'Connectors', hint: 'MCP servers and tools', to: '/mcp', icon: '⇄', keys: 'mcp connectors tools server supabase context7 playwright' },
  { label: 'Computer Use', hint: 'screen and input control', to: '/computer', icon: '▣', keys: 'computer use screen mouse keyboard desktop' },
  { label: 'Skills', hint: '2,208 indexed skills', to: '/skills', icon: '✦', keys: 'skills skill skilui vibesec rea' },
  { label: 'Public APIs', hint: '2,335 free endpoints the agent can call', to: '/apis', icon: '⛁', keys: 'apis api public free endpoints data catalogue' },
  { label: 'REA', hint: 'reverse engineer anything', to: '/rea', icon: '⟲', keys: 'rea reverse engineer mcp morluto' },
  { label: 'Qoder', hint: 'field guide: cloud agents, ACP, CLI', to: '/qoder', icon: '◈', keys: 'qoder acp qodercli cloud agents field guide' },
  { label: 'Codex parity', hint: 'crate by crate, implemented or not', to: '/parity', icon: '◎', keys: 'parity codex crates map implemented gap' },
  { label: 'Evidence', hint: 'the reverse-engineering record', to: '/evidence', icon: '⌸', keys: 'evidence forensic reverse engineering proof' },
  { label: 'Bring your setup', hint: 'import Codex / Claude config', to: '/setup', icon: '⇪', keys: 'import setup config migrate toml codex claude' },
  { label: 'Settings', hint: 'providers, keys, data', to: '/settings', icon: '⚙', keys: 'settings keys providers api personalization' },
  { label: 'Install', hint: 'macOS app, iPhone app, home-screen', to: '/install', icon: '⤓', keys: 'install download macos ios iphone ipa dmg dmg desktop app pwa add to home screen' },
  { label: 'Model health', hint: 'which ids actually answer', to: '/model-health', icon: '♥', keys: 'model health latency rejected hide' },
  { label: 'Admin', hint: 'platform console', to: '/admin', icon: '◈', keys: 'admin users system keys' }
];

export function CommandPalette({ onClose, onNavigate }) {
  const [q, setQ] = useState('');
  const [skills, setSkills] = useState([]);
  const [sel, setSel] = useState(0);
  const inputRef = React.useRef(null);

  React.useEffect(() => { inputRef.current?.focus(); }, []);
  React.useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setSkills([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      import('./lib/api.js').then((m) => m.skillkit.resolve(term, { limit: 6 }))
        .then((r) => { if (alive) setSkills((r.matched || []).map((s) => ({ ...s, isSkill: true }))); })
        .catch(() => {});
    }, 140);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const dests = React.useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return PALETTE_DESTINATIONS.slice(0, 10);
    return PALETTE_DESTINATIONS
      .map((d) => {
        const hay = `${d.label} ${d.hint} ${d.keys}`.toLowerCase();
        let score = 0;
        if (d.label.toLowerCase().startsWith(term)) score += 10;
        if (d.label.toLowerCase().includes(term)) score += 5;
        if (d.keys.includes(term)) score += 3;
        for (const part of term.split(/\s+/)) if (hay.includes(part)) score += 1;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.d);
  }, [q]);

  const rows = React.useMemo(() => [
    ...dests.map((d) => ({ kind: 'dest', key: 'd:' + d.to + d.label, ...d })),
    ...skills.map((s) => ({ kind: 'skill', key: 's:' + s.slug, label: s.slug, hint: s.description?.slice(0, 90), to: `/skills?slug=${encodeURIComponent(s.slug)}`, icon: '✦' }))
  ], [dests, skills]);

  React.useEffect(() => { setSel(0); }, [q]);

  const choose = (row) => {
    if (!row) return;
    onNavigate(row.to);
    if (row.kind === 'skill') onClose?.();
  };

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose?.()} style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="modal" style={{ width: 'min(640px, 100%)', maxHeight: '70vh' }} role="dialog" aria-label="Command palette">
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s2) => Math.min(s2 + 1, rows.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s2) => Math.max(s2 - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); choose(rows[sel]); }
              if (e.key === 'Escape') onClose?.();
            }}
            placeholder="Jump to a page, or type what you need a skill for…"
            style={{ width: '100%', background: 'transparent', border: 0, color: 'var(--text)', fontSize: 15, outline: 'none' }}
          />
        </div>
        <div style={{ overflowY: 'auto', padding: 6 }}>
          {rows.length === 0 && <div className="empty">Nothing matches “{q}”.</div>}
          {rows.map((row, i) => (
            <button
              key={row.key}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(row)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 9, border: 0, cursor: 'pointer',
                background: i === sel ? 'var(--bg-elev-2)' : 'transparent', color: 'var(--text)'
              }}
            >
              <span style={{ width: 20, textAlign: 'center', opacity: .85 }}>{row.icon}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 550 }}>{row.label}{row.kind === 'skill' && <span className="pill" style={{ marginLeft: 8 }}>skill</span>}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.hint}</span>
              </span>
              {i === sel && <span className="kbd">↵</span>}
            </button>
          ))}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', padding: '7px 12px', display: 'flex', gap: 12, fontSize: 11.5, color: 'var(--muted)' }}>
          <span><span className="kbd">↑↓</span> move</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">esc</span> close</span>
          <span style={{ marginLeft: 'auto' }}>Skills search runs against the pinned atlas</span>
        </div>
      </div>
    </div>
  );
}

/** A row of key/value facts — the shape every evidence and status page uses. */
export function Facts({ items, cols }) {
  return (
    <div className="stat-row" style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` } : undefined}>
      {items.filter(Boolean).map((it) => (
        <div className="stat" key={it.k}>
          <div className="k">{it.k}</div>
          <div className="v" style={it.small ? { fontSize: 15, fontWeight: 600 } : undefined}>{it.v}</div>
          {it.d && <div className="d">{it.d}</div>}
        </div>
      ))}
    </div>
  );
}

/** Copy-to-clipboard line that looks like a field. */
export function CopyField({ value, label, mono = true }) {
  const [done, setDone] = useState(false);
  return (
    <div className="col" style={{ gap: 4 }}>
      {label && <span className="tiny" style={{ color: 'var(--muted)' }}>{label}</span>}
      <div className="row" style={{ gap: 6 }}>
        <code className={mono ? 'code-inline' : ''} style={{ flex: 1, overflowX: 'auto', whiteSpace: 'nowrap', padding: '6px 8px', background: 'var(--bg-input)', borderRadius: 8 }}>{value}</code>
        <button className="btn small" onClick={() => {
          try { navigator.clipboard?.writeText(String(value)); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* no clipboard */ }
        }}>{done ? '✓' : 'Copy'}</button>
      </div>
    </div>
  );
}

export function StatusPill({ status }) {
  const map = {
    parity: ['ok', 'implemented'], partial: ['warn', 'partial'], missing: ['err', 'missing'],
    live: ['ok', 'live'], 'needs-cli': ['warn', 'needs CLI'], external: ['info', 'external'],
    unrunnable: ['err', 'cannot run here'], pass: ['ok', 'pass'], review: ['warn', 'review'], block: ['err', 'block']
  };
  const [kind, label] = map[status] || ['', status || 'unknown'];
  return <span className={`pill ${kind}`}>{label}</span>;
}
