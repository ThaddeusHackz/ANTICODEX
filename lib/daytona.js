// ANTICODEX on Daytona — a real remote sandbox, over the protocol Daytona
// actually speaks.
//
// The product problem this solves: the local sandbox (lib/sandbox.js) runs on the
// machine in front of you, so a hosted deploy has nothing to run and a laptop is
// the only place an agent can execute. Daytona is a remote box with a shell, so
// "run this, show me the files, keep the log" becomes possible for the website,
// the desktop app and the phone alike.
//
// Two ways in, both real:
//
//   1. SSH — `ssh <workspace>@ssh.app.daytona.io`. Zero dependencies: the system
//      `ssh` client, a key from `~/.ssh` (or one this app generates for you), and
//      a host-key pin recorded on first use. This is the path that works from a
//      laptop, a desktop app and a CI runner with no extra services.
//   2. REST — `https://app.daytona.io/api` with a `DAYTONA_API_KEY`. Used when an
//      API key exists, because listing and creating sandboxes needs it; exec and
//      filesystem then go through the same toolbox endpoints the SDK uses.
//
// What it refuses to do: run anything without saying where, and pretend a remote
// box is configured when it is not. Every response carries `target` — `local` or
// `daytona:<name>` — so the UI never has to guess which machine executed.
//
// Config (env, or the app's own settings row):
//   DAYTONA_SSH_HOST      default ssh.app.daytona.io
//   DAYTONA_SSH_PORT      default 22
//   DAYTONA_SSH_USER      a workspace user, e.g. `ssh WtMs...@ssh.app.daytona.io`
//   DAYTONA_SSH_KEY       path to a private key (default: ~/.ssh/id_ed25519, id_rsa)
//   DAYTONA_SSH_TARGET    optional pre-baked `user@host` — wins over the above
//   DAYTONA_API_KEY       REST access (list/create sandboxes, toolbox calls)
//   DAYTONA_API_URL       default https://app.daytona.io/api
//   ANTICODEX_SANDBOX     `daytona` to route sandbox runs there, `local` to keep them home

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';

export const DEFAULTS = Object.freeze({
  ssh_host: 'ssh.app.daytona.io',
  ssh_port: 22,
  api_url: 'https://app.daytona.io/api',
  connect_timeout: 10,
  known_hosts: path.join(os.homedir(), '.qoder', 'daytona_known_hosts'),
  key_candidates: ['id_ed25519', 'id_rsa', 'id_ecdsa']
});

const MAX_CMD = 4000;
const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT = 20_000;      // seconds*1000; the SSH call is killed, not abandoned
const HARD_TIMEOUT = 120_000;

// Where a connection typed into the UI is kept, so a Daytona target survives a
// restart without the user re-exporting environment variables in every shell. The
// file holds a username and a key *path* — never a key or a token — and env always
// wins over it, so a one-off `DAYTONA_SSH_USER=… npm start` still behaves.
// `ANTICODEX_DAYTONA_CONFIG` makes the saved connection redirectable: a test can
// point it at a temp file instead of a real home, and project-scoped setups can
// keep their own target without touching the user-wide one.
const SETTINGS_FILE = () => process.env.ANTICODEX_DAYTONA_CONFIG || path.join(os.homedir(), '.qoder', 'daytona.json');

// Read on every call, with no memo. An mtime cache looked free and was wrong: two
// saves inside the same millisecond (rotate, then paste again) left the stale value
// in place, so `status` reported the previous token's countdown. The file is a few
// hundred bytes; parsing it is cheaper than being wrong.
function saved() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** How long a workspace token lives, unless the copy that was pasted says
 *  otherwise. Daytona's console issues 1,440-minute (24h) workspace SSH users.
 *  This is a *hint for the countdown*, never a reason to refuse a connection: the
 *  server is the only thing that can actually reject an expired token, and it will. */
export const TOKEN_TTL_MINUTES = 1440;

/**
 * Persist the Daytona connection. Accepts
 * `{ user, host, port, key, label, mode, api_url, api_key, ttl_minutes }` and writes
 * only the fields given; `null` clears one.
 *
 * Two behaviours exist because a Daytona token is not a password:
 *   * pasting a new `user` rotates the connection — the previous user is recorded
 *     (masked, last four characters) in a rotation log, so "which token did I have
 *     yesterday" has an answer without storing a credential;
 *   * `ttl_minutes` (default 1440) sets `expires_at` from the moment of the save, and
 *     `status()` reports the remaining minutes. Saving a new token restarts it.
 */
export function saveDaytonaConfig(patch = {}) {
  const file = SETTINGS_FILE();
  const next = { ...saved() };
  const prevUser = next.user ? String(next.user) : null;
  for (const k of ['user', 'host', 'port', 'key', 'label', 'mode', 'api_url']) {
    if (!(k in patch)) continue;
    if (patch[k] === null || patch[k] === '') delete next[k];
    else next[k] = k === 'port' ? Number(patch[k]) || undefined : String(patch[k]).trim();
  }
  if (next.port === undefined) delete next.port;
  if (patch.api_key) next.api_key = String(patch.api_key);   // written, never read back
  if (patch.clear_api_key) delete next.api_key;

  // A new workspace user is a new token. Record when it was taken and what it
  // replaced — the log keeps four trailing characters and nothing else.
  const rotated = patch.user && prevUser && String(patch.user).trim() !== prevUser;
  if (rotated || (patch.user && patch.reset_expiry !== false)) {
    const ttl = Number(patch.ttl_minutes) > 0 ? Number(patch.ttl_minutes) : TOKEN_TTL_MINUTES;
    next.token = {
      set_at: Date.now(),
      ttl_minutes: ttl,
      expires_at: Date.now() + ttl * 60_000,
      // Never the token itself. Four characters is enough to tell two apart.
      suffix: String(next.user || '').slice(-4)
    };
    if (rotated) {
      next.rotation = Array.isArray(next.rotation) ? next.rotation.slice(-9) : [];
      next.rotation.push({ replaced_suffix: prevUser.slice(-4), replaced_at: Date.now(), set_suffix: String(next.user).slice(-4) });
    }
  }
  if (patch.clear_token) delete next.token;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return {
    ok: true, file, rotated,
    saved: { ...next, api_key: next.api_key ? '(set)' : undefined, user: next.user },
    token: tokenState(next.token)
  };
}

