import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Brand, Field } from '../ui.jsx';

function Shell({ title, subtitle, children }) {
  return (
    <div className="auth-shell">
      <div className="auth-card spark">
        <Brand />
        <h2>{title}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn, notify } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [ghNote, setGhNote] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await auth.login({ email, password });
      signIn(r.token, r.user);
      notify(`Welcome back, ${r.user.name}`);
      nav('/');
    } catch (e2) {
      notify(e2.message || 'Sign-in failed', 'error');
    } finally { setBusy(false); }
  }

  async function github() {
    try {
      const r = await auth.github();
      if (r.url) { window.location.href = r.url; return; }
      setGhNote(r.note || 'GitHub OAuth is not configured yet. Set GITHUB_CLIENT_ID/SECRET in Admin → Keys.');
    } catch (e2) { setGhNote(String(e2.message || e2)); }
  }

  return (
    <Shell title="Sign in to ANTICODEX" subtitle="Your universal AI workspace — chat, code, connectors, media, computer-use.">
      <button className="btn" style={{ width: '100%', marginBottom: 10 }} onClick={github}>⌥ Continue with GitHub</button>
      {ghNote && <div className="tiny" style={{ marginBottom: 10 }}>{ghNote}</div>}
      <div className="row" style={{ margin: '10px 0' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
        <span className="tiny">or with email</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
      </div>
      <form onSubmit={submit}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" /></Field>
        <Field label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="row between" style={{ marginTop: 14 }}>
        <Link to="/forgot" className="tiny">Forgot password?</Link>
        <Link to="/signup" className="tiny">Create account →</Link>
      </div>
    </Shell>
  );
}

export function SignupPage() {
  const { signIn, notify } = useApp();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await auth.register({ name, email, password });
      signIn(r.token, r.user);
      notify('Account created — welcome to ANTICODEX');
      nav('/');
    } catch (e2) {
      notify(e2.message || 'Sign-up failed', 'error');
    } finally { setBusy(false); }
  }

  return (
    <Shell title="Create your account" subtitle="Free, instant, works with GitHub or any email.">
      <form onSubmit={submit}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" /></Field>
        <Field label="Password" hint="Minimum 6 characters."><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} placeholder="••••••••" /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <div style={{ marginTop: 14 }}><Link to="/login" className="tiny">← Back to sign in</Link></div>
    </Shell>
  );
}

export function ForgotPage() {
  const { notify } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await auth.forgot({ email });
      setSent(r);
      notify('Reset code sent to your email');
    } catch (e2) { notify(e2.message || 'Request failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Shell title="Reset your password" subtitle="We will email you a 6-digit verification code.">
      <form onSubmit={submit}>
        <Field label="Account email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Sending code…' : 'Send verification code'}</button>
      </form>
      {sent && (
        <div className="card spark" style={{ marginTop: 14 }}>
          <div className="row"><span className="pill ok">code sent</span></div>
          <p className="muted" style={{ marginBottom: 6 }}>Enter the 6-digit code from your email to set a new password.</p>
          {sent.dev_code && (
            <p className="tiny">Demo delivery: your code is <span className="kbd">{sent.dev_code}</span> (also stored in the mail outbox table).</p>
          )}
          <button className="btn small" onClick={() => nav(`/reset?email=${encodeURIComponent(email)}`)}>I have the code →</button>
        </div>
      )}
    </Shell>
  );
}

export function ResetPage() {
  const { notify } = useApp();
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState(params.get('email') || '');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.reset({ email, code, new_password: pw });
      notify('Password updated — sign in with your new password');
      nav('/login');
    } catch (e2) { notify(e2.message || 'Reset failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Shell title="Enter verification code" subtitle="The code expires 15 minutes after it was sent.">
      <form onSubmit={submit}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="6-digit code"><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required placeholder="000000" inputMode="numeric" /></Field>
        <Field label="New password"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={6} placeholder="••••••••" /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
      </form>
      <div style={{ marginTop: 14 }}><Link to="/forgot" className="tiny">← Send a new code</Link></div>
    </Shell>
  );
}
