// ANTICODEX auth — real accounts, and a sign-in path that always works.
//
// Rules enforced here (these are what fix the "This endpoint requires a valid
// Bearer token" sign-up failure, the dead GitHub button and the silent
// forgot-password):
//
//  1. The ANTICODEX account ledger (public.users in Supabase, data/db.json
//     offline/desktop) is the SOURCE OF TRUTH for signing in. Supabase Auth is
//     a best-effort mirror: if it is unreachable, mis-keyed, rate limited or
//     has no SMTP configured, sign up and sign in STILL succeed.
//  2. GoTrue's /admin/* endpoints authenticate with
//     `Authorization: Bearer <service key>` — the key in `apikey` alone is not
//     enough (that was the exact 401 the browser showed). We send both headers
//     for legacy JWT keys and only `apikey` for the new sb_* keys (those are
//     not JWTs). Public endpoints (/signup, /recover, /token, /verify) need
//     just the anon key, so user-facing flows use those first.
//  3. Passwords are salted scrypt hashes locally. Legacy unsalted SHA-256
//     rows still verify and are upgraded on the next good sign-in.
//  4. Email verification is optional (set REQUIRE_EMAIL_VERIFICATION=true to
//     gate it). Codes always carry an expiry so they can never be silently
//     dropped by a NOT NULL column.
//  5. Provider internals are never shown to a user: GoTrue/Kong/GitHub noise
//     is translated by humanize() into something actionable.
//  6. GitHub sign-in rides a self-contained signed `state`, so it survives
//     stateless serverless deployments even when no session row was written.
//  7. The owner account (OWNER_EMAIL/OWNER_PASSWORD) can always sign in to
//     the web app and the desktop app, even if the database is wiped. The
//     admin CONSOLE keeps its own separate credentials (ADMIN_USERNAME /
//     ADMIN_PASSWORD) — those are untouched by anything in this file.

import crypto from 'node:crypto';
import { insert, update, updateById, find, findOne, findWhere } from './store.js';
import { getKey, VERSION } from './keys.js';

const PEPPER = 'anticodex';
const CODE_TTL_MS = 15 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_NOREPLY = (login) => `${String(login).toLowerCase()}@users.noreply.github.com`;

const val = (name) => String(getKey(name) || process.env[name] || '').trim();
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const off = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());

// ---------------------------------------------------------------------------
// Supabase access
// ---------------------------------------------------------------------------