/** The countdown for a saved token: minutes left, and what that means. */
export function tokenState(token) {
  if (!token || !token.expires_at) {
    return { known: false, note: 'No token lifetime recorded for this connection.' };
  }
  const msLeft = Number(token.expires_at) - Date.now();
  const minutesLeft = Math.round(msLeft / 60_000);
  const total = Number(token.ttl_minutes) || TOKEN_TTL_MINUTES;
  const elapsed = Math.max(0, total - Math.max(0, minutesLeft));
  return {
    known: true,
    set_at: token.set_at || null,
    set_ago_minutes: token.set_at ? Math.round((Date.now() - token.set_at) / 60_000) : null,
    ttl_minutes: total,
    expires_at: token.expires_at,
    minutes_left: minutesLeft,
    hours_left: Math.round((minutesLeft / 60) * 10) / 10,
    // A countdown is a warning system, so the thresholds are named rather than
    // left to the UI: 60 minutes to finish a run, 10 minutes to stop starting one.
    state: msLeft <= 0 ? 'expired' : minutesLeft <= 10 ? 'expiring' : minutesLeft <= 60 ? 'soon' : 'valid',
    progress: Math.max(0, Math.min(1, elapsed / total)),
    suffix: token.suffix || null,
    note: msLeft <= 0
      ? `This workspace token expired ${Math.abs(minutesLeft)} minutes ago. Paste a fresh one — Daytona issues them for ${total} minutes.`
      : `${minutesLeft} minutes left on this token (${token.suffix ? `…${token.suffix}, ` : ''}set ${Math.round((Date.now() - (token.set_at || Date.now())) / 60_000)} minutes ago).`
  };
}

/** The configuration actually in force, and where each value came from — so the
 *  Sandbox page can say "from env" vs "saved in ~/.qoder/daytona.json". */
export function daytonaConfig() {
  const file = saved();
  const pick = (envKey, fileKey, fallback) => {
    const e = env(envKey);
    if (e) return { value: e, from: 'env' };
    if (file[fileKey]) return { value: String(file[fileKey]), from: 'saved' };
    return { value: fallback, from: 'default' };
  };
  return {
    user: pick('DAYTONA_SSH_USER', 'user', ''),
    host: pick('DAYTONA_SSH_HOST', 'host', DEFAULTS.ssh_host),
    port: pick('DAYTONA_SSH_PORT', 'port', String(DEFAULTS.ssh_port)),
    key: pick('DAYTONA_SSH_KEY', 'key', ''),
    label: pick('DAYTONA_SSH_LABEL', 'label', 'Daytona')
  };
}

const env = (k) => {
  if (process.env[k]) return String(process.env[k]).trim();
  // An API key saved from the UI is used but never echoed to the client.
  if (k === 'DAYTONA_API_KEY') { const v = saved().api_key; if (v) return String(v); }
  return '';
};

/** Daytona's console shows the username as `ssh <workspace-user>`. The `ssh` is a
 *  label, not part of the login name, so strip it (but keep showing it verbatim in
 *  the connection fields, because that is what the user is copying from). */
export function normaliseUser(raw) {
  return String(raw || '').replace(/^ssh\s+/i, '').trim();
}

/** Turn the many shapes a Daytona target is shown in into one: `user@host:port`.
 *  Accepts `ssh user@host`, `user@host:2222`, and a bare `host` (keeping the
 *  configured user). A label prefix like `Daytona ` is tolerated, because the
 *  console's copy button includes it. */
export function normaliseTarget(raw, fallbackUser = '') {
  let t = String(raw || '').trim();
  if (!t) return '';
  t = t.replace(/^daytona[:\s]+/i, '').replace(/^ssh\s+/i, '');
  if (!t.includes('@')) {
    const u = normaliseUser(fallbackUser);
    return u ? `${u}@${t}` : t;
  }
  const [user, hostPort] = t.split('@');
  const cleanUser = normaliseUser(user);
  const host = hostPort.split(':')[0].trim();
  const port = hostPort.split(':')[1];
  return port ? `${cleanUser}@${host}:${port}` : `${cleanUser}@${host}`;
}

