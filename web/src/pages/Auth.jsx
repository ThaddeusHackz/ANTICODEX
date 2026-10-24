import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Logo } from '../ui.jsx';

// ---------------------------------------------------------------------------
// ChatGPT-style auth screens: light canvas, centered column, one clear action.
// Sign-up with a plain email address signs you straight in; the emailed code
// stays available for servers that opt into verification.
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

/** Copyable list of steps for a half-configured GitHub OAuth app. */
function SetupSteps({ setup }) {
  const [copied, setCopied] = useState(false);
  if (!setup) return null;
  return (
    <div className="auth-note">
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Finish GitHub setup</div>
      <ol className="setup-steps">
        {(setup.steps || []).map((line, i) => <li key={i}>{line}</li>)}
      </ol>
      {setup.callback_url && (
        <button
          className="oauth-btn light"
          style={{ marginTop: 8 }}
          onClick={async () => {
            try { await navigator.clipboard.writeText(setup.callback_url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
          }}
        >{copied ? 'Copied ✓' : `Copy callback URL (${setup.callback_url})`}</button>
      )}
    </div>
  );
}

/**
 * Link an *already signed-in* browser to the desktop app that asked for it.
 *
 * The old flow only claimed the pairing code after a fresh sign-in, so somebody
 * who was already signed in on the website clicked "GitHub" in the app, landed
 * on /login?desktop=123456, got bounced straight to the chat by the route guard,
 * and the app waited five minutes for a code nothing ever claimed. If this tab
 * already holds a session, link it the moment the page loads.
 */
export function DesktopLinkHandler() {
  const { notify } = useApp();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('desktop');
    if (!code || code === 'local') return;
    const token = localStorage.getItem('acx_token');
    if (!token) return; // not signed in — the sign-in screens claim it instead
    let user = null;
    try { user = JSON.parse(localStorage.getItem('acx_user') || 'null'); } catch { /* ignore */ }
    let alive = true;
    (async () => {
      try {
        const out = await api.pairing.claim(code, user?.id, token, user);
        if (!alive) return;
        q.delete('desktop');
        const rest = q.toString();
        window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
        if (out?.ok !== false) notify(`This browser is signed in — linking ANTICODEX on your PC as ${user?.email || user?.name || 'you'}`);
      } catch { /* expired code: the desktop reports it in its own window */ }
    })();
    return () => { alive = false; };
  }, []);
  return null;
}

/**
 * `anticodex://pair?code=123456` — the website already claimed the code, so the
 * app only has to pick the session up. This also covers the cold-start case
 * (clicking the link launched the app) because main-process deep links are
 * queued until the renderer reports it has loaded.
 */
