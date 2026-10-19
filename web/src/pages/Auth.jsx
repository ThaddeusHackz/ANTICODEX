import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Logo } from '../ui.jsx';

// ---------------------------------------------------------------------------
// ChatGPT-style auth screens: light canvas, centered column, one clear action.
// Handles the full email lifecycle: code entry AND click-the-link (token_hash).
// ---------------------------------------------------------------------------

function Shell({ children, foot }) {
  return (
    <div className="auth-shell">
      <div className="auth-col">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <Logo size={52} />
        </div>
        {children}
        {foot && <div className="auth-foot">{foot}</div>}
      </div>
    </div>
  );
}

function Err({ error }) {
  return error ? <div className="auth-err">{error}</div> : null;
}

/** Handles email links (token_hash/type or code) landing back on the app. */
export function EmailLinkHandler() {
  const { signIn, notify } = useApp();
  const nav = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tokenHash = q.get('token_hash') || q.get('token');
    const code = q.get('code');
    const type = q.get('type') || q.get('token_type');
    const pair = q.get('desktop');
    if (pair) sessionStorage.setItem('acx_pair_code', pair);
    if (!tokenHash && !(code && (type === 'signup' || type === 'recovery' || type === 'magiclink'))) return;

    const clean = () => window.history.replaceState({}, '', window.location.pathname);
    const run = async () => {
      try {
        if (type === 'recovery') {
          sessionStorage.setItem('acx_reset_token', tokenHash || code);
          clean();
          nav('/reset', { replace: true });
          notify('Open the link — now choose your new password');
          return;
        }
        const r = await api.auth.verifyCode({
          email: sessionStorage.getItem('acx_pending_email') || '',
          token_hash: tokenHash || undefined,
          code: tokenHash ? undefined : code,
          purpose: 'signup'
        });
        clean();
        if (r.ok === false) { nav('/verify', { replace: true }); return; }
        if (r.token) {
          signIn(r.token, r.user || {});
          const pairCode = sessionStorage.getItem('acx_pair_code');
          if (pairCode) {
            try { await api.pairing.claim(pairCode, r.user?.id, r.token, r.user); sessionStorage.removeItem('acx_pair_code'); } catch {}
          }
          notify('Email verified — welcome to ANTICODEX');
          nav('/', { replace: true });
        } else {
          notify('Email verified — sign in to continue');
          nav('/login', { replace: true });
        }
      } catch {
        nav('/verify', { replace: true });
      }
    };
    run();
  }, []);
  return null;
}

async function claimDesktopPair(user, token) {
  const code = sessionStorage.getItem('acx_pair_code');
  if (!code) return;
  try {
    await api.pairing.claim(code, user?.id, token, user);
    sessionStorage.removeItem('acx_pair_code');
  } catch { /* expired — harmless */ }
}

function GitHubButton({ notify, signIn, nav }) {
  return (
    <button className="oauth-btn light" onClick={async () => {
      if (window.anticodexDesktop?.githubLogin) {
        try {
          const r = await window.anticodexDesktop.githubLogin();
          notify('Browser opened — sign in with GitHub and the app links automatically');
          if (r?.code && window.anticodexDesktop?.pairWait) {
            const done = await window.anticodexDesktop.pairWait(r.code);
            if (done?.token) { signIn(done.token, done.user || {}); nav('/'); }
          }
          return;
        } catch (e) { notify(String(e.message || e)); return; }
      }
      const q = new URLSearchParams(window.location.search);
      const r = await api.auth.github({
        redirect_to: window.location.origin + '/',
        pair_code: q.get('desktop') || sessionStorage.getItem('acx_pair_code') || undefined
      });
      if (r.url) window.location.href = r.url;
      else notify(r.message || 'GitHub sign-in needs setup — see Admin → Keys');
    }}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      Continue with GitHub
    </button>
  );
}

export function LoginPage() {
  const { signIn, notify } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('desktop')) sessionStorage.setItem('acx_pair_code', q.get('desktop'));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.auth.login({ email, password });
      if (r.ok === false) {
        setError(r.error || 'Sign-in failed');
        if (/not verified/i.test(r.error || '')) sessionStorage.setItem('acx_pending_email', email);
        return;
      }
      signIn(r.token, r.user);
      await claimDesktopPair(r.user, r.token);
      notify(`Welcome back, ${r.user?.name || r.user?.email}`);
      nav('/');
    } catch (e2) {
      setError(e2.data?.error || e2.message || 'Sign-in failed');
    } finally { setBusy(false); }
  }

  return (
    <Shell foot={<>Don't have an account? <a onClick={() => nav('/signup')}>Sign up</a></>}>
      <h1 className="auth-title">Welcome back</h1>
      <p className="auth-sub">Sign in to ANTICODEX</p>
      <GitHubButton notify={notify} signIn={signIn} nav={nav} />
      <div className="auth-divider"><span>or</span></div>
      <form onSubmit={submit}>
        <label className="auth-label">Email address</label>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required />
        <Err error={error} />
        <button className="auth-btn" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      </form>
      <div style={{ textAlign: 'right', marginTop: 10 }}>
        <a className="auth-link" onClick={() => nav('/forgot')}>Forgot your password?</a>
      </div>
    </Shell>
  );
}

export function SignupPage() {
  const { notify } = useApp();
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
    <Shell foot={<>Already have an account? <a onClick={() => nav('/login')}>Log in</a></>}>
      <h1 className="auth-title">Create your account</h1>
      <p className="auth-sub">We'll send a verification link to your email</p>
      <GitHubButton notify={notify} signIn={() => {}} nav={nav} />
      <div className="auth-divider"><span>or</span></div>
      <form onSubmit={submit}>
        <label className="auth-label">Your name</label>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" required />
        <label className="auth-label">Email address</label>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
        <Err error={error} />
        <button className="auth-btn" disabled={busy}>{busy ? 'Creating account…' : 'Continue'}</button>
      </form>
    </Shell>
  );
}