/** Everything the UI needs to explain the current state, without leaking a key. */
export function daytonaStatus() {
  const cfg = daytonaConfig();
  const rawUser = cfg.user.value;
  const user = normaliseUser(rawUser);
  const explicitTarget = env('DAYTONA_SSH_TARGET');
  const target = normaliseTarget(explicitTarget) || (user
    ? `${user}@${cfg.host.value}:${cfg.port.value}`
    : '');
  const key = resolveKey();
  const mode = env('ANTICODEX_SANDBOX') === 'local' ? 'local' : (target || env('DAYTONA_API_KEY') ? 'daytona' : 'local');
  return {
    ok: true,
    configured: Boolean(target || env('DAYTONA_API_KEY')),
    source: { user: cfg.user.from, host: cfg.host.from, port: cfg.port.from, key: cfg.key.from },
    // The countdown for the saved token, so the UI can warn before a long run dies.
    token: tokenState(saved().token),
    rotation: Array.isArray(saved().rotation) ? saved().rotation.slice(-5) : [],
    mode,
    ssh: {
      available: Boolean(target),
      host: cfg.host.value,
      port: Number(cfg.port.value) || DEFAULTS.ssh_port,
      user: user || null,
      user_as_shown: rawUser || null,
      target: target || null,
      key: key ? { path: key.path, generated: Boolean(key.generated), comment: key.comment } : null,
      ssh_binary: which('ssh'),
      known_hosts: DEFAULTS.known_hosts,
      saved_file: SETTINGS_FILE()
    },
    api: {
      available: Boolean(env('DAYTONA_API_KEY')),
      url: env('DAYTONA_API_URL') || DEFAULTS.api_url
    },
    // The exact rows to type into a client that asks for them by name (Qoder's
    // "Daytona" connection form asks in this order).
    fields: {
      'Host address': cfg.host.value,
      Port: String(Number(cfg.port.value) || DEFAULTS.ssh_port),
      Username: user ? `ssh ${user}` : '(set a workspace user)',
      Authentication: 'SSH key — this app uses ~/.ssh, or generates one for you',
      Name: cfg.label.value || 'Daytona'
    },
    note: target || env('DAYTONA_API_KEY')
      ? 'A Daytona target is configured. Sandbox runs follow ANTICODEX_SANDBOX (default: daytona).'
      : 'No Daytona target configured. Set DAYTONA_SSH_USER (a workspace user) or DAYTONA_API_KEY — the local sandbox stays the default until you do.'
  };
}

