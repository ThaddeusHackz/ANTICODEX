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

const env = (k) => (process.env[k] ? String(process.env[k]).trim() : '');

/** Daytona's console shows the username as `ssh <workspace-user>`. The `ssh` is a
 *  label, not part of the login name, so strip it (but keep showing it verbatim in
 *  the connection fields, because that is what the user is copying from). */
export function normaliseUser(raw) {
  return String(raw || '').replace(/^ssh\s+/i, '').trim();
}

/** Everything the UI needs to explain the current state, without leaking a key. */
export function daytonaStatus() {
  const rawUser = env('DAYTONA_SSH_USER');
  const user = normaliseUser(rawUser);
  const target = env('DAYTONA_SSH_TARGET') || (user ? `${user}@${env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host}` : '');
  const key = resolveKey();
  const mode = env('ANTICODEX_SANDBOX') === 'local' ? 'local' : (target || env('DAYTONA_API_KEY') ? 'daytona' : 'local');
  return {
    ok: true,
    configured: Boolean(target || env('DAYTONA_API_KEY')),
    mode,
    ssh: {
      available: Boolean(target),
      host: env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host,
      port: Number(env('DAYTONA_SSH_PORT')) || DEFAULTS.ssh_port,
      user: user || null,
      user_as_shown: rawUser || null,
      target: target || null,
      key: key ? { path: key.path, generated: Boolean(key.generated), comment: key.comment } : null,
      ssh_binary: which('ssh'),
      known_hosts: DEFAULTS.known_hosts
    },
    api: {
      available: Boolean(env('DAYTONA_API_KEY')),
      url: env('DAYTONA_API_URL') || DEFAULTS.api_url
    },
    // The exact rows to type into a client that asks for them by name (Qoder's
    // "Daytona" connection form asks in this order).
    fields: {
      'Host address': env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host,
      Port: String(Number(env('DAYTONA_SSH_PORT')) || DEFAULTS.ssh_port),
      Username: user ? `ssh ${user}` : '(set DAYTONA_SSH_USER)',
      Authentication: 'SSH key — this app uses ~/.ssh, or generates one for you',
      Name: 'Daytona'
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
  const explicit = env('DAYTONA_SSH_KEY');
  if (explicit && fs.existsSync(explicit)) return { path: explicit, generated: false, comment: 'from DAYTONA_SSH_KEY' };
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
  const u = normaliseUser(env('DAYTONA_SSH_USER'));
  const target = env('DAYTONA_SSH_TARGET') || (u ? `${u}@${env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host}` : '');
  if (!target) throw new Error('No Daytona SSH target — set DAYTONA_SSH_USER or DAYTONA_SSH_TARGET.');
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
    '-p', String(port || Number(env('DAYTONA_SSH_PORT')) || DEFAULTS.ssh_port)
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
      const timedOut = Boolean(err && (err.killed || /ETIMEDOUT|timeout/i.test(String(err.message || ''))));
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
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        target: `daytona:${prepared.target}`,
        hint: authish
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
  const u = normaliseUser(user || env('DAYTONA_SSH_USER')) || '<workspace-user>';
  const key = resolveKey({ generate: false });
  return {
    fields: {
      'Host address': env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host,
      Port: String(Number(env('DAYTONA_SSH_PORT')) || DEFAULTS.ssh_port),
      Username: `ssh ${u}`,
      Authentication: key ? `SSH key: ${key.path}` : 'First try "Use local SSH config and keys"',
      Name: 'Daytona'
    },
    commands: [
      `ssh -p ${Number(env('DAYTONA_SSH_PORT')) || DEFAULTS.ssh_port} ${u}@${env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host}`,
      `export DAYTONA_SSH_USER="${u}"`,
      `export DAYTONA_SSH_HOST="${env('DAYTONA_SSH_HOST') || DEFAULTS.ssh_host}"`,
      'export ANTICODEX_SANDBOX=daytona'
    ],
    note: 'Daytona calls the username `ssh <workspace-user>`; the literal "ssh " prefix is part of the value in their console.'
  };
}