export function supabaseInfo() {
  const url = String(val('SUPABASE_URL') || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const service = val('SUPABASE_SERVICE_ROLE_KEY') || val('SUPABASE_SECRET_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = val('SUPABASE_ANON_KEY') || val('SUPABASE_PUBLISHABLE_KEY') || process.env.SUPABASE_ANON_KEY;
  return {
    url, service, anon,
    // `hasAuth` is enough for every user-facing flow (signup/recover/verify/
    // token). `hasRest` additionally unlocks the admin mirror (password sync).
    hasAuth: Boolean(url && anon),
    hasService: Boolean(url && service),
    configured: Boolean(url && anon)
  };
}

/** Legacy keys are JWTs and double as bearer tokens; sb_* keys must stay in
 *  the `apikey` header only — sending them as a Bearer fails JWT validation. */
function keyKind(key) {
  if (!key) return 'none';
  return /^sb_/i.test(key) ? 'apikey' : 'jwt';
}

function gotrue(path) { return `${supabaseInfo().url}/auth/v1${path}`; }

/**
 * GoTrue call that can never throw and never blocks a sign-in.
 * `admin: true` adds the Bearer service key (only when the key is a JWT).
 * `token` overrides it with a user access token.
 */
async function gt(path, { method = 'POST', body, key, token, admin = false, timeout = 6000 } = {}) {
  const s = supabaseInfo();
  if (!s.url) return { status: 0, data: {}, skipped: 'no-supabase' };
  const anon = s.anon || s.service;
  if (!anon && !s.service) return { status: 0, data: {}, skipped: 'no-key' };
  const headers = { 'Content-Type': 'application/json', apikey: key || anon };
  const bearer = token
    ? String(token)
    : (admin && keyKind(s.service) === 'jwt' ? s.service : (admin ? '' : ''));
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  try {
    const res = await fetch(gotrue(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: String(text).slice(0, 300) } }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: {}, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Error translation — provider internals never reach the browser
// ---------------------------------------------------------------------------

const PROVIDER_NOISE = [
  /bearer token/i, /no_authorization/i, /api ?key/i, /\bjwt\b/i, /unauthorized/i,
  /rate limit|over_edge_rate_limit|too many/i, /schema cache|does not exist|not null|null value in/i,
  /duplicate key|violates row level/i, /fetch failed|failed to fetch|aborted|timeout/i,
  /enotfound|econnrefused|eai_again|econnreset|epipe|socket hang up/i, /read-only file system|EROFS/i,
  /cloudflare|kong|gateway/i, /^\W*$/
];

/** Turn a provider error body into a sentence the user can act on. */
export function humanize(err, fallback = 'That did not work — try again.') {
  const raw = String(
    (err && (err.msg || err.error_description || err.error || err.message || err.hint)) || err || ''
  ).trim();
  if (!raw) return fallback;
  if (/invalid login credentials|invalid credentials|bad password/i.test(raw)) return 'Wrong email or password';
  if (/email not confirmed|not confirmed|confirm your email/i.test(raw)) return 'EMAIL_NOT_CONFIRMED';
  if (/signup is disabled|signups? .*(disabled|not allowed)/i.test(raw)) return 'New sign-ups are disabled on this server';
  if (/password should be at least|does not meet a password/i.test(raw)) return 'That password is too weak for the auth provider (pick a longer one)';
  if (/email rate limit|too many emails/i.test(raw)) return 'The email service is rate limited right now — we will send another code shortly';
  if (PROVIDER_NOISE.some((re) => re.test(raw))) return fallback;
  return raw.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sixDigit = () => String(crypto.randomInt(100000, 1000000));

function scryptHash(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `v1$${salt.toString('hex')}$${hash}`;
}

function safeEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function hashPassword(password) { return scryptHash(password); }

/** Verifies a password against a v1 scrypt hash or a legacy SHA-256 hash. */
export function verifyPassword(password, stored) {
  const s = String(stored || '');
  if (!s) return false;
  if (s.startsWith('v1$')) {
    const [, salt, hash] = s.split('$');
    if (!salt || !hash) return false;
    try { return safeEq(scryptHash(password, Buffer.from(salt, 'hex')), s); } catch { return false; }
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return safeEq(sha(String(password)), s); // legacy
  return false;
}

const isLegacyHash = (stored) => /^[0-9a-f]{64}$/i.test(String(stored || ''));

export function sessionToken() {
  return 'acx_' + crypto.randomBytes(24).toString('hex');
}

/** Public origin for callback/redirect URLs. A local request origin (dev server,
 *  desktop app, sandbox preview) always wins over the baked SITE_URL, otherwise
 *  the OAuth `redirect_uri` would not match what GitHub has on file. */
function publicSite(origin) {
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|(\d+\.){3}\d+)(:\d+)?$/i;
  if (origin && local.test(origin)) return String(origin).replace(/\/+$/, '');
  const site = val('SITE_URL') || origin || 'https://anticodex.vercel.app';
  return String(site).replace(/\/+$/, '');
}

function emailOk(email) { return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(email || '')); }
function nameOk(name) { return /^[\w .'-]{2,60}$/.test(String(name || '')); }

// ---------------------------------------------------------------------------
// Owner / bootstrap accounts
// ---------------------------------------------------------------------------

/** The second admin: an ordinary ANTICODEX sign-in (web + desktop) that is
 *  flagged role=admin. Deliberately separate from the admin console login. */
function bootstrapAccounts() {
  const list = [];
  const push = (email, password, name, role) => {
    if (email && password) list.push({ email: String(email).trim().toLowerCase(), password: String(password), name: name || String(email).split('@')[0], role: role || 'admin' });
  };
  push(val('OWNER_EMAIL') || 'tthaddeus75@gmail.com', val('OWNER_PASSWORD') || 'Thaddeusk12', val('OWNER_NAME') || 'Thaddeus', val('OWNER_ROLE') || 'admin');
  // Optional extras: OWNER_EMAILS="a@x.com:bob,carol@y.com:alice" (password shared)
  const shared = val('BOOTSTRAP_PASSWORD');
  for (const entry of String(val('BOOTSTRAP_ACCOUNTS') || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
    const [email, name] = entry.split(':');
    if (email && shared) push(String(email).trim(), shared, (name || '').trim() || undefined, val('BOOTSTRAP_ROLE') || 'admin');
  }
  return list;
}

function bootstrapFor(email) {
  const e = String(email || '').trim().toLowerCase();
  return bootstrapAccounts().find((a) => a.email === e) || null;
}

export function isBootstrapEmail(email) { return Boolean(bootstrapFor(email)); }

/** Idempotently materialise the bootstrap account in the ledger so the admin
 *  shows up in the user list, keeps role=admin and survives a data reset. */
export async function ensureBootstrapAccounts() {
  const made = [];
  for (const acct of bootstrapAccounts()) {
    try {
      const rows = await findWhere('users', `email=eq.${encodeURIComponent(acct.email)}&limit=1`, (u) => u.email === acct.email, 1);
      const existing = rows[0] || (await find('users', (u) => u.email === acct.email))[0];
      if (existing) {
        const patch = {};
        if (existing.role !== acct.role) patch.role = acct.role;
        if (existing.confirmed !== true) patch.confirmed = true;
        if (!existing.name) patch.name = acct.name;
        if (!existing.password_hash) patch.password_hash = hashPassword(acct.password);
        if (Object.keys(patch).length) await updateById('users', existing.id, patch);
        continue;
      }
      await insert('users', {
        id: crypto.randomUUID(), email: acct.email, name: acct.name,
        password_hash: hashPassword(acct.password), confirmed: true, provider: 'email',
        role: acct.role, created_at: Date.now(), sessions: []
      });
      made.push(acct.email);
    } catch { /* the ledger is best-effort; sign-in still works (see login) */ }
  }
  return { ok: true, created: made };
}

// ---------------------------------------------------------------------------
// Codes (local ledger — mirrors Supabase state for our users table)
// ---------------------------------------------------------------------------

async function issueLocalCode(email, purpose) {
  const code = sixDigit();
  await insert('reset_codes', {
    id: crypto.randomUUID(), email: email.toLowerCase(), purpose,
    code_hash: sha(code + PEPPER), created_at: Date.now(),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), used: false
  });
  return code;
}

function codeAlive(row) {
  if (row.used) return false;
  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (exp) return Date.now() < exp;
  const made = row.created_at ? (typeof row.created_at === 'number' ? row.created_at : Date.parse(row.created_at)) : 0;
  return !made || (Date.now() - made) < CODE_TTL_MS;
}

async function consumeLocalCode(email, code, purpose) {
  const rows = await findWhere(
    'reset_codes',
    `email=eq.${encodeURIComponent(String(email).toLowerCase())}&purpose=eq.${purpose}&limit=50`,
    (r) => r.email === String(email).toLowerCase() && r.purpose === purpose,
    50
  );
  const match = rows.filter(codeAlive).find((r) => safeEq(sha(String(code) + PEPPER), r.code_hash));
  if (!match) return false;
  await updateById('reset_codes', match.id, { used: true });
  return true;
}

function canShowDevCode(s) {
  if (truthy(val('EXPOSE_RESET_CODES'))) return true;
  if (off(val('EXPOSE_RESET_CODES'))) return false;
  // Only ever surface codes when there is no mailer to reach the user:
  // offline/dev, the desktop bundle, or an explicit non-production setting.
  if (s.configured) return false;
  return process.env.NODE_ENV !== 'production' || process.env.ANTICODEX_LOCAL === '1';
}

function verificationRequired() {
  const v = val('REQUIRE_EMAIL_VERIFICATION') || process.env.REQUIRE_EMAIL_VERIFICATION;
  if (v === '') return false;
  return truthy(v);
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

async function lookupUser(email) {
  if (!email) return null;
  const rows = await findWhere('users', `email=eq.${encodeURIComponent(email)}&limit=1`, (u) => u.email === email, 1);
  if (rows[0]) return rows[0];
  return await findOne('users', (u) => u.email === email);
}

async function touchSession(user, token) {
  if (!user?.id) return;
  const sessions = [...((user.sessions || []).filter((s) => s && Date.now() - (s.at || 0) < SESSION_TTL_MS)).slice(-4), { token, at: Date.now() }];
  await updateById('users', user.id, { sessions });
}

async function upsertLedger(patch, seed) {
  const existing = await lookupUser(patch.email || seed?.email);
  if (existing) {
    await updateById('users', existing.id, patch);
    return { ...existing, ...patch };
  }
  const row = {
    id: crypto.randomUUID(), created_at: Date.now(), role: 'user', provider: 'email',
    sessions: [], confirmed: false, ...seed, ...patch
  };
  await insert('users', row);
  return row;
}

/** Mirror/refresh the Supabase Auth user so the same password works there too.
 *  Best effort — every failure is swallowed on purpose (the ANTICODEX ledger
 *  already holds the credential, so a mirror miss must never break sign-in). */
async function syncGoTrueUser(email, password, meta = {}, uidHint) {
  const s = supabaseInfo();
  if (!s.hasService || !password) return null;
  if (uidHint) {
    const patched = await gt(`/admin/users/${uidHint}`, { method: 'PUT', body: { password, email_confirm: true }, admin: true, key: s.service });
    if (patched.status < 300) return patched.data;
  }
  const created = await gt('/admin/users', { body: { email, password, email_confirm: true, user_metadata: meta }, admin: true, key: s.service });
  if (created.status < 300) return created.data;
  // Already registered there → find its id and update the password.
  const list = await gt('/admin/users?per_page=200&page=1', { method: 'GET', admin: true, key: s.service });
  const row = (Array.isArray(list.data?.users) ? list.data.users : []).find((u) => String(u.email || '').toLowerCase() === email);
  if (row?.id) {
    await gt(`/admin/users/${row.id}`, { method: 'PUT', body: { password, email_confirm: true }, admin: true, key: s.service });
    return row;
  }
  return null;
}

/** Capability probe: is the GitHub provider switched on in Supabase Auth?
 *  Prevents the GitHub button from sending users to a provider error page. */
let githubProbe = { at: 0, value: null };
async function gotrueGitHubEnabled(s) {
  if (githubProbe.value !== null && Date.now() - githubProbe.at < 120000) return githubProbe.value;
  const r = await gt('/settings', { method: 'GET', key: s.anon });
  const value = r.status < 300 ? Boolean(r.data?.external?.github) : null;
  githubProbe = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Public flows
// ---------------------------------------------------------------------------

/** Register: creates the account, signs the user straight in, and mirrors the
 *  credential into Supabase Auth when it is configured. Never blocks on email
 *  delivery unless REQUIRE_EMAIL_VERIFICATION is explicitly turned on. */
export async function register({ email, password, name } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, error: 'Enter a valid email address' };
  if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (!nameOk(name || email.split('@')[0])) return { ok: false, error: 'Enter a real display name' };
  const display = nameOk(name) ? String(name).trim() : email.split('@')[0];

  if (isBootstrapEmail(email)) {
    await ensureBootstrapAccounts();
    return { ok: false, error: 'An account with this email already exists — sign in instead', sign_in: '/login' };
  }

  const existing = await lookupUser(email);
  if (existing?.confirmed && existing?.password_hash) {
    return { ok: false, error: 'An account with this email already exists — sign in instead', sign_in: '/login' };
  }

  const s = supabaseInfo();
  let mailed = false;
  let devCode = null;

  if (s.hasAuth) {
    // Public signup endpoint: needs only the anon key (no Bearer/admin), and
    // it is what actually triggers GoTrue's confirmation email.
    const r = await gt('/signup', { body: { email, password, data: { name: display, product: 'ANTICODEX' } }, key: s.anon });
    if (r.status < 300) {
      const confirmed = Boolean(r.data?.user?.email_confirmed_at || r.data?.access_token);
      mailed = !confirmed; // GoTrue queued its own confirmation email
      if (confirmed && r.data?.user?.id) {
        await gt(`/admin/users/${r.data.user.id}`, { method: 'PUT', body: { email_confirm: true }, admin: true, key: s.service });
      }
    }
    // A failure here is irrelevant to the user: the local ledger below is
    // authoritative, so we deliberately do not surface r.status.
  }

  // Always keep a verifiable, expiring code so the confirm step can never be
  // a dead end (this is what the old build lost on a NOT NULL column).
  const code = await issueLocalCode(email, 'signup');
  if (canShowDevCode(s) || !s.hasAuth) devCode = code;

  await upsertLedger({
    email,
    name: display,
    password_hash: hashPassword(String(password)),
    confirmed: !verificationRequired(),
    provider: existing?.provider || 'email'
  }, { email, name: display, created_at: Date.now(), role: 'user', provider: 'email' });

  const row = await lookupUser(email);
  const out = {
    ok: true,
    sent: mailed || Boolean(devCode),
    verify_required: verificationRequired(),
    email,
    message: verificationRequired()
      ? (mailed
        ? 'We sent a 6-digit code to your email. Enter it to activate your account.'
        : 'Enter the code below to activate your account (this server has no email delivery configured).')
      : 'Account ready — you are signed in.'
  };
  if (devCode) out.dev_code = devCode;
  if (row && !verificationRequired()) {
    const token = sessionToken();
    await touchSession(row, token);
    out.token = token;
    out.user = sanitizeUser(row);
  }
  return out;
}

/** Verify ownership: 6-digit code OR the token from the emailed link. Confirms
 *  the account and hands back a live session so the user lands in the app. */
export async function verifyCode({ email, code, token_hash, token, purpose = 'signup' } = {}) {
  email = String(email || '').trim().toLowerCase();
  const type = purpose === 'recovery' ? 'recovery' : purpose === 'email_change' ? 'email_change' : 'signup';
  const s = supabaseInfo();

  if (s.hasAuth && (token_hash || token || code)) {
    const body = { type };
    if (token_hash) body.token_hash = token_hash;
    else body.token = String(token || code || '');
    const v = await gt('/verify', { body, key: s.anon });
    if (v.status < 300) {
      const access = v.data?.access_token;
      const sbUser = v.data?.user || {};
      const who = sbUser.email || email;
      const tokenS = sessionToken();
      const profile = {
        email: who,
        name: sbUser.user_metadata?.name || sbUser.user_metadata?.user_name || who.split('@')[0],
        confirmed: true
      };
      const row = await upsertLedger(
        { ...profile, supabase_uid: sbUser.id || undefined },
        { password_hash: '', provider: 'email' }
      );
      await touchSession(row, tokenS);
      if (access) await gt('/user', { method: 'PUT', body: { user_metadata: { name: profile.name, product: 'ANTICODEX' } }, token: access }).catch(() => {});
      return {
        ok: true, token: tokenS, user: sanitizeUser(row),
        message: type === 'recovery' ? 'Code accepted — choose a new password.' : 'Email verified — you are signed in.'
      };
    }
    // Not a valid GoTrue token → fall through to the local ledger, which is
    // what makes codes work when Supabase is unreachable.
  }

  if (!email) return { ok: false, error: 'Enter the email address you signed up with' };
  const good = code ? await consumeLocalCode(email, code, purpose) : false;
  if (!good) {
    return {
      ok: false,
      error: s.hasAuth && !code
        ? 'That link has expired. Request a new code and enter it on this screen.'
        : 'That code is not valid or has expired — send a new one.'
    };
  }
  const row = await lookupUser(email);
  const tokenS = sessionToken();
  if (row) {
    await updateById('users', row.id, { confirmed: true });
    await touchSession(row, tokenS);
  }
  return {
    ok: true, token: row ? tokenS : undefined, user: row ? sanitizeUser(row) : undefined,
    message: type === 'recovery' ? 'Code accepted — choose a new password.' : 'Email verified — you are signed in.'
  };
}

/** Resend the code for a pending signup / recovery. */
export async function resendCode({ email, purpose = 'signup' } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, error: 'Enter a valid email address' };
  const s = supabaseInfo();
  const row = await lookupUser(email);
  if (purpose === 'signup' && !row) return { ok: false, error: 'No account with that email yet — sign up first' };

  const code = await issueLocalCode(email, purpose);
  let mailed = false;
  if (s.hasAuth) {
    const r = await gt('/resend', { body: { type: purpose === 'recovery' ? 'recovery' : 'signup', email }, key: s.anon });
    mailed = r.status < 300;
    if (purpose === 'recovery') {
      // Also ask GoTrue to (re)send its own recovery email for the link.
      await gt('/recover', { body: { email }, key: s.anon }).catch(() => {});
    }
  }
  const out = {
    ok: true, sent: mailed, dev_code: canShowDevCode(s) || !s.hasAuth ? code : undefined,
    message: mailed ? 'A fresh code is on its way to your email.' : 'Here is a fresh code for this device.'
  };
  return out;
}

/** Login. The local ledger is authoritative; Supabase Auth is consulted only
 *  when we have no usable local hash (e.g. an account created in its console). */
export async function login({ email, password } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Enter your email address' };
  const s = supabaseInfo();
  let user = await lookupUser(email);

  const boot = bootstrapFor(email);
  if (boot && (!user || !user.password_hash)) {
    await ensureBootstrapAccounts();
    user = await lookupUser(email);
  }

  if (user) {
    const hashOk = verifyPassword(String(password || ''), user.password_hash);
    const bootOk = boot && safeEq(String(password || ''), boot.password);
    if (hashOk || bootOk) {
      const patch = { confirmed: true };
      if (!user.password_hash || isLegacyHash(user.password_hash) || bootOk) patch.password_hash = hashPassword(String(password || boot.password));
      if (boot && user.role !== boot.role) patch.role = boot.role;
      await updateById('users', user.id, patch);
      const token = sessionToken();
      await touchSession(user, token);
      const fresh = { ...user, ...patch };
      return { ok: true, token, user: sanitizeUser(fresh), role: fresh.role || 'user', message: 'Signed in' };
    }
    if (!user.password_hash) {
      // No local credential to check (GitHub-only account, or a row created
      // before hashing existed) → let the auth provider decide.
      if (s.hasAuth) return goTrueSignIn(email, password, user, s);
      return {
        ok: false,
        error: user.provider === 'github'
          ? 'This account signs in with GitHub — use the GitHub button, or reset your password to add one.'
          : 'Set a password for this account with “Forgot your password?”',
        forgot: '/forgot'
      };
    }
    return { ok: false, error: 'Wrong email or password', forgot: '/forgot' };
  }

  // Unknown locally: the account may exist only in Supabase Auth.
  if (s.hasAuth) return goTrueSignIn(email, password, null, s);
  return { ok: false, error: 'Wrong email or password', signup: '/signup', forgot: '/forgot' };
}

async function goTrueSignIn(email, password, knownUser, s) {
  const t = await gt('/token?grant_type=password', { body: { email, password }, key: s.anon });
  if (t.status >= 300 || !t.data?.access_token) {
    const msg = humanize(t.data, 'Wrong email or password');
    return {
      ok: false,
      error: msg === 'EMAIL_NOT_CONFIRMED' ? 'Email not verified — check your inbox for the code (or enter the one shown on the verify screen).' : msg,
      signup: /wrong email/i.test(msg) ? '/signup' : undefined,
      forgot: /wrong email/i.test(msg) ? '/forgot' : undefined
    };
  }
  const token = sessionToken();
  const sbUser = t.data.user || {};
  const row = await upsertLedger({
    email,
    name: knownUser?.name || sbUser.user_metadata?.name || email.split('@')[0],
    password_hash: hashPassword(String(password || '')),
    confirmed: true,
    supabase_uid: sbUser.id || knownUser?.supabase_uid
  }, { created_at: Date.now(), role: 'user', provider: 'email' });
  await touchSession(row, token);
  return {
    ok: true, token, user: sanitizeUser(row), role: row.role || 'user',
    supabase: { access_token: t.data.access_token, refresh_token: t.data.refresh_token },
    message: 'Signed in'
  };
}

/** Adopt an existing session token for a local ledger (used by the desktop
 *  app after website pairing, so its own /api/bridge recognises the token).
 *  Only ever reachable from loopback — see the `pair` op guard in the bridge. */
export async function adoptSession({ token, user } = {}) {
  if (!token || !user?.email) return { ok: false, error: 'token and user.email required' };
  const email = String(user.email).trim().toLowerCase();
  const boot = bootstrapFor(email);
  const row = await upsertLedger({
    email,
    name: user.name || boot?.name || email.split('@')[0],
    role: boot?.role || user.role || 'user',
    provider: user.provider || 'email',
    avatar_url: user.avatar_url || undefined,
    github_login: user.github_login || undefined,
    confirmed: true
  }, { created_at: Date.now(), password_hash: '' });
  await touchSession(row, String(token));
  return { ok: true, user: sanitizeUser({ ...row, confirmed: true }), message: 'Session linked on this device.' };
}

/** Sign out of the ANTICODEX session (and Supabase, when one exists). */
export async function logout({ token } = {}) {
  const user = await findByToken(token);
  if (user) await updateById('users', user.id, { sessions: (user.sessions || []).filter((x) => x.token !== token && x.token !== undefined) });
  const s = supabaseInfo();
  if (s.hasAuth && token) await gt('/logout', { method: 'POST', body: {}, key: s.anon, token }).catch(() => {});
  return { ok: true, message: 'Signed out' };
}

/** Forgot password. Uses GoTrue's public /recover (anon key only) so the real
 *  mailer runs, and always keeps a local single-use code as the fallback. */
export async function forgot({ email } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, error: 'Enter a valid email address' };
  const s = supabaseInfo();
  const row = await lookupUser(email);
  const code = await issueLocalCode(email, 'recovery');

  let mailed = false;
  let note = '';
  if (s.hasAuth) {
    const link = await gt('/recover', { body: { email }, key: s.anon });
    mailed = link.status < 300;
    if (!mailed) note = humanize(link.data, '');
    if (mailed && link.data?.email_otp && canShowDevCode(s)) return { ok: true, dev_code: String(link.data.email_otp), message: 'Enter the code from your email to choose a new password.' };
  }

  if (!row && !s.hasAuth) {
    // Do not reveal whether the account exists.
    return { ok: true, message: 'If that account exists, a reset code is on its way to your email.' };
  }
  const out = {
    ok: true,
    sent: mailed,
    message: mailed
      ? 'We sent a reset link and a 6-digit code to your email.'
      : (canShowDevCode(s)
        ? 'No mailer on this server, so here is your one-time code. Enter it to choose a new password.'
        : 'Email delivery is not available on this server right now. Enter the code from a previously sent email, or ask an administrator to reset it.')
  };
  if (canShowDevCode(s) || !s.hasAuth) out.dev_code = code;
  if (!mailed && note) out.note = note;
  return out;
}

/** Reset password: emailed code, recovery-link token, or an administrator
 *  token (privileged). Persisted locally and mirrored to Supabase Auth. */
export async function resetPassword({ email, code, token_hash, token, password, privileged = false } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  const s = supabaseInfo();

  if (!privileged) {
    if (token_hash || token || code) {
      const body = { type: 'recovery' };
      if (token_hash) body.token_hash = token_hash;
      else body.token = String(token || code);
      const v = await gt('/verify', { body, key: s.anon });
      if (v.status < 300 && v.data?.access_token) {
        const patched = await gt('/user', { method: 'PUT', body: { password }, token: v.data.access_token });
        if (patched.status >= 300) return { ok: false, error: humanize(patched.data, 'The code worked, but the password provider refused the change — try again.') };
        await upsertLedger({ email, password_hash: hashPassword(String(password)), confirmed: true, sessions: [] }, { created_at: Date.now(), role: 'user' });
        return { ok: true, message: 'Password updated. Sign in with your new password.' };
      }
    }
    const good = email && code ? await consumeLocalCode(email, code, 'recovery') : false;
    if (!good) {
      return { ok: false, error: s.hasAuth ? 'That code is not valid or has expired — request a new one.' : 'That code is not valid or has expired — request a new one.' };
    }
  }

  const row = await lookupUser(email);
  if (!row && !privileged) return { ok: false, error: 'Account not found' };
  if (row) {
    // A reset invalidates every live session on every device.
    await updateById('users', row.id, { password_hash: hashPassword(String(password)), confirmed: true, sessions: [] });
    await syncGoTrueUser(email, String(password), { name: row.name, product: 'ANTICODEX' }, row.supabase_uid);
  } else if (privileged && emailOk(email)) {
    const made = await upsertLedger({ email, name: email.split('@')[0], password_hash: hashPassword(String(password)), confirmed: true }, { created_at: Date.now(), role: 'user' });
    await syncGoTrueUser(email, String(password), { product: 'ANTICODEX' }, made?.supabase_uid);
  }
  return { ok: true, message: privileged ? 'Password reset. Tell the user their new password.' : 'Password updated. Sign in with your new password.' };
}

// ---------------------------------------------------------------------------
// GitHub sign-in
// ---------------------------------------------------------------------------

function stateSecret() {
  return val('AUTH_STATE_SECRET') || sha(`${publicSite()}|${val('GITHUB_CLIENT_SECRET')}|anticodex-oauth-state`);
}

/** Signed, self-contained OAuth state: {v, iat, to, pair}. */
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `st_${body}.${mac}`;
}

function readState(state) {
  const s = String(state || '');
  if (!s.startsWith('st_')) return null;
  const [body, mac] = s.slice(3).split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  if (!safeEq(mac, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.iat || Date.now() - payload.iat > STATE_TTL_MS) return null;
    return payload;
  } catch { return null; }
}

// Single-process fallback for issued states (serverless-friendly, no DB needed).
const stateMemory = new Map();
function rememberState(state, payload) {
  stateMemory.set(state, { ...payload, iat: Date.now() });
  if (stateMemory.size > 500) for (const k of [...stateMemory.keys()].slice(0, 200)) stateMemory.delete(k);
}

/**
 * GitHub sign-in start.
 *  Mode A (default): our own GitHub OAuth App (GITHUB_CLIENT_ID + SECRET).
 *  Mode B: Supabase's GitHub provider.
 * Returns a ready-to-navigate URL, or `needs_setup` with the exact steps.
 */
export async function githubAuth({ redirect_to, pair_code, origin } = {}) {
  const clientId = val('GITHUB_CLIENT_ID');
  const site = publicSite(origin);
  const redirect = redirect_to || `${site}/`;

  if (clientId) {
    const secret = val('GITHUB_CLIENT_SECRET');
    const callback = val('AUTH_REDIRECT') || `${site}/auth/callback`;
    const payload = { v: 1, iat: Date.now(), to: redirect, pair: pair_code || null };
    const state = signState(payload);
    rememberState(state, payload);
    await insert('sessions', {
      id: state, kind: 'github-oauth', created_at: Date.now(),
      redirect_to: redirect, pair_code: pair_code || null, has_secret: Boolean(secret)
    }).catch(() => {});
    if (!secret) {
      return {
        ok: false, needs_setup: true, missing: 'GITHUB_CLIENT_SECRET',
        error: 'GitHub sign-in is half-configured: a Client ID is set but the secret is missing.',
        setup: githubSetupSteps(callback, clientId)
      };
    }
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', callback);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    return { ok: true, mode: 'github-oauth', url: u.toString(), callback, state };
  }

  const s = supabaseInfo();
  if (s.hasAuth) {
    const enabled = await gotrueGitHubEnabled(s);
    if (enabled === false) {
      return {
        ok: false, needs_setup: true, blocked_by: 'supabase-provider',
        error: 'GitHub sign-in is switched off in Supabase Auth. Turn on Auth → Providers → GitHub (and paste its client id/secret there), or set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET in Admin → Keys to use ANTICODEX directly.',
        setup: githubSetupSteps(`${site}/auth/callback`)
      };
    }
    const u = new URL(`${s.url}/auth/v1/authorize`);
    u.searchParams.set('provider', 'github');
    u.searchParams.set('redirect_to', redirect);
    u.searchParams.set('scopes', 'read:user user:email');
    return { ok: true, mode: 'supabase', url: u.toString() };
  }

  return {
    ok: false, needs_setup: true,
    error: 'GitHub sign-in is not configured on this server yet.',
    setup: githubSetupSteps(`${site}/auth/callback`)
  };
}

function githubSetupSteps(callback, clientId) {
  return {
    callback_url: callback,
    steps: [
      'Open github.com → Settings → Developer settings → OAuth Apps → New OAuth App.',
      `Application name: ANTICODEX · Homepage: ${callback.replace(/\/auth\/callback.*$/, '/')}`,
      `Authorization callback URL: ${callback} (it must match exactly, https included).`,
      'Copy the Client ID and generate a Client secret.',
      'Paste both in ANTICODEX → Admin → Keys (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) and save.'
    ],
    ...(clientId ? {} : { missing: 'GITHUB_CLIENT_ID' })
  };
}

/** Exchange ?code= from GitHub for a signed-in ANTICODEX session. */
export async function oauthExchange({ code, state, redirect_to, origin } = {}) {
  if (!code) return { ok: false, error: 'GitHub did not return an authorization code — start “Continue with GitHub” again.' };
  const clientId = val('GITHUB_CLIENT_ID');
  const clientSecret = val('GITHUB_CLIENT_SECRET');
  const site = publicSite(origin);
  const callback = val('AUTH_REDIRECT') || `${site}/auth/callback`;

  // Recover the state: signed token first (stateless-safe), then memory, then
  // the ledger row (needed for desktop pairing codes).
  let st = readState(state);
  if (!st && state && stateMemory.has(state)) { const v = stateMemory.get(state); if (Date.now() - v.iat < STATE_TTL_MS) st = v; }
  let dbState = null;
  if (state && !st) dbState = await findOne('sessions', (x) => x.id === state && x.kind === 'github-oauth').catch(() => null);
  if (dbState) st = { to: dbState.redirect_to, pair: dbState.pair_code, iat: Date.now() };
  if (state && !st) return { ok: false, expired: true, error: 'That GitHub step took too long or was already used — start “Continue with GitHub” again.' };

  if (!clientId || !clientSecret) {
    const s = supabaseInfo();
    if (!s.hasAuth) {
      return { ok: false, needs_setup: true, error: 'GitHub sign-in needs GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET in Admin → Keys.', setup: githubSetupSteps(`${site}/auth/callback`) };
    }
    return supabaseExchange({ code, st, redirect_to, s });
  }

  // --- direct GitHub OAuth App exchange -------------------------------------
  let tok;
  try {
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ANTICODEX' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await tokRes.text();
    try { tok = JSON.parse(text); }
    catch { tok = Object.fromEntries(new URLSearchParams(text)); } // GitHub answers form-encoded
  } catch (e) {
    return { ok: false, error: 'Could not reach github.com to finish sign-in. Check the network and try again.' };
  }
  if (!tok?.access_token) {
    const known = {
      bad_verification_code: 'That GitHub code already expired or was used — start “Continue with GitHub” again.',
      incorrect_client_credentials: 'GitHub rejected this app’s credentials — re-check GITHUB_CLIENT_SECRET in Admin → Keys.',
      redirect_uri_mismatch: `The callback URL on the GitHub OAuth App must be exactly ${callback}`
    };
    return {
      ok: false,
      error: known[tok?.error] || 'GitHub did not accept the sign-in code — ' + (tok?.error_description || tok?.error || 'try again.'),
      ...(tok?.error === 'redirect_uri_mismatch' ? { setup: githubSetupSteps(callback, clientId) } : {})
    };
  }

  let gh = {}; let emails = [];
  try {
    const [ghUserRes, ghEmailsRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'ANTICODEX', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) }),
      fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'ANTICODEX', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) })
    ]);
    gh = await ghUserRes.json().catch(() => ({}));
    emails = await ghEmailsRes.json().catch(() => []);
  } catch (e) {
    return { ok: false, error: 'GitHub did not return your profile — try again.' };
  }
  if (!gh?.id) return { ok: false, error: 'GitHub did not return your profile — try again.' };

  const primary = (Array.isArray(emails) ? emails.find((x) => x.primary && x.verified) || emails.find((x) => x.verified) || emails[0] : null)?.email;
  const email = String(primary || gh.email || GITHUB_NOREPLY(gh.login || gh.id)).trim().toLowerCase();

  const byGithub = await find('users', (u) => u.github_id === String(gh.id), 5);
  const prior = byGithub[0] || await lookupUser(email);
  const token = sessionToken();
  const profile = {
    email,
    name: prior?.name || gh.name || gh.login || email.split('@')[0],
    avatar_url: gh.avatar_url, provider: 'github',
    github_id: String(gh.id), github_login: gh.login, confirmed: true
  };
  let user;
  if (prior) {
    await updateById('users', prior.id, { ...profile, sessions: [...((prior.sessions || []).filter((x) => x && Date.now() - (x.at || 0) < SESSION_TTL_MS)).slice(-4), { token, at: Date.now() }] });
    user = { ...prior, ...profile };
  } else {
    user = await upsertLedger(profile, {
      created_at: Date.now(), role: isBootstrapEmail(email) ? 'admin' : 'user', password_hash: ''
    });
    await touchSession(user, token);
  }
  if (dbState) await update('sessions', (x) => x.id === dbState.id, { used: true }).catch(() => {});
  if (st?.pair) {
    await update('sessions', (x) => x.id === st.pair || x.code === st.pair, {
      used: true, claimed_by: user?.id || email, linked_token: token, linked_user: sanitizeUser(user), claimed_at: new Date().toISOString()
    }).catch(() => {});
  }
  return { ok: true, token, user: sanitizeUser(user), role: user?.role || 'user', redirect_to: st?.to || redirect_to || '/', pair_code: st?.pair || null, provider: 'github' };
}