function which(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** The key this app will use: explicit env path → ~/.ssh candidates → generated. */
export function resolveKey({ generate = false } = {}) {
  const savedKey = saved().key ? String(saved().key) : '';
  const explicit = env('DAYTONA_SSH_KEY') || savedKey;
  if (explicit && fs.existsSync(explicit)) {
    return { path: explicit, generated: false, comment: env('DAYTONA_SSH_KEY') ? 'from DAYTONA_SSH_KEY' : 'saved in ~/.qoder/daytona.json' };
  }
  for (const name of DEFAULTS.key_candidates) {
    const p = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(p)) return { path: p, generated: false, comment: `~/.ssh/${name}` };
  }
  if (!generate) return null;
  // A key made for this purpose only, next to the others, never a replacement.
  const dir = path.join(os.homedir(), '.qoder', 'ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, 'daytona_ed25519');
  if (!fs.existsSync(p)) {
    execFileSyncSafe('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'anticodex@daytona', '-f', p]);
    fs.chmodSync(p, 0o600);
  }
  return { path: p, generated: true, comment: 'generated by ANTICODEX' };
}

/** The public half, so the user can paste it into Daytona once. */
export function publicKey() {
  const key = resolveKey({ generate: true });
  if (!key) return { ok: false, error: 'Could not create a key.' };
  let pub = `${key.path}.pub`;
  if (!fs.existsSync(pub)) {
    try { execFileSyncSafe('ssh-keygen', ['-y', '-f', key.path]); } catch { /* no key */ }
  }
  try {
    return { ok: true, path: `${key.path}.pub`, key: fs.readFileSync(pub, 'utf8').trim(), generated: key.generated };
  } catch (e) {
    return { ok: false, error: `No public key at ${pub}: ${String(e.message || e).slice(0, 120)}` };
  }
}

function execFileSyncSafe(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/** Arguments for the system ssh binary. `command` is a single argv element, so a
 *  shell on this side never sees it — the remote shell is the only shell. */
function sshArgs({ command, timeoutMs, port }) {
  const cfg = daytonaConfig();
  const u = normaliseUser(cfg.user.value);
  const target = normaliseTarget(env('DAYTONA_SSH_TARGET')) || (u ? `${u}@${cfg.host.value}` : '');
  if (!target) throw new Error('No Daytona SSH target — set a workspace user (Sandbox → Connect), DAYTONA_SSH_USER or DAYTONA_SSH_TARGET.');
  const key = resolveKey();
  const host = target.split('@').pop();
  const known = DEFAULTS.known_hosts;
  try { fs.mkdirSync(path.dirname(known), { recursive: true }); } catch { /* ignore */ }
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${known}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', `ConnectTimeout=${DEFAULTS.connect_timeout}`,
    '-o', 'ServerAliveInterval=8',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR',
    '-p', String(port || Number(cfg.port.value) || DEFAULTS.ssh_port)
  ];
  if (key) args.push('-i', key.path, '-o', 'IdentitiesOnly=yes');
  // Do not let local ~/.ssh/config rewrite the target we were given.
  args.push('-F', '/dev/null');
  args.push(target);
  if (command) args.push(command);
  void host;
  return { args, target };
}


/**
 * Diagnose the connection, one layer at a time.
 *
 * The product problem: "SSH failed" is one message for four different faults, and
 * the fix for each is in a different place. A filtered port times out; a closed
 * port refuses at once; a bad key gets a banner and then an auth error; an expired
 * workspace user gets a banner and a refusal that looks like the former. Guessing
 * between them wastes the user's time on the one thing that was never wrong.
 *
 * So: walk dns → tcp → banner → auth → tools, stop at the first failure, and give
 * each row exactly one hint. Nothing is skipped — a green row above a red one is
 * the useful output, because it proves where the fault is not.
 *
 * Resolves (never rejects) with
 *   { ok, rows: [{ layer, ok, detail, hint }], failed_at, target, token,
 *     missing, seconds, public_key }
 */
export async function diagnose({ timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const status = daytonaStatus();
  const target = status.ssh?.target || status.source?.target || null;
  const host = status.ssh?.host || status.source?.host || DEFAULTS.host;
  const port = Number(status.ssh?.port || status.source?.port || 22);
  const rows = [];
  const push = (layer, ok, detail, hint) => { rows.push({ layer, ok, detail, hint: ok ? '' : hint }); return ok; };

  const finish = (extra = {}) => ({
    ok: rows.length > 0 && rows.every((r) => r.ok),
    rows,
    failed_at: rows.find((r) => !r.ok)?.layer || null,
    // Always present: the UI reads it, and an absent key is indistinguishable from
    // "nothing is missing" — the worst possible default.
    missing: [],
    target, host, port,
    token: status.token || tokenState(saved().token),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...extra
  });

  // dns -----------------------------------------------------------------------
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true });
    push('dns', addresses.length > 0, `${host} → ${addresses.map((a) => a.address).join(', ') || 'no addresses'}`,
      `The hostname did not resolve. Check the spelling (it is "${host}") and this machine's DNS. Nothing after this can work.`);
  } catch (e) {
    push('dns', false, `${host} did not resolve (${e.code || e.message})`,
      'A DNS failure is local to this machine or a typo — it is not the workspace, and no token will fix it.');
    return finish();
  }

  // tcp -----------------------------------------------------------------------
  const tcp = await new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port });
    let done = false;
    const end = (ok, detail) => { if (done) return; done = true; try { socket.destroy(); } catch { /* already gone */ } resolve({ ok, detail, ms: Date.now() - t0 }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => end(true, `connected in ${Date.now() - t0} ms`));
    socket.once('timeout', () => end(false, `no answer in ${timeoutMs} ms`));
    socket.once('error', (e) => end(false, e.code === 'ECONNREFUSED'
      ? `refused (nothing is listening on port ${port})`
      : `${e.code || 'error'}: ${e.message}`));
  });
  const tcpOk = push('tcp', tcp.ok, `${host}:${port} ${tcp.detail}`,
    /refus/i.test(tcp.detail)
      ? 'The connection was refused, so the network path is fine and nothing is listening on that port. Check the port, not the firewall.'
      : `Nothing answered within ${timeoutMs} ms. That is a drop, usually a firewall or a proxy on the way out — the workspace cannot see this request.`);
  if (!tcpOk) return finish({ public_key: safePublicKey() });

  // banner --------------------------------------------------------------------
  // sshd speaks first. A socket that is accepted and then closed with no bytes is
  // not a key problem and must not be reported as one.
  const banner = await new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port });
    let buf = '';
    let settled = false;
    const end = (ok, detail) => {
      if (settled) return; settled = true;
      try { socket.destroy(); } catch { /* gone */ }
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on('data', (c) => {
      buf += c.toString('utf8');
      if (/^SSH-\d/.test(buf.trim()) || buf.includes('SSH-')) end(true, `banner: ${buf.trim().split('\n')[0].slice(0, 60)}`);
    });
    socket.once('connect', () => {
      socket.setTimeout(timeoutMs);
      setTimeout(() => { if (!settled) end(false, 'connected, then the host closed without an SSH banner'); }, 2500);
    });
    socket.once('close', () => { if (!settled) end(false, 'connected, then the host closed without an SSH banner'); });
    socket.once('error', (e) => { if (!settled) end(false, `${e.code || 'error'} before any banner`); });
    socket.once('timeout', () => {
      end(false, buf ? `partial banner: ${buf.slice(0, 40)}` : `connected, then silence for ${Date.now() - t0} ms`);
    });
  });
  const bannerOk = push('banner', banner.ok, `${host} ${banner.detail}`,
    /closed without|silence/i.test(banner.detail)
      ? 'This is not a key problem and not the wrong username: sshd never spoke, so no key was ever offered. Something in front of the host accepts the connection and drops it — retry from another network, or use the REST path with DAYTONA_API_KEY.'
      : 'The host answered, but not with an SSH banner — usually an HTTP proxy or a load balancer on port 22.');
  if (!bannerOk) return finish({ public_key: safePublicKey() });

  // auth ----------------------------------------------------------------------
  let auth = { ok: false, detail: '' };
  try {
    const out = await sshExec('true', { timeoutMs });
    auth = out.ok
      ? { ok: true, detail: `a shell opened and ran \`true\` in ${out.duration_ms ?? 0} ms` }
      : { ok: false, detail: String(out.stderr || out.error || 'the shell refused').split('\n').filter(Boolean).slice(-2).join(' · ') };
  } catch (e) {
    auth = { ok: false, detail: e.message };
  }
  const authOk = push('auth', auth.ok, auth.detail,
    'The key was refused. Add the public key below to the workspace in Daytona, or save a fresh workspace token if this one has expired.');
  if (!authOk) return finish({ public_key: safePublicKey() });

  // tools ---------------------------------------------------------------------
  // What is installed, not what ought to be. The install checklist repairs gaps.
  const recipe = setupRecipe().map((r) => r.id || r.name || r.label).filter(Boolean);
  let missing = [];
  try {
    const out = await sshExec('command -v node python3 rg qodercli 2>/dev/null || true', { timeoutMs });
    const found = String(out.stdout || '').split('\n').map((l) => path.basename(l.trim())).filter(Boolean);
    const want = ['node', 'python3', 'rg', 'qodercli'];
    missing = want.filter((w) => !found.includes(w));
    push('tools', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'node, python3, rg and qodercli are all on PATH',
      `Run the install checklist on the Sandbox page — it installs ${missing.join(', ')} without a prompt.`);
  } catch (e) {
    missing = recipe;
    push('tools', false, `could not read PATH: ${e.message}`, 'The shell works but the inventory did not; run the install checklist.');
  }

  return finish({ missing, public_key: safePublicKey() });
}

