import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Logo } from '../ui.jsx';

function Card({ title, sub, children }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><Logo size={44} /></div>
        <h1>{title}</h1>
        <div className="sub">{sub}</div>
        {children}
      </div>
    </div>
  );
}

function ErrorLine({ error }) {
  return error ? <div className="badge err" style={{ display: 'block', padding: '9px 12px', margin: '10px 0' }}>{error}</div> : null;
}

export function LoginPage() {
  const { signIn, notify } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.auth.login({ email, password });
      if (r.ok === false) { setError(r.error || 'Sign-in failed'); return; }
      signIn(r.token, r.user);
      notify(`Welcome back, ${r.user?.name || r.user?.email}`);
      nav('/');
    } catch (e2) {
      setError(e2.data?.error || e2.message || 'Sign-in failed');
    } finally { setBusy(false); }
  }

  return (
    <Card title="Welcome back" sub="Sign in to ANTICODEX">
      <button className="oauth-btn" onClick={async () => {
        const r = await api.auth.github({ redirect_to: window.location.origin + '/' });
        if (r.url) window.location.href = r.url;
        else notify(r.message || 'GitHub sign-in needs setup in Supabase → Auth → Providers');
      }}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        Continue with GitHub
      </button>
      <div className="tiny" style={{ textAlign: 'center', margin: '6px 0 10px' }}>or</div>
      <form onSubmit={submit}>
        <div className="field">
          <label className="tiny">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </div>
        <div className="field">
          <label className="tiny">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </div>
        <ErrorLine error={error} />
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
        <button className="btn ghost" style={{ border: 0, background: 'transparent', color: 'var(--accent)' }} onClick={() => nav('/forgot')}>Forgot password?</button>
        <button className="btn ghost" style={{ border: 0, background: 'transparent', color: 'var(--accent)' }} onClick={() => nav('/signup')}>Create account</button>
      </div>
    </Card>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.auth.register({ name, email, password });
      if (r.ok === false) { setError(r.error || 'Could not create the account'); return; }
      sessionStorage.setItem('acx_pending_email', email);
      if (r.dev_code) sessionStorage.setItem('acx_dev_code', r.dev_code);
      nav('/verify');
    } catch (e2) {
      setError(e2.data?.error || e2.message || 'Could not create the account');
    } finally { setBusy(false); }
  }

  return (
    <Card title="Create your account" sub="We email you a 6-digit code to verify it's really you">
      <form onSubmit={submit}>
        <div className="field">
          <label className="tiny">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required />
        </div>
        <div className="field">
          <label className="tiny">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </div>
        <div className="field">
          <label className="tiny">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
        </div>
        <ErrorLine error={error} />
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <div className="tiny" style={{ textAlign: 'center', marginTop: 12 }}>
        Already have an account? <a onClick={() => nav('/login')} style={{ cursor: 'pointer' }}>Sign in</a>
      </div>
    </Card>
  );
}

export function VerifyPage() {
  const nav = useNavigate();
  const { notify } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const devCode = sessionStorage.getItem('acx_dev_code');
  const email = sessionStorage.getItem('acx_pending_email') || '';

  return (
    <Card title="Check your email" sub={`Enter the 6-digit code we sent to ${email || 'your inbox'}`}>
      <div className="field">
        <label className="tiny">Verification code</label>
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" style={{ letterSpacing: 6, textAlign: 'center', fontSize: 20 }} />
      </div>
      {devCode && <div className="badge warn" style={{ display: 'block', padding: '9px 12px' }}>Dev mode — your code is {devCode}</div>}
      <ErrorLine error={error} />
      <button className="btn primary" style={{ width: '100%' }} onClick={async () => {
        const r = await api.auth.verifyCode({ email, code, purpose: 'signup' }).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok === false) { setError(r.error || 'Invalid code'); return; }
        notify('Email verified — sign in now');
        nav('/login');
      }}>Verify email</button>
      <div className="tiny" style={{ textAlign: 'center', marginTop: 12 }}>
        Wrong address? <a onClick={() => nav('/signup')} style={{ cursor: 'pointer' }}>Start over</a>
      </div>
    </Card>
  );
}

export function ForgotPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState('');

  return (
    <Card title="Reset your password" sub="We email you a single-use 6-digit code">
      {!sent ? (
        <>
          <div className="field">
            <label className="tiny">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <button className="btn primary" style={{ width: '100%' }} onClick={async () => {
            const r = await api.auth.forgot({ email }).catch(() => ({}));
            if (r.dev_code) { setDevCode(r.dev_code); sessionStorage.setItem('acx_dev_code', r.dev_code); }
            sessionStorage.setItem('acx_pending_email', email);
            setSent(true);
          }}>Email me a reset code</button>
        </>
      ) : (
        <>
          <div className="badge ok" style={{ display: 'block', padding: '10px 12px', margin: '8px 0' }}>
            If that account exists, a 6-digit code is on its way.
          </div>
          {devCode && <div className="badge warn" style={{ display: 'block', padding: '9px 12px' }}>Dev mode — your code is {devCode}</div>}
          <button className="btn primary" style={{ width: '100%' }} onClick={() => nav('/reset')}>I have the code</button>
        </>
      )}
      <div className="tiny" style={{ textAlign: 'center', marginTop: 12 }}>
        <a onClick={() => nav('/login')} style={{ cursor: 'pointer' }}>Back to sign in</a>
      </div>
    </Card>
  );
}

export function ResetPage() {
  const nav = useNavigate();
  const { notify } = useApp();
  const [email, setEmail] = useState(() => sessionStorage.getItem('acx_pending_email') || '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  return (
    <Card title="Choose a new password" sub="Enter the code from your email and a new password">
      <div className="field">
        <label className="tiny">Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label className="tiny">Reset code</label>
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" style={{ letterSpacing: 5 }} />
      </div>
      <div className="field">
        <label className="tiny">New password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
      </div>
      <ErrorLine error={error} />
      <button className="btn primary" style={{ width: '100%' }} onClick={async () => {
        const r = await api.auth.reset({ email, code, new_password: password }).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok === false) { setError(r.error || 'Could not update the password'); return; }
        notify('Password updated — sign in');
        nav('/login');
      }}>Update password</button>
    </Card>
  );
}
