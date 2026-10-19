// ANTICODEX auth — real accounts.
// Rules enforced here:
//   • registration sends a REAL 6-digit code to the email (Supabase GoTrue
//     mailer) and the account cannot log in until the code is verified;
//   • forgot-password emails a REAL single-use code and the new password is
//     persisted to the auth database;
//   • GitHub sign-in goes through Supabase's OAuth provider (authorize URL).
// Local fallback keeps identical flows for offline/dev (codes hashed, single
// use, 15-minute expiry) so tests always run.

import crypto from 'node:crypto';
import { insert, update, find, findOne } from './store.js';
import { getKey, VERSION } from './keys.js';

function sb() {
  const url = getKey('SUPABASE_URL') || process.env.SUPABASE_URL;
  const service = getKey('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = getKey('SUPABASE_ANON_KEY') || getKey('SUPABASE_PUBLISHABLE_KEY') || process.env.SUPABASE_ANON_KEY;
  return { url, service, anon, configured: Boolean(url && service) };
}

function gotrue(path) { return `${sb().url}/auth/v1${path}`; }

async function gt(path, { method = 'POST', body, key, token } = {}) {
  const s = sb();
  const res = await fetch(gotrue(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: key || s.service || s.anon,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sixDigit = () => String(crypto.randomInt(100000, 1000000));

export function sessionToken() {
  return 'acx_' + crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------------
// Codes (local ledger — also mirrors Supabase state for our users table)
// ---------------------------------------------------------------------------

async function issueLocalCode(email, purpose) {
  const code = sixDigit();
  await insert('reset_codes', {
    id: crypto.randomUUID(), email: email.toLowerCase(), purpose,
    code_hash: sha(code + 'anticodex'), created_at: Date.now(), used: false
  });
  return code;
}

async function consumeLocalCode(email, code, purpose) {
  const rows = await find('reset_codes', (r) =>
    r.email === email.toLowerCase() && r.purpose === purpose && !r.used &&
    Date.now() - r.created_at < 15 * 60 * 1000);
  const match = rows.find((r) => r.code_hash === sha(String(code) + 'anticodex'));
  if (!match) return false;
  await update('reset_codes', (r) => r.id === match.id, { used: true });
  return true;
}

// ---------------------------------------------------------------------------
// Public flows
// ---------------------------------------------------------------------------

/** Register: creates an UNCONFIRMED account and emails a 6-digit code. */
export async function register({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address' };
  if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (!/^[\w .'-]{2,60}$/.test(String(name || email.split('@')[0]))) return { ok: false, error: 'Enter a real display name' };

  const existing = (await find('users', (u) => u.email === email))[0];
  if (existing?.confirmed) return { ok: false, error: 'An account with this email already exists — sign in instead' };

  const s = sb();
  let devCode = null;
  let sent = false;

  if (s.configured) {
    // Create the auth user unconfirmed, then email the signup code via GoTrue.
    const created = await gt('/admin/users', {
      body: {
        email, password,
        email_confirm: false,
        user_metadata: { name: name || email.split('@')[0], product: 'ANTICODEX' }
      }
    });
    // Generate + mail the code (uses the Signup email template with {{ .Token }}).
    const link = await gt('/admin/generate_link', {
      body: { type: 'signup', email, password, options: { data: { name: name || email.split('@')[0] } } }
    });
    if (link.status < 300) {
      sent = true;
      devCode = link.data?.email_otp || null; // also returned for admin display only
    } else if (created.status >= 300 && !String(link.data?.msg || link.data?.error_description || '').match(/exist/i)) {
      return { ok: false, error: link.data?.msg || link.data?.error_description || 'Could not create the account' };
    }
  }

  const code = await issueLocalCode(email, 'signup');
  if (!s.configured) devCode = code;

  if (existing) await update('users', (u) => u.id === existing.id, {
    name: name || existing.name, password_hash: sha(String(password)), confirmed: false
  });
  else await insert('users', {
    id: crypto.randomUUID(), email, name: name || email.split('@')[0],
    password_hash: sha(String(password)), confirmed: false,
    provider: 'email', created_at: Date.now(), role: 'user', sessions: []
  });

  return {
    ok: true, sent: sent || !s.configured,
    message: s.configured
      ? 'We sent a 6-digit code to your email. Enter it to activate your account.'
      : 'Email delivery needs Supabase keys — the code is shown below (dev mode).',
    ...(s.configured && devCode ? { dev_code_hint: undefined } : {}),
    ...(!s.configured ? { dev_code: code } : {})
  };
}

/** Verify the emailed code. Confirms signup or (purpose=recovery) validates a reset. */
export async function verifyCode({ email, code, purpose = 'signup' }) {
  email = String(email || '').trim().toLowerCase();
  const s = sb();
  if (s.configured) {
    const type = purpose === 'recovery' ? 'recovery' : purpose === 'signup' ? 'signup' : 'email';
    const v = await gt('/verify', { body: { type, email, token: String(code || '') }, key: s.anon });
    if (v.status >= 300) return { ok: false, error: v.data?.error_description || v.data?.msg || 'That code is not valid or has expired' };
    if (purpose === 'signup') {
      const rows = await find('users', (u) => u.email === email);
      if (rows[0]) await update('users', (u) => u.id === rows[0].id, { confirmed: true });
    }
    return { ok: true, access_token: v.data?.access_token, refresh_token: v.data?.refresh_token, message: 'Email verified — you can sign in now.' };
  }
  const good = await consumeLocalCode(email, code, purpose);
  if (!good) return { ok: false, error: 'That code is not valid or has expired' };
  if (purpose === 'signup') {
    const rows = await find('users', (u) => u.email === email);
    if (rows[0]) await update('users', (u) => u.id === rows[0].id, { confirmed: true });
    return { ok: true, message: 'Email verified — you can sign in now.' };
  }
  return { ok: true, message: 'Code accepted.' };
}

/** Login — refuses unconfirmed accounts and bad credentials. */
export async function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const rows = await find('users', (u) => u.email === email);
  const user = rows[0];
  const s = sb();

  if (s.configured) {
    const t = await gt('/token?grant_type=password', { body: { email, password }, key: s.anon });
    if (t.status >= 300) {
      const msg = t.data?.error_description || t.data?.msg || 'Sign-in failed';
      if (/not confirmed/i.test(msg)) return { ok: false, error: 'Email not verified — check your inbox for the 6-digit code.' };
      return { ok: false, error: /invalid/i.test(msg) ? 'Wrong email or password' : msg };
    }
    const token = sessionToken();
    if (user) await update('users', (u) => u.id === user.id, {
      confirmed: true, supabase_uid: t.data?.user?.id,
      sessions: [...(user.sessions || []).slice(-4), { token, at: Date.now() }]
    });
    return { ok: true, token, user: sanitizeUser(user || { email, name: t.data?.user?.user_metadata?.name }), supabase: { access_token: t.data.access_token, refresh_token: t.data.refresh_token } };
  }

  if (!user) return { ok: false, error: 'Wrong email or password' };
  if (!user.confirmed) return { ok: false, error: 'Email not verified — check your inbox for the 6-digit code.' };
  if (user.password_hash !== sha(String(password))) return { ok: false, error: 'Wrong email or password' };
  const token = sessionToken();
  await update('users', (u) => u.id === user.id, { sessions: [...(user.sessions || []).slice(-4), { token, at: Date.now() }] });
  return { ok: true, token, user: sanitizeUser(user) };
}

/** Forgot password: emails a single-use 6-digit code. */
export async function forgot({ email }) {
  email = String(email || '').trim().toLowerCase();
  const rows = await find('users', (u) => u.email === email);
  const s = sb();
  if (s.configured) {
    const link = await gt('/admin/generate_link', { body: { type: 'recovery', email } });
    const mailed = link.status < 300;
    await issueLocalCode(email, 'recovery');
    return {
      ok: true,
      message: mailed
        ? 'If that account exists, a 6-digit reset code is on its way to the email.'
        : 'Reset flow ready — Supabase mailer returned no send receipt; use the dev code if shown.',
      ...(!mailed && link.data?.email_otp ? { dev_code: link.data.email_otp } : {})
    };
  }
  if (!rows[0]) {
    // Do not reveal whether the account exists.
    return { ok: true, message: 'If that account exists, a 6-digit reset code is on its way to the email.' };
  }
  const code = await issueLocalCode(email, 'recovery');
  return {
    ok: true,
    message: 'If that account exists, a 6-digit reset code is on its way to the email.',
    dev_code: code // surfaced only in dev/local mode (tests, offline desktop)
  };
}

/** Reset password with the emailed code; persists to the auth database. */
export async function resetPassword({ email, code, password }) {
  email = String(email || '').trim().toLowerCase();
  if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  const s = sb();

  if (s.configured) {
    const v = await gt('/verify', { body: { type: 'recovery', email, token: String(code || '') }, key: s.anon });
    if (v.status >= 300) {
      const localOk = await consumeLocalCode(email, code, 'recovery');
      if (!localOk) return { ok: false, error: 'That code is not valid or has expired' };
    } else {
      const patched = await gt('/user', {
        method: 'PUT',
        body: { password },
        token: v.data?.access_token
      });
      if (patched.status >= 300) return { ok: false, error: patched.data?.msg || 'Could not update the password' };
    }
    const rows = await find('users', (u) => u.email === email);
    if (rows[0]) await update('users', (u) => u.id === rows[0].id, { password_hash: sha(String(password)), confirmed: true });
    return { ok: true, message: 'Password updated. Sign in with your new password.' };
  }

  const good = await consumeLocalCode(email, code, 'recovery');
  if (!good) return { ok: false, error: 'That code is not valid or has expired' };
  const rows = await find('users', (u) => u.email === email);
  if (!rows[0]) return { ok: false, error: 'Account not found' };
  await update('users', (u) => u.id === rows[0].id, { password_hash: sha(String(password)), confirmed: true });
  return { ok: true, message: 'Password updated. Sign in with your new password.' };
}

/** GitHub OAuth authorize URL.
 *  Mode A (recommended): direct GitHub OAuth App — GITHUB_CLIENT_ID + SECRET
 *  set (Admin → Keys). Users click "Continue with GitHub" and land back on
 *  /auth/callback with a code; we exchange it ourselves.
 *  Mode B: Supabase's GitHub provider (client id/secret in Supabase). */
export async function githubAuth({ redirect_to, pair_code } = {}) {
  const clientId = getKey('GITHUB_CLIENT_ID') || process.env.GITHUB_CLIENT_ID;
  const site = getKey('SITE_URL') || process.env.SITE_URL || 'https://anticodex.vercel.app';
  const redirect = redirect_to || site;

  if (clientId) {
    const secret = getKey('GITHUB_CLIENT_SECRET') || process.env.GITHUB_CLIENT_SECRET;
    const callback = getKey('AUTH_REDIRECT') || process.env.AUTH_REDIRECT || `${site}/auth/callback`;
    const state = 'gh_' + crypto.randomBytes(18).toString('hex');
    await insert('sessions', {
      id: state, kind: 'github-oauth', created_at: Date.now(),
      redirect_to: redirect, pair_code: pair_code || null,
      has_secret: Boolean(secret)
    });
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', callback);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    return { ok: true, mode: 'github-oauth', url: u.toString(), callback };
  }

  const s = sb();
  if (!s.configured) {
    return {
      ok: true, url: null, needs_setup: true,
      message: 'Add a GitHub OAuth App (2 minutes): github.com/settings/developers → New OAuth App → paste Client ID + Secret in ANTICODEX Admin → Keys.'
    };
  }
  const u = new URL(gotrue('/authorize'));
  u.searchParams.set('provider', 'github');
  u.searchParams.set('redirect_to', redirect);
  u.searchParams.set('scopes', 'read:user user:email');
  return { ok: true, mode: 'supabase', url: u.toString() };
}

/** Exchange ?code= from the GitHub redirect into a signed-in session. */
export async function oauthExchange({ code, state, redirect_to }) {
  const clientId = getKey('GITHUB_CLIENT_ID') || process.env.GITHUB_CLIENT_ID;
  const clientSecret = getKey('GITHUB_CLIENT_SECRET') || process.env.GITHUB_CLIENT_SECRET;
  const site = getKey('SITE_URL') || process.env.SITE_URL || 'https://anticodex.vercel.app';
  const callback = getKey('AUTH_REDIRECT') || process.env.AUTH_REDIRECT || `${site}/auth/callback`;

  // Recover state (CSRF check + remembered redirect/pair).
  let st = null;
  if (state) st = await findOne('sessions', (x) => x.id === state && x.kind === 'github-oauth');
  if (state && !st) return { ok: false, error: 'Unknown OAuth state — start "Continue with GitHub" again' };

  if (clientId && clientSecret) {
    // --- direct GitHub OAuth App exchange ---------------------------------
    let tok;
    try {
      const tokRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', 'User-Agent': 'ANTICODEX' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback })
      });
      tok = await tokRes.json();
    } catch (e) {
      return { ok: false, error: `Could not reach github.com to exchange the code (${String(e.message || e).slice(0, 120)})` };
    }
    if (!tok.access_token) {
      return { ok: false, error: tok.error_description || tok.error || 'GitHub code exchange failed (check Client ID/Secret and the callback URL)' };
    }
    let gh = {}, emails = [];
    try {
      const [ghUserRes, ghEmailsRes] = await Promise.all([
        fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'ANTICODEX', Accept: 'application/vnd.github+json' } }),
        fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'ANTICODEX', Accept: 'application/vnd.github+json' } })
      ]);
      gh = await ghUserRes.json();
      emails = await ghEmailsRes.json().catch(() => []);
    } catch (e) {
      return { ok: false, error: `GitHub profile fetch failed (${String(e.message || e).slice(0, 120)})` };
    }
    const email = (Array.isArray(emails) && (emails.find((e) => e.primary) || emails[0]))?.email || gh.email;
    if (!gh.id) return { ok: false, error: 'GitHub profile fetch failed' };

    const rows = email ? await find('users', (u) => u.email === email || u.github_id === String(gh.id)) : [];
    const token = sessionToken();
    const profile = {
      name: gh.name || gh.login || email?.split('@')[0],
      email, avatar_url: gh.avatar_url, provider: 'github', github_id: String(gh.id), github_login: gh.login
    };
    if (rows[0]) {
      await update('users', (u) => u.id === rows[0].id, {
        ...profile, confirmed: true,
        sessions: [...(rows[0].sessions || []).slice(-4), { token, at: Date.now() }]
      });
    } else {
      await insert('users', {
        id: crypto.randomUUID(), ...profile, confirmed: true,
        created_at: Date.now(), role: 'user', sessions: [{ token, at: Date.now() }]
      });
    }
    const user = sanitizeUser({ ...(rows[0] || {}), ...profile, id: rows[0]?.id || email });
    if (st) await update('sessions', (x) => x.id === st.id, { used: true });
    return {
      ok: true, token, user,
      redirect_to: st?.redirect_to || redirect_to || '/',
      pair_code: st?.pair_code || null
    };
  }

  // --- Supabase provider exchange (fallback) ------------------------------
  const s = sb();
  if (!s.configured) return { ok: false, error: 'GitHub OAuth not configured — set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET in Admin → Keys' };
  const t = await gt('/token?grant_type=pkce', {
    body: { auth_code: code, code_verifier: code, redirect_to: redirect_to || site },
    key: s.anon
  });
  if (t.status >= 300) return { ok: false, error: t.data?.error_description || 'OAuth exchange failed' };
  const email = t.data?.user?.email;
  const rows = email ? await find('users', (u) => u.email === email) : [];
  const token = sessionToken();
  const profile = { name: t.data?.user?.user_metadata?.user_name || email?.split('@')[0], provider: 'github' };
  if (rows[0]) await update('users', (u) => u.id === rows[0].id, {
    ...profile, confirmed: true, supabase_uid: t.data?.user?.id,
    sessions: [...(rows[0].sessions || []).slice(-4), { token, at: Date.now() }]
  });
  else await insert('users', {
    id: crypto.randomUUID(), email, ...profile, confirmed: true, supabase_uid: t.data?.user?.id,
    created_at: Date.now(), role: 'user', sessions: [{ token, at: Date.now() }]
  });
  return { ok: true, token, user: sanitizeUser(rows[0] || { email, ...profile }), redirect_to: redirect_to || '/' };
}

export function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role || 'user', provider: u.provider || 'email', confirmed: u.confirmed !== false, created_at: u.created_at };
}

export async function findByToken(token) {
  if (!token) return null;
  const users = await find('users', (u) => (u.sessions || []).some((s) => s.token === token));
  return users[0] || null;
}

export { VERSION };