/** The public half, or why there is not one. Never throws. */
function safePublicKey() {
  try { return publicKey(); } catch { return null; }
}

/**
 * Run one command on the Daytona box.
 *
 * Resolves (never rejects) with `{ ok, exit_code, stdout, stderr, duration_ms,
 * target, timed_out }` — the same shape `lib/sandbox.js` returns, so a caller can
 * swap the two without special-casing.
 */
export async function sshExec(command, { timeoutMs = DEFAULT_TIMEOUT, cwd, env: extraEnv } = {}) {
  const started = Date.now();
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'A command is required.', target: 'daytona' };
  if (cmd.length > MAX_CMD) return { ok: false, error: `Command is longer than ${MAX_CMD} characters.`, target: 'daytona' };
  const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT, 1000), HARD_TIMEOUT);
  let prepared;
  try {
    prepared = sshArgs({ command: wrap(cmd, { cwd, extraEnv }), timeoutMs: limit });
  } catch (e) {
    return { ok: false, error: String(e.message || e), configured: false, target: 'daytona' };
  }
  return new Promise((resolve) => {
    execFile('ssh', prepared.args, { timeout: limit, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && err.killed);
      // A signal alone is what this looked at before, and `kex_exchange_identification:
      // read: Connection reset by peer` exits 255 with no signal — so a fast network
      // refusal was reported as "timed out" (it took 38 ms). A real timeout leaves text.
      const networkish = /Connection reset by peer|Connection refused|Connection timed out|Network is unreachable|No route to host|Connection closed|kex_exchange|banner exchange/i.test(String(stderr || ''));
      const out = cap(stdout);
      const errText = cap(stderr);
      const code = err ? (typeof err.code === 'number' ? err.code : (timedOut ? 124 : 1)) : 0;
      const authish = /Permission denied|Host key verification failed|Could not resolve hostname|Connection refused|Connection timed out|No such file or directory: .*known_hosts/i.test(errText);
      resolve({
        ok: !err,
        exit_code: code,
        stdout: out.text,
        stderr: errText.text,
        truncated: out.truncated || errText.truncated,
        timed_out: timedOut && !networkish,
        network_refused: networkish,
        duration_ms: Date.now() - started,
        target: `daytona:${prepared.target}`,
        hint: networkish
          ? `ssh.app.daytona.io was reached but refused the connection (${String(stderr || '').split('\n')[0].trim() || 'no reason given'}). Port 22 is filtered on this network — a common hotel/office rule. Run the same command from a network that allows outbound 22:` + `\n  ssh -p ${Number(daytonaConfig().port.value) || 22} ${prepared.target.replace(':22', '')}`
          : authish
          ? 'Daytona refused the connection. Check the workspace user, that your key is registered on the workspace, and that port 22 is reachable from this machine.'
          : undefined
      });
    });
  });
}

function wrap(command, { cwd, extraEnv }) {
  const parts = [];
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv).slice(0, 20)) {
      if (!/^[A-Z_][A-Z0-9_]{0,40}$/i.test(k)) continue;
      parts.push(`${k}=${shellQuote(String(v))}`);
    }
  }
  const cd = cwd ? `cd ${shellQuote(String(cwd))} && ` : '';
  parts.push(cd + command);
  return parts.join(' ');
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function cap(text) {
  const s = String(text || '');
  if (Buffer.byteLength(s) <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_OUTPUT) + `\n… output truncated at ${MAX_OUTPUT} bytes`, truncated: true };
}

/** Is the box reachable and which user are we? */
export async function sshProbe() {
  const r = await sshExec('printf "%s@%s\\n" "$(whoami)" "$(hostname)"; uname -sr', { timeoutMs: 15000 });
  return { ...r, reachable: r.ok, identity: r.ok ? String(r.stdout).trim().split('\n')[0] : null };
}

