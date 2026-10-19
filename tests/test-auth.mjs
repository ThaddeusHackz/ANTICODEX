// ANTICODEX auth integration tests against a mock Supabase.
//
// The mock reproduces the two production failures this build fixes:
//   • GoTrue's /auth/v1/admin/* endpoints answer
//     401 {"msg":"This endpoint requires a Bearer token"} unless the request
//     carries `Authorization: Bearer <service key>` (the old client sent the
//     key in `apikey` only, so every sign-up died with that string);
//   • public.reset_codes.expires_at is NOT NULL, so a code insert without it
//     is rejected (the old signup/recovery codes were silently lost).
//
// Everything else here asserts the *fixed* behaviour: a normal email address
// signs up and signs in, the reset link/code path works, the owner account
// always gets in, and no provider internals ever reach the browser.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-auth-'));
// Ports are allocated per run so a leftover process can never mask a result.
let PORT = 0;
let BASE = '';
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service';
let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---------------------------------------------------------------------------
// mock Supabase
// ---------------------------------------------------------------------------

function makeMockSupabase() {
  const tables = { users: [], threads: [], reset_codes: [], mcp_connections: [], generations: [], sessions: [], audit: [], outbox: [], user_keys: [], api_keys: [] };
  const authUsers = new Map();          // email -> { id, password, confirmed }
  const log = [];                       // every request we served
  const NOT_NULL = { reset_codes: ['email', 'code_hash', 'expires_at'] };
  // Real PostgREST rejects unknown columns. The mock does too, so a write of a
  // column that does not exist (the old reset_codes.updated_at stamping, for
  // instance) cannot silently pass here.
  const COLUMNS = {
    users: ['id', 'email', 'name', 'password_hash', 'role', 'provider', 'github_id', 'github_login', 'supabase_uid', 'avatar_url', 'confirmed', 'sessions', 'created_at', 'updated_at'],
    threads: ['id', 'user_id', 'user_email', 'title', 'model', 'messages', 'created_at', 'updated_at'],
    reset_codes: ['id', 'email', 'code_hash', 'expires_at', 'used', 'purpose', 'created_at'],
    sessions: ['id', 'kind', 'code', 'connection_id', 'scopes', 'approved', 'approved_at', 'used', 'claimed_by', 'linked_token', 'linked_user', 'claimed_at', 'verifier', 'client_id', 'client_secret', 'meta', 'redirect_uri', 'url', 'expires_at', 'created_at', 'redirect_to', 'pair_code', 'has_secret', 'updated_at'],
    user_keys: ['id', 'user_id', 'email', 'key_env', 'value', 'created_at', 'updated_at'],
    mcp_connections: ['id', 'user_id', 'name', 'transport', 'url', 'cmd', 'status', 'permissions', 'scopes', 'created_at', 'updated_at', 'enabled', 'token', 'access_token', 'refresh_token', 'expires_at', 'tools', 'connected_at', 'last_test', 'last_error'],
    audit: ['id', 'type', 'message', 'user_id', 'ip', 'at'],
    outbox: ['id', 'to', 'subject', 'body', 'at'],
    generations: ['id', 'user_id', 'kind', 'provider', 'prompt', 'result', 'created_at'],
    api_keys: ['id', 'user_id', 'provider', 'label', 'key_value', 'endpoint', 'created_at']
  };
  const unknownColumn = (name, body) => {
    const cols = COLUMNS[name];
    if (!cols || body === undefined || body === null) return null;
    const row = Array.isArray(body) ? body[0] : body;
    const bad = Object.keys(row || {}).filter((k) => !cols.includes(k));
    return bad.length ? `column "${bad[0]}" of relation "${name}" does not exist` : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };

    // --- PostgREST -----------------------------------------------------------
    if (url.pathname.startsWith('/rest/v1/')) {
      const name = url.pathname.slice('/rest/v1/'.length).split('?')[0];
      tables[name] = tables[name] || [];
      const filters = [...url.searchParams.entries()].filter(([k, v]) => k !== 'select' && k !== 'limit' && k !== 'order' && v.startsWith('eq.'));
      const match = (row) => filters.every(([k, v]) => String(row?.[k]) === decodeURIComponent(v.slice(3)));
      log.push({ kind: 'rest', method: req.method, path: `/rest/v1/${name}`, table: name, body });
      const badCol = unknownColumn(name, body);
      if (badCol) return send(400, { code: '42703', message: badCol });
      if (req.method === 'POST') {
        const missing = (NOT_NULL[name] || []).filter((c) => body[c] === undefined || body[c] === null);
        if (missing.length) return send(400, { code: '23502', message: `null value in column "${missing[0]}" of relation "${name}" violates not-null constraint` });
        if (name === 'users' && body.email && tables.users.some((u) => u.email === body.email)) {
          return send(409, { code: '23505', message: `duplicate key value violates unique constraint "${name}_email_key"` });
        }
        tables[name].push({ ...body });
        return send(201, [tables[name][tables[name].length - 1]]);
      }
      if (req.method === 'GET') return send(200, tables[name].filter(match).slice(0, Number(url.searchParams.get('limit') || 1000)));
      if (req.method === 'PATCH') {
        if (badCol) return send(400, { code: '42703', message: badCol });
        let n = 0;
        tables[name] = tables[name].map((row) => { if (!match(row)) return row; n++; return { ...row, ...body }; });
        return send(200, n ? [{}] : []);
      }
      if (req.method === 'DELETE') {
        const before = tables[name].length;
        tables[name] = tables[name].filter((row) => !match(row));
        return send(200, { deleted: before - tables[name].length });
      }
      return send(405, { message: 'nope' });
    }

    // --- GoTrue --------------------------------------------------------------
    if (url.pathname.startsWith('/auth/v1/')) {
      const p = url.pathname.slice('/auth/v1'.length);
      log.push({ kind: 'gotrue', method: req.method, path: p, body, apikey: req.headers.apikey || null, authorization: req.headers.authorization || null });
      const hasApikey = Boolean(req.headers.apikey);
      if (!hasApikey) return send(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });

      if (p.startsWith('/admin/')) {
        // This is the exact behaviour that broke sign-up: apikey alone is not
        // enough, admin routes demand a bearer service token.
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (bearer !== SERVICE) {
          return send(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a Bearer token' });
        }
        if (p === '/admin/users' && req.method === 'POST') {
          const email = String(body.email || '').toLowerCase();
          if (authUsers.has(email)) return send(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
          const u = { id: `u_${authUsers.size + 1}`, email, password: body.password, confirmed: body.email_confirm === true };
          authUsers.set(email, u);
          return send(200, { id: u.id, email: u.email, aud: 'authenticated', app_metadata: {}, user_metadata: body.user_metadata || {}, email_confirmed_at: u.confirmed ? new Date().toISOString() : null });
        }
        if (p.startsWith('/admin/users/') && req.method === 'PUT') {
          const id = p.split('/').pop();
          const email = String(body.email || '').toLowerCase();
          const found = [...authUsers.values()].find((x) => x.id === id) || authUsers.get(email);
          if (!found) return send(404, { msg: 'User not found' });
          if (body.password) found.password = body.password;
          if (body.email_confirm === true) found.confirmed = true;
          return send(200, { id: found.id, email: found.email, email_confirmed_at: found.confirmed ? new Date().toISOString() : null });
        }
        if (p === '/admin/users' && req.method === 'GET') {
          // The admin API filters on `emails=` (plural) and returns [] for an
          // unknown address — the app's "does this uid exist yet?" branch relies
          // on that, so the mock must too.
          const q = url.searchParams.get('emails') || url.searchParams.get('email');
          const want = q ? String(q).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
          const users = [...authUsers.entries()]
            .filter(([em]) => !want || want.includes(em))
            .map(([em, u]) => ({ id: u.id, email: em, aud: 'authenticated' }));
          return send(200, { aud: 'authenticated', users });
        }
        if (p === '/admin/generate_link') {
          return send(200, { action_link: `http://mock/verify?token=abc&type=${body.type}`, email_otp: '654321', hashed_token: 'nope' });
        }
        return send(404, { msg: 'unknown admin route' });
      }

      if (p === '/signup' && req.method === 'POST') {
        const email = String(body.email || '').toLowerCase();
        if (authUsers.has(email)) return send(422, { code: 400, error_code: 'user_already_exists', msg: 'User already registered' });
        // mailer_autoconfirm = false, like the live project: no session back.
        authUsers.set(email, { id: `u_${authUsers.size + 1}`, email, password: body.password, confirmed: false });
        return send(200, { id: authUsers.get(email).id, email, phone: null, app_metadata: {}, user_metadata: body.data || {}, aud: 'authenticated', created_at: new Date().toISOString(), confirmed_at: null });
      }
      if (p === '/token' && req.method === 'POST') {
        const email = String(body.email || '').toLowerCase();
        const u = authUsers.get(email);
        if (!u) return send(400, { code: 400, error: 'invalid_grant', error_description: 'Invalid login credentials' });
        if (!u.confirmed) return send(400, { code: 400, error: 'invalid_grant', error_description: 'Email not confirmed' });
        if (u.password !== body.password) return send(400, { code: 400, error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(200, { access_token: 'mock.jwt.access', token_type: 'bearer', expires_in: 3600, refresh_token: 'mock-refresh', user: { id: u.id, email: u.email, user_metadata: { name: 'Mock' } } });
      }
      if (p === '/recover' && req.method === 'POST') {
        const email = String(body.email || '').toLowerCase();
        if (!authUsers.has(email)) return send(200, {});   // never reveals existence
        authUsers.get(email).recovery_sent = (authUsers.get(email).recovery_sent || 0) + 1;
        return send(200, { id: authUsers.get(email).id, email, user: { id: authUsers.get(email).id, email } });
      }
      if (p === '/resend' && req.method === 'POST') return send(200, { message_id: 'mock' });
      if (p === '/verify' && req.method === 'POST') {
        return send(400, { code: 400, error_code: 'validation_failed', msg: 'Token has expired' });
      }
      if (p === '/user' && req.method === 'PUT') {
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (bearer !== 'mock.jwt.access') return send(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a Bearer token' });
        return send(200, { id: 'u_1', email: [...authUsers.keys()][0] });
      }
      if (p === '/logout') return send(204);
      if (p === '/settings' && req.method === 'GET') return send(200, { external: { email: true, github: false }, disable_signup: false, mailer_autoconfirm: false });
      if (p === '/health') return send(200, { version: 'mock' });
      return send(404, { msg: `unknown route ${p}` });
    }
    return send(404, { msg: 'nope' });
  });

  return {
    server, tables, authUsers, log,
    calls: (pred) => log.filter((x) => { try { return Boolean(pred(x)); } catch { return false; } }),
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function api(base, action, payload = {}, headers = {}) {
  const res = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...payload })
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function spawnServer(env, args = []) {
  const server = spawn('node', ['server.mjs', ...args], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ANTICODEX_DATA: DATA_TMP, ...env }, stdio: 'ignore'
  });
  return server;
}

async function waitFor(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${base}/api/bridge`, { method: 'POST', body: JSON.stringify({ action: 'health' }), headers: { 'Content-Type': 'application/json' } }); if (r.ok) return true; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const INTERNALS = /This endpoint requires|no_authorization|PostgREST|violates not-null|duplicate key value|relation "|schema cache|apikey|service_role|eyJ[A-Za-z0-9_-]{8,}|EROFS|read-only file system|at file:|\.js:\d+/i;

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const mock = await makeMockSupabase();
  const mockUrl = await mock.listen();

  console.log('\n— sign-in with a normal email, against a Supabase that mirrors production —');
  const server = spawnServer({
    SUPABASE_URL: mockUrl,
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    SITE_URL: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    EXPOSE_RESET_CODES: 'false'
  });
  assert(await waitFor(BASE), 'server did not start');
  {
    const cfg = (await api(BASE, 'config')).data;
    assert(cfg.auth_mode === 'supabase' && cfg.name === 'ANTICODEX', 'this test must reach a server wired to the mock Supabase');
  }

  const email = `real${Date.now()}@gmail.com`;
  let r = await api(BASE, 'register', { email, password: 'hunter2pass', name: 'Someone Real' });

  ok('sign-up succeeds on a server whose mailer is unconfirmed', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  ok('sign-up hands back a live session', Boolean(r.data.token) && r.data.user?.email === email);
  ok('the old blocker text never reaches the client', !/requires a (valid )?Bearer token/i.test(JSON.stringify(r.data)));
  ok('no provider internals leak at all', !INTERNALS.test(JSON.stringify(r.data)), JSON.stringify(r.data));
  ok('account is usable (no verification gate by default)', r.data.verify_required === false && r.data.confirmed !== false);
  ok('code is not printed out when a mailer exists', r.data.dev_code === undefined);

  ok('signup used GoTrue PUBLIC /signup with the anon key', mock.calls((x) => x.kind === 'gotrue' && x.path === '/signup').some((x) => x.apikey === ANON && !x.authorization));
  ok('the ledger row was written to Supabase PostgREST', mock.tables.users.some((u) => u.email === email && /^v1\$/.test(String(u.password_hash))));
  ok('the password is NOT stored as a bare sha256', (() => {
    const u = mock.tables.users.find((x) => x.email === email);
    return !/^[0-9a-f]{64}$/.test(String(u?.password_hash));
  })());
  ok('verification code persisted WITH an expiry (NOT NULL column)', mock.tables.reset_codes.some((c) => c.email === email && c.purpose === 'signup' && c.expires_at));
  ok(
    'no admin call was ever made without a bearer',
    mock.calls((x) => x.kind === 'gotrue' && x.path.startsWith('/admin/')).every((x) => x.authorization === `Bearer ${SERVICE}`),
    JSON.stringify(mock.calls((x) => x.kind === 'gotrue').filter((x) => String(x.path).startsWith('/admin/')))
  );

  r = await api(BASE, 'login', { email, password: 'hunter2pass' });
  ok('sign-in with the same credentials works', r.status === 200 && r.data.ok && r.data.token);
  const token = r.data.token;
  r = await api(BASE, 'me', {}, { Authorization: `Bearer ${token}` });
  ok('Bearer session token authenticates /me', r.status === 200 && r.data.user.email === email);
  r = await api(BASE, 'me', { token: 'acx_not_a_real_token' });
  ok('a bogus bearer token is refused politely', r.status === 401 && !INTERNALS.test(JSON.stringify(r.data)));

  r = await api(BASE, 'login', { email, password: 'wrongpassword' });
  ok('wrong password: friendly message, no GoTrue detail', r.data.ok === false && /wrong email or password/i.test(r.data.error));

  r = await api(BASE, 'register', { email, password: 'hunter2pass', name: 'Dup' });
  ok('duplicate sign-up is rejected with a way forward', r.data.ok === false && /already exists/i.test(r.data.error) && r.data.sign_in === '/login');

  r = await api(BASE, 'forgot', { email });
  ok('forgot password triggers the real mailer path (/recover)', mock.calls((x) => x.kind === 'gotrue' && x.path === '/recover').length > 0 && r.data.ok);
  ok('forgot never touches /admin/generate_link', mock.calls((x) => x.kind === 'gotrue' && x.path === '/admin/generate_link').length === 0);
  ok('the provider row is created and confirmed too (bare /signup reply handled)',
    mock.authUsers.get(email)?.confirmed === true);
  {
    // Because the provider row is confirmed, supabase-js sessions for this
    // account work as well — the password grant must not say "Email not confirmed".
    const res = await fetch(`${mockUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email, password: 'hunter2pass' })
    });
    const j = await res.json();
    ok('the same password works through GoTrue directly', res.status === 200 && Boolean(j.access_token));
  }
  ok('forgot is not blocked by the bearer bug', !/Bearer token/i.test(JSON.stringify(r.data)));
  const code = r.data.dev_code;
  ok('no dev code leaked while a mailer exists', code === undefined);

  r = await api(BASE, 'reset', { email, code: '000000', new_password: 'brandnewpass' });
  ok('reset refuses a wrong code', r.data.ok === false && /not valid or has expired/i.test(r.data.error));
  ok('reset does not leak provider text', !INTERNALS.test(JSON.stringify(r.data)));

  // The reset code is single-use and only resolvable from the ledger, so fetch
  // it the way a user would read it out of their email.
  const pending = mock.tables.reset_codes.filter((c) => c.email === email && c.purpose === 'recovery' && !c.used);
  ok('a recovery code is waiting in the ledger', pending.length >= 1);
  r = await api(BASE, 'admin', { op: 'reset_user', token: 'bad', email, password: 'nope123456' });
  ok('admin reset needs the admin token', r.status === 401);
  const admin = await api(BASE, 'admin', { op: 'login', username: 'Thaddeusadmin', password: 'Thaddeusk12' });
  const at = admin.data.token;
  r = await api(BASE, 'admin', { op: 'reset_user', token: at, email, password: 'brandnewpass' });
  ok('admin can reset an account without the emailed code', r.status === 200 && r.data.ok);
  ok('the reset is mirrored into Supabase Auth (admin PUT with bearer)', mock.calls((x) => x.kind === 'gotrue' && String(x.path).startsWith('/admin/users/') && x.method === 'PUT').some((x) => x.authorization === `Bearer ${SERVICE}`));
  ok('and Supabase Auth really changed the password', [...mock.authUsers.values()].some((u) => u.password === 'brandnewpass'));

  r = await api(BASE, 'login', { email, password: 'brandnewpass' });
  ok('sign-in with the new password works', r.status === 200 && r.data.token);
  const token2 = r.data.token;
  r = await api(BASE, 'threads', { op: 'save', token: token2, thread: { id: 'th_1', title: 'Kept', messages: [] } });
  ok('threads save against the account id (fk-safe)', r.status === 200 && mock.tables.threads.some((t) => t.id === 'th_1' && !String(t.user_id).startsWith('acx_')));
  r = await api(BASE, 'threads', { op: 'list', token: token2 });
  ok('threads list back for the same account', r.data.threads?.some((t) => t.id === 'th_1'));
  const again = await api(BASE, 'login', { email, password: 'brandnewpass' });
  r = await api(BASE, 'threads', { op: 'list', token: again.data.token });
  ok('threads survive signing out and back in', r.data.threads?.some((t) => t.id === 'th_1'));

  console.log('\n— owner / second admin —');
  r = await api(BASE, 'login', { email: 'tthaddeus75@gmail.com', password: 'Thaddeusk12' });
  ok('owner signs in with the baked credentials', r.status === 200 && r.data.ok && Boolean(r.data.token));
  ok('owner is role=admin for the app', r.data.role === 'admin' && r.data.user.role === 'admin');
  ok('owner row exists in the ledger', mock.tables.users.some((u) => u.email === 'tthaddeus75@gmail.com' && u.role === 'admin'));
  r = await api(BASE, 'me', { token: r.data.token });
  ok('owner session works on protected calls', r.status === 200 && r.data.user.name === 'Thaddeus');
  r = await api(BASE, 'admin', { op: 'login', username: 'Thaddeusadmin', password: 'Thaddeusk12' });
  ok('admin CONSOLE credentials still work and are separate', r.status === 200 && r.data.token);

  console.log('\n— GitHub button behaviour when it is not wired up —');
  r = await api(BASE, 'github_login', { redirect_to: `${BASE}/` });
  ok('github click is not a dead end (no url + real reason)', r.status === 200 && r.data.ok === false && r.data.needs_setup && /(not configured|switched off)/i.test(r.data.error));
  ok('github refuses to send users to a disabled provider', !r.data.url);
  ok('github setup steps are actionable', Array.isArray(r.data.setup?.steps) && r.data.setup.steps.length >= 4 && /callback/i.test(r.data.setup.steps.join(' ')));

  // Only a client id → the half-configured case must say so.
  await api(BASE, 'admin', { op: 'set_keys', token: at, GITHUB_CLIENT_ID: 'Iv1.halfconfigured' });
  r = await api(BASE, 'github_login', {});
  ok('half-configured GitHub reports the missing secret', r.data.ok === false && r.data.missing === 'GITHUB_CLIENT_SECRET');
  await api(BASE, 'admin', { op: 'set_keys', token: at, GITHUB_CLIENT_SECRET: 'shhh' });
  r = await api(BASE, 'github_login', {});
  ok('with both keys the authorize url is issued', r.data.ok && /github\.com\/login\/oauth\/authorize/.test(r.data.url) && r.data.state?.startsWith('st_'));
  await api(BASE, 'admin', { op: 'set_keys', token: at, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });

  server.kill('SIGTERM');

  console.log('\n— read-only filesystem (serverless / packaged .exe) —');
  const RO_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-ro-'));
  const roDir = path.join(RO_TMP, 'data');
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o500); // r-x: writes throw EROFS/EACCES
  const PORT2 = await freePort();
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const ro = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', ANTICODEX_DATA: roDir, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    stdio: 'ignore'
  });
  assert(await waitFor(BASE2), 'read-only server did not start');
  const email2 = `diskless${Date.now()}@gmail.com`;
  r = await api(BASE2, 'register', { email: email2, password: 'hunter2pass', name: 'Diskless' });
  ok('sign-up still works with a read-only data dir', r.status === 200 && r.data.ok && r.data.token, JSON.stringify(r.data));
  ok('codes are surfaced when there is no mailer at all', /^\d{6}$/.test(String(r.data.dev_code)));
  ok('the sign-up session authenticates', (await api(BASE2, 'me', { token: r.data.token })).status === 200);
  r = await api(BASE2, 'forgot', { email: email2 });
  ok('forgot returns a usable code offline', r.data.ok && /^\d{6}$/.test(String(r.data.dev_code)));
  const code2 = r.data.dev_code;
  r = await api(BASE2, 'reset', { email: email2, code: code2, new_password: 'disklesspass' });
  ok('reset with that code works offline', r.data.ok);
  r = await api(BASE2, 'login', { email: email2, password: 'disklesspass' });
  ok('sign-in with the reset password works', r.status === 200 && r.data.token);
  ok('nothing leaked from the filesystem', !/EROFS|EACCES|read-only/i.test(JSON.stringify(await api(BASE2, 'register', { email: `x${Date.now()}@y.zz`, password: 'hunter2pass', name: 'X' }))));
  ro.kill('SIGTERM');
  fs.chmodSync(roDir, 0o700);
  fs.rmSync(RO_TMP, { recursive: true, force: true });

  console.log('\n— ledger stamping against the real column set —');
  {
    // updateById() must not die on a table with no updated_at column, or a
    // "used" code would stay replayable until it expired.
    process.env.SUPABASE_URL = mockUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    process.env.ANTICODEX_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-store-'));
    const store = await import('../lib/store.js');
    const codeRow = { id: 'rc_test_1', email: 'stamp@example.com', purpose: 'recovery', code_hash: 'x'.repeat(64), used: false, created_at: Date.now(), expires_at: new Date(Date.now() + 60000).toISOString() };
    mock.tables.reset_codes.push(codeRow);
    await store.updateById('reset_codes', 'rc_test_1', { used: true });
    ok('updateById marks a code used on a table without updated_at', mock.tables.reset_codes.find((c) => c.id === 'rc_test_1')?.used === true);
    await store.updateById('users', 'row_local_1', { name: 'Seeded', email: 'stamp@example.com' });
    ok('updateById inserts a missing local row instead of dropping the write', (await store.find('users', (u) => u.id === 'row_local_1')).length === 1);
    const rows = await store.findWhere('users', 'email=eq.stamp%40example.com&limit=1');
    ok('findWhere filters server-side', rows.length === 1 && rows[0].email === 'stamp@example.com');
  }

  fs.rmSync(DATA_TMP, { recursive: true, force: true });
  mock.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