export function VerifyPage() {
  const nav = useNavigate();
  const { signIn, notify } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const devCode = sessionStorage.getItem('acx_dev_code');
  const email = sessionStorage.getItem('acx_pending_email') || '';

  return (
    <Shell>
      <h1 className="auth-title">Check your email</h1>
      <p className="auth-sub">
        We sent a verification link to <strong>{email || 'your inbox'}</strong>.
        Click the button in the email — or enter the code here if one is shown.
      </p>
      <label className="auth-label">Verification code</label>
      <input className="auth-input" value={code} onChange={(e) => setCode(e.target.value.trim().slice(0, 12))} placeholder="Code from the email"
        style={{ textAlign: 'center', letterSpacing: 6, fontSize: 18 }} />
      {devCode && <div className="auth-note">Dev mode — your code is <strong>{devCode}</strong></div>}
      <Err error={error} />
      <button className="auth-btn" disabled={busy || !code} onClick={async () => {
        setBusy(true);
        const r = await api.auth.verifyCode({ email, code, purpose: 'signup' }).catch((e) => ({ ok: false, error: e.message }));
        setBusy(false);
        if (r.ok === false) { setError(r.error || 'Invalid code'); return; }
        if (r.token) {
          signIn(r.token, r.user || {});
          await claimDesktopPair(r.user, r.token);
          notify('Email verified — welcome to ANTICODEX');
          nav('/', { replace: true });
        } else { notify('Email verified — sign in'); nav('/login', { replace: true }); }
      }}>{busy ? 'Verifying…' : 'Verify email'}</button>
      <div className="auth-foot">
        Wrong address? <a onClick={() => nav('/signup')}>Start over</a>
      </div>
    </Shell>
  );
}

export function ForgotPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState('');

  return (
    <Shell foot={<a onClick={() => nav('/login')}>Back to log in</a>}>
      <h1 className="auth-title">Reset your password</h1>
      <p className="auth-sub">Enter your email and we'll send you a reset link</p>
      {!sent ? (
        <>
          <label className="auth-label">Email address</label>
          <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button className="auth-btn" onClick={async () => {
            const r = await api.auth.forgot({ email }).catch(() => ({}));
            if (r.dev_code) { setDevCode(r.dev_code); sessionStorage.setItem('acx_dev_code', r.dev_code); }
            sessionStorage.setItem('acx_pending_email', email);
            setSent(true);
          }}>Continue</button>
        </>
      ) : (
        <>
          <div className="auth-note ok">If that account exists, a reset link is on its way to <strong>{email}</strong>.</div>
          {devCode && <div className="auth-note">Dev mode — your code is <strong>{devCode}</strong></div>}
          <button className="auth-btn" onClick={() => nav('/reset')}>I have the code / link</button>
        </>
      )}
    </Shell>
  );
}

export function ResetPage() {
  const nav = useNavigate();
  const { notify } = useApp();
  const [email, setEmail] = useState(() => sessionStorage.getItem('acx_pending_email') || '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const linkToken = sessionStorage.getItem('acx_reset_token');

  return (
    <Shell>
      <h1 className="auth-title">Choose a new password</h1>
      <p className="auth-sub">{linkToken ? 'Your email is verified — pick a new password' : 'Enter the code from the email and your new password'}</p>
      {!linkToken && <>
        <label className="auth-label">Email address</label>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="auth-label">Reset code</label>
        <input className="auth-input" value={code} onChange={(e) => setCode(e.target.value.trim().slice(0, 12))} placeholder="Code from the email" style={{ textAlign: 'center', letterSpacing: 5 }} />
      </>}
      <label className="auth-label">New password</label>
      <input className="auth-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
      <Err error={error} />
      <button className="auth-btn" disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await api.auth.reset({
          email, code: linkToken ? undefined : code,
          token_hash: linkToken || undefined,
          new_password: password
        }).catch((e) => ({ ok: false, error: e.message }));
        setBusy(false);
        if (r.ok === false) { setError(r.error || 'Could not update the password'); return; }
        sessionStorage.removeItem('acx_reset_token');
        notify('Password updated — sign in');
        nav('/login', { replace: true });
      }}>{busy ? 'Updating…' : 'Update password'}</button>
    </Shell>
  );
}

export function CallbackPage() {
  const nav = useNavigate();
  const { signIn, notify } = useApp();
  const [error, setError] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('desktop')) sessionStorage.setItem('acx_pair_code', q.get('desktop'));
    const code = q.get('code'); const state = q.get('state');
    if (!code) { setError('No authorization code in the callback URL'); return; }
    api.auth.oauthCallback({ code, state }).then(async (r) => {
      if (r.ok === false) { setError(r.error || 'GitHub sign-in failed'); return; }
      signIn(r.token, r.user);
      await claimDesktopPair(r.user, r.token);
      notify(`Signed in as ${r.user?.name || r.user?.email}`);
      nav('/', { replace: true });
    }).catch((e) => setError(e.message || 'GitHub sign-in failed'));
  }, []);
  return (
    <Shell>
      <h1 className="auth-title">Signing you in…</h1>
      <p className="auth-sub">Completing GitHub authorization</p>
      {error
        ? <div className="auth-err">{error} — <a className="auth-link" onClick={() => nav('/login')}>back to sign in</a></div>
        : <div className="typing" style={{ display: 'flex', justifyContent: 'center' }}><i /><i /><i /></div>}
    </Shell>
  );
}