/** List files: `{ name, type, size, mtime }`, parsed from `find`, not `ls`. */
export async function sshList(dir = '.') {
  const target = shellQuote(String(dir || '.'));
  const script = `cd ${target} 2>/dev/null || { echo "__ERR__ no such directory"; exit 3; }; `
    + `find . -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n' 2>/dev/null | head -500`;
  const r = await sshExec(script, { timeoutMs: 15000 });
  if (!r.ok) return { ...r, entries: [], error: r.stderr?.includes('__ERR__') ? `No such directory: ${dir}` : r.error };
  const entries = String(r.stdout).split('\n').filter(Boolean).map((line) => {
    const [name, type, size, mtime] = line.split('\t');
    return { name, type: type === 'd' ? 'dir' : 'file', size: Number(size) || 0, mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ...r, path: dir, entries };
}

/** Read one file, capped; refuses to stream a binary into JSON. */
export async function sshRead(file) {
  const r = await sshExec(`head -c 262144 ${shellQuote(file)}`, { timeoutMs: 15000 });
  const binary = /\u0000/.test(String(r.stdout || ''));
  return { ...r, path: file, content: binary ? null : r.stdout, binary, bytes: Buffer.byteLength(String(r.stdout || '')) };
}

/** Write one file through a heredoc — no local temp file, no scp dependency. */
export async function sshWrite(file, content) {
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) return { ok: false, error: 'Refusing to write more than 2 MB over one SSH call.' };
  const marker = `ACX_EOF_${crypto.randomBytes(8).toString('hex')}`;
  const script = `mkdir -p "$(dirname ${shellQuote(file)})" && cat > ${shellQuote(file)} <<'${marker}'\n${text}\n${marker}\nwc -c < ${shellQuote(file)}`;
  return sshExec(script, { timeoutMs: 20000 });
}

// ---------------------------------------------------------------------------
// REST (needs DAYTONA_API_KEY)
// ---------------------------------------------------------------------------

async function api(pathname, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const key = env('DAYTONA_API_KEY');
  if (!key) return { ok: false, error: 'No DAYTONA_API_KEY set — REST operations need one; SSH does not.' };
  const base = (env('DAYTONA_API_URL') || DEFAULTS.api_url).replace(/\/+$/, '');
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(Number(timeoutMs) || 20000, 60000));
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
    if (!res.ok) return { ok: false, status: res.status, error: messageFor(res.status, data), data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: `Could not reach ${base}: ${String(e.message || e).slice(0, 160)}` };
  } finally {
    clearTimeout(t);
  }
}