export function DesktopDeepLinkHandler() {
  const { signIn, notify } = useApp();
  useEffect(() => {
    const desk = typeof window !== 'undefined' ? window.anticodexDesktop : null;
    if (!desk?.onDeepLink) return;
    let alive = true;
    desk.onDeepLink(async (url) => {
      let code = null;
      try {
        const u = new URL(url);
        if (u.protocol !== 'anticodex:') return;
        if (u.hostname !== 'pair' && u.pathname.replace(/\//g, '') !== 'pair') return;
        code = u.searchParams.get('code');
      } catch { return; }
      if (!code || !alive) return;
      try {
        const r = await desk.pairWait(code);
        if (!alive) return;
        if (r?.ok) {
          signIn(r.token, r.user || {});
          notify(`Linked this app to ${r.user?.email || r.user?.name || 'your account'}${r.synced_keys ? ` — ${r.synced_keys} keys synced` : ''}`);
        } else {
          notify(r?.error || 'That link expired — click GitHub in the app to try again', 'warn');
        }
      } catch {
        notify('Could not finish linking — click GitHub in the app to try again', 'warn');
      }
    });
    return () => { alive = false; };
  }, []);
  return null;
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
        if (type === 'recovery' || type === 'magiclink' && !tokenHash) {
          sessionStorage.setItem('acx_reset_token', tokenHash || code);
          clean();
          nav('/reset', { replace: true });
          notify('Link opened — now choose your new password');
          return;
        }
        const r = await api.auth.verifyCode({
          email: sessionStorage.getItem('acx_pending_email') || '',
          token_hash: tokenHash || undefined,
          code: tokenHash ? undefined : code,
          purpose: 'signup'
        });
        clean();
        if (r.ok === false) {
          // The link was already used or expired. If an account was created we
          // can still let them in — sign-up is not gated by default.
          notify(r.message || 'That link expired — enter the 6-digit code instead', 'warn');
          nav('/verify', { replace: true });
          return;
        }
        if (r.token) {
          signIn(r.token, r.user || {});
          const pairCode = sessionStorage.getItem('acx_pair_code');
          if (pairCode) {
            try { await api.pairing.claim(pairCode, r.user?.id, r.token, r.user); sessionStorage.removeItem('acx_pair_code'); } catch { /* ignore */ }
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

/**
 * Hand this browser session to the desktop app that asked for it.
 *
 * The code can arrive three ways, and all three matter:
 *   * `explicitCode` — GitHub OAuth carries it inside the signed `state`, so the
 *     callback URL itself has no `?desktop=` on it. Dropping this return value is
 *     exactly the bug where the desktop app "opens, shows you signed in on the
 *     site, and never signs in itself": the site claimed nothing, and the app
 *     polled a pairing code nobody had used until it timed out.
 *   * `?desktop=<code>` — the email/password and signup screens.
 *   * sessionStorage — the same, remembered across those screens.
 */
async function claimDesktopPair(user, token, explicitCode) {
  const code = explicitCode || sessionStorage.getItem('acx_pair_code')
    || new URLSearchParams(window.location.search).get('desktop');
  if (!code) return null;
  try {
    const out = await api.pairing.claim(code, user?.id, token, user);
    sessionStorage.removeItem('acx_pair_code');
    return { ok: out?.ok !== false, code };
  } catch {
    // The GitHub exchange links the code the moment the signed OAuth state
    // carries one, so by the time the callback posts `claim` the row is already
    // used and the write is refused. Ask the code itself before calling this a
    // failure — otherwise the app looks unlinked while it is in fact linked.
    try {
      const st = await api.pairing.status(code);
      if (st?.claimed) { sessionStorage.removeItem('acx_pair_code'); return { ok: true, code, already: true }; }
    } catch { /* expired after all — the desktop reports it in its own window */ }
  }
  return null;
}

/**
 * GitHub sign-in. Never a dead click: when the app cannot hand off it renders
 * the exact remaining setup step instead of swallowing the click.
 */
function GitHubButton({ notify, signIn, nav, onSetup }) {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState('');

  async function start({ auto = false } = {}) {
    if (busy) return;
    setBusy(true); setError(''); setSetup(null);
    try {
      if (window.anticodexDesktop?.githubLogin) {
        try {
          const r = await window.anticodexDesktop.githubLogin();
          if (r?.ok === false) { setError(r.error || 'GitHub sign-in could not start on this device'); setBusy(false); return; }
          notify(r?.notice || 'Browser opened — finish GitHub sign-in there and this app links itself');
          if (r?.code && window.anticodexDesktop?.pairWait) {
            const done = await window.anticodexDesktop.pairWait(r.code);
            if (done?.token) {
              signIn(done.token, done.user || {});
              // Pairing copies this account's provider keys onto the machine, which
              // is the part people assume and never see confirmed — so say what
              // landed, and whether it is protected at rest.
              if (done.synced_keys) {
                notify(done.keys_encrypted
                  ? `Paired · ${done.synced_keys} provider key${done.synced_keys === 1 ? '' : 's'} copied to this device (encrypted with ${done.keychain || 'the OS keyring'})`
                  : `Paired · ${done.synced_keys} provider key${done.synced_keys === 1 ? '' : 's'} copied to this device — this OS gave the app no secure storage, so they are stored unprotected`);
              }
              nav('/');
            }
            else if (done?.error) setError(done.error);
          }
          setBusy(false);
          return;
        } catch (e) { setError(String(e.message || e)); setBusy(false); return; }
      }
      const q = new URLSearchParams(window.location.search);
      const r = await api.auth.github({
        redirect_to: window.location.origin + '/',
        pair_code: q.get('desktop') || sessionStorage.getItem('acx_pair_code') || undefined
      });
      if (r?.url) { window.location.assign(r.url); return; }
      if (r?.needs_setup || r?.setup) { setSetup(r?.setup || null); setError(r?.error || 'GitHub sign-in is not ready on this server yet.'); onSetup?.(r); }
      else setError(r?.error || 'GitHub sign-in is unavailable right now.');
    } catch (e) {
      setError(e?.data?.error || e?.message || 'GitHub sign-in is unavailable right now.');
    } finally { setBusy(false); }
  }

  // The desktop app links with ?provider=github so the browser finishes GitHub
  // without an extra click.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('provider') === 'github' && q.get('desktop')) start({ auto: true });
  }, []);

  return (
    <>
      <button className="oauth-btn light" disabled={busy} onClick={() => start()}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c.84-.24 1.24-.24 2.2-.82 1.53 1.04 2.2.82 2.2.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
        {busy ? 'Opening GitHub…' : 'Continue with GitHub'}
      </button>
      {error && <div className="auth-err">{error}</div>}
      <SetupSteps setup={setup} />
    </>
  );
}

export function LoginPage() {
  const { signIn, notify, signOut } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [q] = useSearchParams();
  useEffect(() => {
    if (q.get('desktop')) sessionStorage.setItem('acx_pair_code', q.get('desktop'));
    if (q.get('error')) setError(q.get('error'));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.auth.login({ email, password });
      if (r.ok === false) {
        setError(r.error || 'Sign-in failed');
        if (/not verified/i.test(r.error || '')) sessionStorage.setItem('acx_pending_email', email);
        if (/sign up|created with github/i.test(r.error || '')) sessionStorage.setItem('acx_pending_email', email);
        return;
      }
      signIn(r.token, r.user);
      await claimDesktopPair(r.user, r.token);
      notify(`Welcome back, ${r.user?.name || r.user?.email}`);
      nav('/');
    } catch (e2) {
      setError(e2.data?.error || e2.message || 'Sign-in failed — the server did not answer');
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
        <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required />
        <Err error={error} />
        <button className="auth-btn" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      </form>
      <div style={{ textAlign: 'right', marginTop: 10 }}>
        <a className="auth-link" onClick={() => { signOut?.(); nav('/forgot'); }}>Forgot your password?</a>
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
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [q] = useSearchParams();
  useEffect(() => { if (q.get('desktop')) sessionStorage.setItem('acx_pair_code', q.get('desktop')); }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setHint('');
    try {
      const r = await api.auth.register({ name, email, password });
      if (r.ok === false) {
        setError(r.error || 'Could not create the account');
        if (r.sign_in === '/login') setHint('Already have an account? Use Log in below.');
        return;
      }
      sessionStorage.setItem('acx_pending_email', email);
      if (r.dev_code) sessionStorage.setItem('acx_dev_code', r.dev_code);
      if (r.token) {
        // The account is live immediately — no waiting on an email.
        signIn(r.token, r.user || {});
        await claimDesktopPair(r.user, r.token);
        notify(r.message || 'Account ready — welcome to ANTICODEX');
        nav('/', { replace: true });
        return;
      }
      notify(r.message || 'Check your email to finish');
      nav('/verify');
    } catch (e2) {
      setError(e2.data?.error || e2.message || 'Could not create the account — the server did not answer');
    } finally { setBusy(false); }
  }

  return (
    <Shell foot={<>Already have an account? <a onClick={() => nav('/login')}>Log in</a></>}>
      <h1 className="auth-title">Create your account</h1>
      <p className="auth-sub">An email address and a password is all it takes</p>
      <GitHubButton notify={notify} signIn={signIn} nav={nav} />
      <div className="auth-divider"><span>or</span></div>
      <form onSubmit={submit}>
        <label className="auth-label">Your name</label>
        <input className="auth-input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" required minLength={2} />
        <label className="auth-label">Email address</label>
        <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
        <Err error={error} />
        {hint && <div className="auth-note ok">{hint}</div>}
        <button className="auth-btn" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
      <div className="auth-note" style={{ marginTop: 12 }}>
        Your chats sync to this account. We only email you if the owner turns on
        email verification.
      </div>
    </Shell>
  );
}

export function VerifyPage() {
  const nav = useNavigate();
  const { signIn, notify } = useApp();
  const [code, setCode] = useState(() => sessionStorage.getItem('acx_dev_code') || '');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const devCode = sessionStorage.getItem('acx_dev_code');
  const email = sessionStorage.getItem('acx_pending_email') || '';

  async function resend() {
    setBusy(true); setError('');
    try {
      const r = await api.auth.resend({ email, purpose: 'signup' });
      if (r.ok === false) { setError(r.error || 'Could not send a new code'); return; }
      if (r.dev_code) { sessionStorage.setItem('acx_dev_code', r.dev_code); setCode(r.dev_code); }
      setNote(r.message || 'A new code is on its way.');
    } catch (e) { setError(e.data?.error || e.message || 'Could not send a new code'); }
    finally { setBusy(false); }
  }

  return (
    <Shell>
      <h1 className="auth-title">Check your email</h1>
      <p className="auth-sub">
        Open the link we sent to <strong>{email || 'your inbox'}</strong>, or type the
        6-digit code below.
      </p>
      <label className="auth-label">Verification code</label>
      <input className="auth-input" value={code} onChange={(e) => setCode(e.target.value.trim().slice(0, 12))} placeholder="6-digit code"
        style={{ textAlign: 'center', letterSpacing: 6, fontSize: 18 }} />
      {devCode && <div className="auth-note">This server has no email delivery, so your code is <strong>{devCode}</strong> — it is filled in for you.</div>}
      {note && <div className="auth-note ok">{note}</div>}
      <Err error={error} />
      <button className="auth-btn" disabled={busy || !code} onClick={async () => {
        setBusy(true); setError('');
        const r = await api.auth.verifyCode({ email, code, purpose: 'signup' }).catch((e) => ({ ok: false, error: e.data?.error || e.message }));
        setBusy(false);
        if (r.ok === false) { setError(r.error || 'Invalid code'); return; }
        if (r.token) {
          signIn(r.token, r.user || {});
          await claimDesktopPair(r.user, r.token);
          sessionStorage.removeItem('acx_dev_code');
          notify('Email verified — welcome to ANTICODEX');
          nav('/', { replace: true });
        } else { notify('Email verified — sign in'); nav('/login', { replace: true }); }
      }}>{busy ? 'Verifying…' : 'Verify email'}</button>
      <button className="oauth-btn light" disabled={busy} onClick={resend}>Send me a new code</button>
      <div className="auth-foot">
        <a onClick={() => nav('/login')}>Sign in instead</a> · <a onClick={() => nav('/signup')}>Start over</a>
      </div>
    </Shell>
  );
}

export function ForgotPage() {
  const nav = useNavigate();
  const { notify } = useApp();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await api.auth.forgot({ email }).catch((e) => ({ ok: false, error: e.data?.error || e.message }));
      if (r.ok === false) { setError(r.error || 'Could not start a reset'); return; }
      if (r.dev_code) { setDevCode(r.dev_code); sessionStorage.setItem('acx_dev_code', r.dev_code); }
      sessionStorage.setItem('acx_pending_email', email);
      setMessage(r.message || 'If that account exists, a reset code is on its way.');
      setSent(true);
    } finally { setBusy(false); }
  }

  return (
    <Shell foot={<a onClick={() => nav('/login')}>Back to log in</a>}>
      <h1 className="auth-title">Reset your password</h1>
      <p className="auth-sub">Enter your email and we'll send you a reset code</p>
      {!sent ? (
        <>
          <label className="auth-label">Email address</label>
          <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          <Err error={error} />
          <button className="auth-btn" disabled={busy || !email} onClick={submit}>{busy ? 'Sending…' : 'Send reset code'}</button>
        </>
      ) : (
        <>
          <div className="auth-note ok">{message}</div>
          {devCode && <div className="auth-note">Your one-time code is <strong>{devCode}</strong> — it expires in 15 minutes.</div>}
          {error && <Err error={error} />}
          <button className="auth-btn" onClick={() => nav('/reset')}>I have the code / link</button>
          <button className="oauth-btn light" disabled={busy} onClick={submit}>Send another code</button>
        </>
      )}
    </Shell>
  );
}

export function ResetPage() {
  const nav = useNavigate();
  const { notify, signOut } = useApp();
  const [email, setEmail] = useState(() => sessionStorage.getItem('acx_pending_email') || '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const linkToken = sessionStorage.getItem('acx_reset_token');
  const devCode = sessionStorage.getItem('acx_dev_code');

  return (
    <Shell>
      <h1 className="auth-title">Choose a new password</h1>
      <p className="auth-sub">{linkToken ? 'Your email is verified — pick a new password' : 'Enter the code from the email and your new password'}</p>
      {!linkToken && <>
        <label className="auth-label">Email address</label>
        <input className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <label className="auth-label">Reset code</label>
        <input className="auth-input" value={code} onChange={(e) => setCode(e.target.value.trim().slice(0, 12))} placeholder="Code from the email" style={{ textAlign: 'center', letterSpacing: 5 }} />
        {devCode && (
          <div className="auth-note">
            Your code is <strong>{devCode}</strong>. <a className="auth-link" onClick={() => setCode(devCode)}>Use it</a>
          </div>
        )}
      </>}
      <label className="auth-label">New password</label>
      <input className="auth-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} />
      <Err error={error} />
      <button className="auth-btn" disabled={busy || (!linkToken && !code)} onClick={async () => {
        setBusy(true);
        const r = await api.auth.reset({
          email, code: linkToken ? undefined : code,
          token_hash: linkToken || undefined,
          new_password: password
        }).catch((e) => ({ ok: false, error: e.data?.error || e.message }));
        setBusy(false);
        if (r.ok === false) { setError(r.error || 'Could not update the password'); return; }
        sessionStorage.removeItem('acx_reset_token');
        sessionStorage.removeItem('acx_dev_code');
        signOut?.();          // every other device has to sign in again
        notify('Password updated — sign in');
        nav('/login', { replace: true });
      }}>{busy ? 'Updating…' : 'Update password'}</button>
      <div className="auth-foot"><a onClick={() => nav('/forgot')}>Need another code?</a></div>
    </Shell>
  );
}

export function CallbackPage() {
  const nav = useNavigate();
  const { signIn, notify } = useApp();
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('desktop')) sessionStorage.setItem('acx_pair_code', q.get('desktop'));
    const denied = q.get('error');
    if (denied) { setError(q.get('error_description') || 'GitHub authorization was cancelled'); return; }
    const code = q.get('code'); const state = q.get('state');
    if (!code) { setError('No authorization code in the callback URL — start “Continue with GitHub” again.'); return; }
    api.auth.oauthCallback({ code, state }).then(async (r) => {
      if (r.ok === false) { setError(r.error || 'GitHub sign-in failed'); setSetup(r.setup || null); return; }
      signIn(r.token, r.user);
      const linked = await claimDesktopPair(r.user, r.token, r.pair_code);
      sessionStorage.removeItem('acx_pair_code');
      notify(linked
        ? `Signed in as ${r.user?.name || r.user?.email} — handing this session to ANTICODEX on your PC`
        : `Signed in as ${r.user?.name || r.user?.email}`);
      window.history.replaceState({}, '', '/');
      nav('/', { replace: true });
    }).catch((e) => setError(e?.data?.error || e.message || 'GitHub sign-in failed'));
  }, []);
  return (
    <Shell>
      <h1 className="auth-title">{error ? 'GitHub sign-in did not finish' : 'Signing you in…'}</h1>
      <p className="auth-sub">{error ? 'You can try again, or use your email address' : 'Completing GitHub authorization'}</p>
      {error
        ? (
          <>
            <div className="auth-err">{error}</div>
            <SetupSteps setup={setup} />
            <button className="oauth-btn light" onClick={() => nav('/login')}>Back to sign in</button>
          </>
        )
        : <div className="typing" style={{ display: 'flex', justifyContent: 'center' }}><i /><i /><i /></div>}
    </Shell>
  );
}