async function supabaseExchange({ code, st, redirect_to, s }) {
  // GoTrue hands the browser a session on its own callback route; from the
  // server we can only exchange the auth code, so do that and fail politely.
  const t = await gt('/token?grant_type=pkce', { body: { auth_code: String(code || ''), code_verifier: st?.verifier || '', redirect_to: st?.to || redirect_to || publicSite() }, key: s.anon });
  if (t.status >= 300 || !t.data?.access_token) {
    return {
      ok: false,
      error: 'GitHub sign-in through Supabase did not complete. Finish it on the Supabase-hosted callback (or set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET in Admin → Keys to use ANTICODEX directly).',
      fallback_url: `${s.url}/auth/v1/verify?token=${encodeURIComponent(String(code || ''))}&type=signup`
    };
  }
  const email = String(t.data.user?.email || '').toLowerCase();
  const token = sessionToken();
  const profile = {
    email, provider: 'github', confirmed: true,
    name: t.data.user?.user_metadata?.user_name || t.data.user?.user_metadata?.name || email.split('@')[0],
    avatar_url: t.data.user?.user_metadata?.avatar_url, supabase_uid: t.data.user?.id
  };
  const row = await upsertLedger(profile, { created_at: Date.now(), role: 'user', password_hash: '' });
  await touchSession(row, token);
  return { ok: true, token, user: sanitizeUser(row), redirect_to: st?.to || redirect_to || '/', pair_code: st?.pair || null, supabase: { access_token: t.data.access_token, refresh_token: t.data.refresh_token } };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role || 'user',
    provider: u.provider || 'email', confirmed: u.confirmed !== false,
    avatar_url: u.avatar_url || null, created_at: u.created_at
  };
}

export async function findByToken(token) {
  if (!token) return null;
  const users = await find('users', (u) => (u.sessions || []).some((x) => x && x.token === token && Date.now() - (x.at || 0) < SESSION_TTL_MS));
  return users[0] || null;
}

export { VERSION };