function messageFor(status, data) {
  const detail = data?.message || data?.error || data?.raw || '';
  if (status === 401) return 'Daytona rejected the API key (401). Create a new key in the Daytona dashboard.';
  if (status === 404) return `Daytona has no such resource (404)${detail ? `: ${String(detail).slice(0, 120)}` : ''}.`;
  if (status === 429) return 'Daytona rate limited this key (429) — try again shortly.';
  return `Daytona answered ${status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Provisioning the workspace
// ---------------------------------------------------------------------------
//
// "Install the sandbox" means: make the remote box usable by this app in one run,
// and then say — per step — what actually worked. Nothing is claimed that was not
// verified by a command whose output was read.
//
// What gets installed, and why each one earns its place:
//   git, curl, jq, ripgrep, fd    the agent's own tools (grep/glob shell out to rg)
//   node + npm (fnm/nvm if absent) the workspace runs JS, and the app is JS
//   python3 + pip                 the workspace runs Python too
//   qodercli                      the local agent, so Studio can delegate to it there
//   skillui, vibesec              the two CLIs this machine already had installed
//
// Every step is idempotent and skippable: `--only` runs one. The result is a list
// of `{ id, ok, skipped, seconds, detail }` — the UI renders it as a checklist, and
// a failure is a line in that list, not an exception.

export const PROVISION_STEPS = Object.freeze([
  {
    id: 'probe',
    label: 'Reach the box',
    why: 'Nothing else can be reported honestly until a command comes back.',
    command: 'uname -a; id -un; echo "HOME=$HOME"; df -h "$HOME" | tail -1'
  },
  {
    id: 'base',
    label: 'Base packages (git, curl, jq, ripgrep, fd)',
    why: 'The agent shells out to these for grep/glob and for cloning.',
    command: [
      'set -e',
      'SUDO=""; command -v sudo >/dev/null 2>&1 && SUDO="sudo"',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  $SUDO apt-get update -qq >/dev/null 2>&1 || true',
      '  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq git curl jq ripgrep fd-find unzip >/dev/null 2>&1 || true',
      'elif command -v apk >/dev/null 2>&1; then',
      '  $SUDO apk add --no-cache git curl jq ripgrep fd unzip >/dev/null 2>&1 || true',
      'fi',
      'for b in git curl jq rg; do printf "%s=%s\n" "$b" "$(command -v $b || echo missing)"; done'
    ].join('\n')
  },
  {
    id: 'node',
    label: 'Node.js 22 + npm',
    why: 'The workspace runs JavaScript, and this app is JavaScript.',
    command: [
      'set -e',
      'if command -v node >/dev/null 2>&1; then node -v; else',
      '  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh 2>/dev/null && (sudo -n bash /tmp/nodesource.sh >/dev/null 2>&1 || bash /tmp/nodesource.sh >/dev/null 2>&1) && (sudo -n apt-get install -y -qq nodejs >/dev/null 2>&1 || apt-get install -y -qq nodejs >/dev/null 2>&1) || true',
      '  command -v node >/dev/null 2>&1 && node -v || echo "node=missing"',
      'fi',
      'command -v npm >/dev/null 2>&1 && npm -v || echo "npm=missing"'
    ].join('\n')
  },
  {
    id: 'python',
    label: 'Python 3 + pip',
    why: 'The workspace runs Python too, and VibeSec is a Python MCP server.',
    command: [
      'if command -v python3 >/dev/null 2>&1; then python3 -V; else echo "python3=missing"; fi',
      'if command -v pip3 >/dev/null 2>&1 || python3 -m pip --version >/dev/null 2>&1; then python3 -m pip --version 2>/dev/null | head -1; else echo "pip=missing"; fi'
    ].join('\n')
  },
  {
    id: 'qodercli',
    label: 'qodercli (the local agent)',
    why: 'Studio can delegate a task to the Qoder CLI on this box instead of this laptop.',
    command: [
      'set -e',
      'if command -v qodercli >/dev/null 2>&1; then qodercli --version 2>/dev/null || echo "qodercli present"; else',
      '  (npm i -g @qoder-ai/qodercli >/dev/null 2>&1 || npm i -g @qoder-ai/qodercli --unsafe-perm >/dev/null 2>&1) || true',
      '  command -v qodercli >/dev/null 2>&1 && (qodercli --version 2>/dev/null || echo "qodercli installed") || echo "qodercli=missing"',
      'fi'
    ].join('\n'),
    optional: true
  },
  {
    id: 'skillui',
    label: 'skillui',
    why: 'The skill manager this machine already uses; keeps the two machines consistent.',
    command: 'if command -v skillui >/dev/null 2>&1; then skillui --version; else npm i -g skillui >/dev/null 2>&1 && skillui --version || echo "skillui=missing"; fi',
    optional: true
  },
  {
    id: 'vibesec',
    label: 'vibesec',
    why: 'The security scanner, as an MCP server and a CLI.',
    command: [
      'if command -v vibesec >/dev/null 2>&1; then vibesec --version 2>/dev/null || echo "vibesec present"; else',
      '  python3 -m pip install --user --quiet vibesec 2>/dev/null && (vibesec --version 2>/dev/null || echo "vibesec installed") || echo "vibesec=missing"',
      'fi'
    ].join('\n'),
    optional: true
  },
  {
    id: 'workspace',
    label: 'Agent workspace + skill roots',
    why: 'The directory the agent works in, and the roots Qoder/Codex/Claude read.',
    command: [
      'set -e',
      'mkdir -p ~/.anticodex/workspace ~/.qoder/skills ~/.codex/skills',
      'cd ~/.anticodex/workspace && (git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init -q)',
      'printf "ANTICODEX agent workspace. Files the agent writes land here.\n" > ~/.anticodex/workspace/README.md',
      'echo "workspace=$(cd ~/.anticodex/workspace && pwd)"; echo "skills=$(ls -1 ~/.qoder/skills | wc -l) installed"'
    ].join('\n')
  },
  {
    id: 'report',
    label: 'Summary',
    why: 'One block the UI can show as the finished state.',
    command: [
      'printf "host=%s\n" "$(hostname)"',
      'printf "node=%s\n" "$(command -v node >/dev/null 2>&1 && node -v || echo missing)"',
      'printf "python=%s\n" "$(command -v python3 >/dev/null 2>&1 && python3 -V 2>&1 | cut -d" " -f2 || echo missing)"',
      'printf "rg=%s\n" "$(command -v rg >/dev/null 2>&1 && echo yes || echo no)"',
      'printf "qodercli=%s\n" "$(command -v qodercli >/dev/null 2>&1 && echo yes || echo no)"',
      'printf "skills=%s\n" "$(ls -1 ~/.qoder/skills 2>/dev/null | wc -l)"'
    ].join('\n')
  }
]);

/**
 * Run the provisioning checklist over SSH.
 *
 * Sequential on purpose: a step that needs node must not race the step that
 * installs it, and one failing step must not abandon the others (`optional` marks
 * the ones whose failure is survivable). `onStep` is called after each, so the
 * caller can stream the checklist as it happens.
 */
export async function provisionWorkspace({ only = null, timeoutMs = 180_000, onStep } = {}) {
  const status = daytonaStatus();
  if (!status.configured || !status.ssh?.available) {
    return {
      ok: false, error: 'No Daytona workspace is connected, so there is nothing to provision.',
      hint: 'Save a workspace token on the Sandbox page first.',
      steps: []
    };
  }
  const t = status.token;
  if (t?.known && t.state === 'expired') {
    return {
      ok: false, error: `The saved workspace token expired ${Math.abs(t.minutes_left)} minutes ago.`,
      hint: 'Daytona tokens last 1,440 minutes. Paste a fresh one on the Sandbox page and run this again.',
      steps: []
    };
  }
  const list = only ? PROVISION_STEPS.filter((s) => s.id === only) : PROVISION_STEPS;
  if (!list.length) return { ok: false, error: `No provisioning step called "${only}".`, steps: [] };

  const results = [];
  const started = Date.now();
  for (const step of list) {
    const t0 = Date.now();
    let out;
    try {
      out = await sshExec(step.command, { timeoutMs });
    } catch (e) {
      out = { ok: false, stderr: String(e?.message || e) };
    }
    // "missing" in a step's own output is a failure even when ssh exited 0: the
    // command succeeded at reporting that the tool is not there, which is not the
    // same thing as installing it.
    const reported = `${out.stdout || ''}\n${out.stderr || ''}`;
    const missing = /(^|\n)\s*[a-z_]+=missing\s*(\n|$)/i.test(reported) || /(^|\n)\s*\S+=missing(\n|$)/.test(reported);
    const row = {
      id: step.id,
      label: step.label,
      optional: Boolean(step.optional),
      ok: Boolean(out.ok) && !missing,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      exit_code: out.exit_code ?? null,
      detail: picked(reported),
      error: out.ok && missing ? 'reported a missing binary' : (out.error || (out.ok ? undefined : firstLine(out.stderr || out.stdout)))
    };
    results.push(row);
    if (typeof onStep === 'function') { try { onStep(row); } catch { /* observer */ } }
    // A hard failure on a required step stops the run: the rest would be noise.
    if (!row.ok && !step.optional) break;
  }
  const required = results.filter((r) => !r.optional);
  return {
    ok: required.every((r) => r.ok),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    steps: results,
    summary: summarise(results),
    target: status.ssh.target,
    token: t
  };
}

function firstLine(s) { return String(s || '').split('\n').find((l) => l.trim())?.trim().slice(0, 300) || ''; }

/** Keep the lines that answer "did it work", not the installer's chatter. */
function picked(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => /^[A-Za-z0-9_.-]+=/.test(l) || /^(Linux|Darwin|v?\d+\.\d+)/.test(l) || /^(git|node|npm|python|pip|rg|fd)/.test(l));
  return (useful.length ? useful : lines).slice(0, 12).join('\n');
}

function summarise(results) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.optional);
  const skipped = results.filter((r) => !r.ok && r.optional);
  return {
    ok, total: results.length,
    failed: failed.map((r) => r.label),
    optional_missing: skipped.map((r) => r.label),
    line: failed.length
      ? `${failed.length} required step${failed.length === 1 ? '' : 's'} failed: ${failed.map((r) => r.label).join(', ')}.`
      : skipped.length
        ? `Ready — ${ok}/${results.length} steps ok; optional: ${skipped.map((r) => r.label).join(', ')} not available (the agent works without them).`
        : `Ready — all ${results.length} steps ok.`
  };
}

export const listSandboxes = () => api('/sandbox');
export const getSandbox = (id) => api(`/sandbox/${encodeURIComponent(id)}`);
export const createSandbox = (body = {}) => api('/sandbox', { method: 'POST', body });
export const deleteSandbox = (id) => api(`/sandbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const startSandbox = (id) => api(`/sandbox/${encodeURIComponent(id)}/start`, { method: 'POST' });
export const stopSandbox = (id) => api(`/sandbox/${encodeURIComponent(id)}/stop`, { method: 'POST' });

/** Run a command through the toolbox endpoint the SDK uses. */
export async function apiExec(id, command, { cwd, timeoutMs } = {}) {
  const r = await api(`/toolbox/${encodeURIComponent(id)}/toolbox/process/exec`, {
    method: 'POST',
    timeoutMs: (Number(timeoutMs) || 20000) + 5000,
    body: { command, cwd, timeout: Math.round((Number(timeoutMs) || 20000) / 1000) }
  });
  if (!r.ok) return { ...r, target: `daytona:${id}` };
  const d = r.data || {};
  return {
    ok: d.exitCode === 0 || d.exit_code === 0 || d.exitCode === undefined,
    exit_code: d.exitCode ?? d.exit_code ?? 0,
    stdout: String(d.result || d.stdout || ''),
    stderr: String(d.stderr || ''),
    target: `daytona:${id}`
  };
}

// ---------------------------------------------------------------------------
// One entry point
// ---------------------------------------------------------------------------

/**
 * Run a command wherever the configuration says it should run.
 *
 * Order: an explicit `target` (`local`|`daytona`), then ANTICODEX_SANDBOX, then
 * "daytona if configured, otherwise local". A Daytona failure is reported, not
 * silently retried locally — an agent that wrote a file to the wrong machine is
 * worse than one that says it could not.
 */
export async function execAnywhere(command, { target, timeoutMs, cwd, env: extraEnv, sandboxId } = {}) {
  const status = daytonaStatus();
  const want = target === 'local' || target === 'daytona'
    ? target
    : (status.mode === 'daytona' && status.configured ? 'daytona' : 'local');
  if (want === 'local') {
    const { runLocal } = await import('./sandbox.js');
    return runLocal(command, { timeoutMs, cwd, env: extraEnv });
  }
  if (sandboxId && status.api.available) {
    const r = await apiExec(sandboxId, command, { cwd, timeoutMs });
    if (r.ok || r.stderr !== undefined) return r;
    // fall through to SSH: a sandbox id without toolbox access still has SSH
  }
  return sshExec(command, { timeoutMs, cwd, env: extraEnv });
}

/** The commands a QR/terminal "one paste" setup needs, shown honestly. */
export function setupRecipe({ user } = {}) {
  const cfg = daytonaConfig();
  const u = normaliseUser(user || cfg.user.value) || '<workspace-user>';
  const key = resolveKey({ generate: false });
  return {
    fields: {
      'Host address': cfg.host.value,
      Port: String(Number(cfg.port.value) || DEFAULTS.ssh_port),
      // Verbatim, including the `ssh ` prefix, because that is exactly what
      // Daytona's console shows in the field this table is copied into.
      Username: `ssh ${u}`,
      Authentication: key ? `SSH key: ${key.path}` : 'First try "Use local SSH config and keys"',
      Name: 'Daytona'
    },
    commands: [
      `ssh -p ${Number(cfg.port.value) || DEFAULTS.ssh_port} ${u}@${cfg.host.value}`,
      `export DAYTONA_SSH_USER="${u}"`,
      `export DAYTONA_SSH_HOST="${cfg.host.value}"`,
      'export ANTICODEX_SANDBOX=daytona'
    ],
    note: 'Daytona calls the username `ssh <workspace-user>`; the literal "ssh " prefix is part of the value in their console.'
  };
}
