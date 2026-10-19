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
    <div className="brand">
      <Logo size={small ? 26 : 32} />
      <b>ANTI<span>CODEX</span></b>
    </div>
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
