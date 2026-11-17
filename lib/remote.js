// Remote SSH sandbox — run a snippet on a machine you own (Daytona, a dev box,
// a CI runner) from the same Sandbox page that runs it locally.
//
// This is deliberately *not* a general "run this command over there" relay. A
// browser may name a saved profile and a language, never an arbitrary command:
// the command line is built here from a fixed table, the code is uploaded over
// stdin to a validated temp path, and the remote side gets a wall-clock limit.
//
// What is stored, and what is not:
//   * host, port, username, label and an optional private-key *path* are saved
//     in data/remote.json (mode 0600). The key itself never enters this process.
//   * a password is never accepted. Password auth cannot be non-interactive via
//     OpenSSH without sshpass, and installing sshpass to make "just paste your
//     password" work is a worse idea than asking for a key or ssh-agent.
//   * the default auth is "local SSH config and keys" — the exact first choice
//     in the user's SSH client. `BatchMode=yes` makes a missing key an error
//     instead of a prompt that would hang a headless server.
//
// The feature is loopback/desktop-only at the bridge, like the local sandbox:
// a hosted deployment must not become an SSH jumping host. The module itself is
// import-safe and network-free until a function is called, so it is unit-tested
// without an SSH server.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_PATH } from './keys.js';

const STORE = path.join(path.resolve(DATA_PATH), 'remote.json');
const MAX_CODE = 200_000;
const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT = 15_000;
const MAX_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 12;
const MAX_PROFILES = 20;

const LANGS = Object.freeze({
  node: { id: 'node', label: 'JavaScript (Node)', ext: 'mjs', bin: 'node', args: ['--max-old-space-size=256'] },
  python: { id: 'python', label: 'Python 3', ext: 'py', bin: 'python3', args: ['-I', '-B'] },
  bash: { id: 'bash', label: 'Shell', ext: 'sh', bin: 'bash', args: ['--noprofile', '--norc'] }
});

const HOST_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._-]{1,128}$/;
const LABEL_RE = /^[A-Za-z0-9 ._@:+-]{1,64}$/;
// Daytona's "ssh <access-string>@ssh.app.daytona.io" puts a bearer credential
// in the username position. It is a 24-hour access string, not an identity:
// store it (0600) but never echo it back or show it in a profile list.
const SECRET_USER_RE = /^[A-Za-z0-9_-]{24,}$/;
const DAYTONA_HOST_RE = /(^|\.)daytona\.io$/i;

/** Split a pasted ssh command into fields without invoking a shell. Supports the
 *  shape people actually copy: `ssh user@host`, `ssh -p 2222 user@host`, and
 *  `user@host:2222`. Unknown flags are refused rather than silently ignored —
 *  a command that means something else must not be saved as if it didn't. */
export function parseSshTarget(raw) {
  const text = String(raw || '').trim().replace(/^[$>]\s*/, '');
  if (!text) return { ok: false, error: 'Paste the ssh command (for example: ssh user@ssh.app.daytona.io).' };
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[1] ?? m[2] ?? m[3]);
  if (!tokens.length) return { ok: false, error: 'That ssh command is empty.' };

  let username = '';
  let host = '';
  let port = 22;
  let keyPath = '';
  let i = 0;
  if (/^ssh(\.exe)?$/i.test(tokens[0])) i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-p' || t === '--port') { port = Number(tokens[++i]); continue; }
    if (/^-p\d+$/.test(t)) { port = Number(t.slice(2)); continue; }
    if (t === '-i') { keyPath = String(tokens[++i] || ''); continue; }
    if (t === '-l') { username = String(tokens[++i] || ''); continue; }
    if (t === '--') { i++; break; }
    if (t.startsWith('-')) {
      return { ok: false, error: `The flag ${t} is not supported here. Paste a plain "ssh user@host" (optionally -p PORT or -i KEY) and set the rest in the fields.` };
    }
    const target = t;
    const at = target.lastIndexOf('@');
    if (at > 0) { username = target.slice(0, at); host = target.slice(at + 1); }
    else host = target;
    const colon = host.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1)) && !host.includes(']')) {
      port = Number(host.slice(colon + 1));
      host = host.slice(0, colon);
    }
  }
  if (!host) return { ok: false, error: 'No host found. Expected something like ssh user@ssh.app.daytona.io.' };
  if (!username) return { ok: false, error: 'No username found. Expected something like ssh user@ssh.app.daytona.io.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `Port ${port} is not between 1 and 65535.` };
  return { ok: true, username, host, port, key_path: keyPath || null };
}

/** True when the "username" is really a bearer access string (Daytona). */
export function isAccessString(host, username) {
  return SECRET_USER_RE.test(String(username || '')) && DAYTONA_HOST_RE.test(String(host || ''));
}

function redactCredential(value) {
  const s = String(value || '');
  if (s.length < 10) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function accountKey(account) {
  const s = String(account || 'default');
  return /^[\w.-]{1,40}$/.test(s) && s !== '.' && s !== '..' ? s : 'default';
}

function ensureStore() {
  const dir = path.dirname(STORE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE)) fs.writeFileSync(STORE, JSON.stringify({ version: 1, profiles: {} }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch { /* Windows / read-only fs */ }
}

function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (!d || typeof d !== 'object') return { version: 1, profiles: {} };
    if (!d.profiles || typeof d.profiles !== 'object') d.profiles = {};
    return d;
  } catch {
    return { version: 1, profiles: {} };
  }
}

function writeStore(store) {
  ensureStore();
  const tmp = `${STORE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE);
  try { fs.chmodSync(STORE, 0o600); } catch { /* best effort */ }
}

/** The public shape. `key_path` is a path, not a secret; it is included because
 *  the UI must show which identity will be used. Nothing else about auth is. */
export function publicProfile(p) {
  const secret = Boolean(p.secret_username);
  return {
    id: p.id,
    label: p.label,
    host: p.host,
    port: p.port,
    // An access string is a credential, not an identity: return a hint and let
    // the UI keep the stored value unless the user pastes a replacement.
    username: secret ? '' : p.username,
    username_hint: secret ? redactCredential(p.username) : null,
    has_credential: secret,
    key_path: p.key_path || null,
    auth: p.auth || 'keys',
    added_at: p.added_at || null,
    updated_at: p.updated_at || null
  };
}

export function validateProfile(input = {}) {
  // Accept the exact thing a Daytona / hosting dashboard shows: a full ssh
  // command. Only fields that were not given explicitly are filled from it, so
  // the form remains authoritative when both are present.
  let src = input || {};
  const pasted = src.ssh_command || src.target || '';
  if (pasted && (!src.username || !src.host)) {
    const parsed = parseSshTarget(pasted);
    if (!parsed.ok) return { error: parsed.error };
    src = {
      ...src,
      username: src.username || parsed.username,
      host: src.host || parsed.host,
      port: src.port || parsed.port,
      key_path: src.key_path || parsed.key_path || ''
    };
  }
  const host = String(src.host || '').trim();
  if (!host) return { error: 'Host address is required (for example ssh.app.daytona.io).' };
  if (!HOST_RE.test(host) || host.includes('..')) return { error: 'Host address is not a valid DNS name or IP address.' };
  const port = Number(src.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be an integer from 1 to 65535.' };
  const username = String(src.username || '').trim();
  if (!username) return { error: 'Username is required (paste the whole ssh command if the dashboard gave you one).' };
  if (!USER_RE.test(username)) return { error: 'Username contains characters OpenSSH will not accept here.' };
  const label = String(src.label || `${username}@${host}`).trim();
  if (!LABEL_RE.test(label)) return { error: 'Label must be 1–64 characters (letters, numbers, spaces and . _ @ : + -).' };
  let keyPath = src.key_path ? String(src.key_path).trim() : '';
  if (keyPath) {
    if (keyPath === '~' || keyPath.startsWith('~/')) keyPath = path.join(os.homedir(), keyPath.slice(2));
    if (!path.isAbsolute(keyPath)) return { error: 'Key path must be absolute (or start with ~/).' };
    if (!fs.existsSync(keyPath)) return { error: `Key file does not exist: ${keyPath}` };
    try { if (!fs.statSync(keyPath).isFile()) return { error: `Key path is not a file: ${keyPath}` }; } catch { /* checked below */ }
  }
  const auth = src.auth === 'agent' ? 'agent' : 'keys';
  const secretUsername = Boolean(src.secret_username) || isAccessString(host, username);
  if (secretUsername && label === `${username}@${host}`) {
    // Never put the credential into the default label either.
    return {
      profile: { label: `${redactCredential(username)}@${host}`, host, port, username, key_path: keyPath || null, auth, secret_username: true }
    };
  }
  return { profile: { label, host, port, username, key_path: keyPath || null, auth, ...(secretUsername ? { secret_username: true } : {}) } };
}

export function listRemoteProfiles(account) {
  const store = readStore();
  const list = store.profiles[accountKey(account)];
  return Array.isArray(list) ? list.map(publicProfile) : [];
}

export function saveRemoteProfile(account, input = {}) {
  const store = readStore();
  const key = accountKey(account);
  const list = Array.isArray(store.profiles[key]) ? store.profiles[key] : [];
  const id = input.id && /^[a-z0-9-]{4,40}$/.test(String(input.id)) ? String(input.id) : `ssh-${crypto.randomBytes(4).toString('hex')}`;
  const existing = list.find((p) => p.id === id);
  // Editing a profile whose username is a hidden access string: an empty field
  // means "keep the credential", never "erase it".
  const merged = {
    ...input,
    ...(existing && !String(input.username || '').trim() && !input.ssh_command && !input.target
      ? { username: existing.username, secret_username: existing.secret_username }
      : {}),
    ...(existing && !String(input.label || '').trim() ? { label: existing.label } : {})
  };
  const v = validateProfile(merged);
  if (v.error) return { ok: false, error: v.error };
  const now = new Date().toISOString();
  if (!existing && list.length >= MAX_PROFILES) return { ok: false, error: `At most ${MAX_PROFILES} SSH profiles are kept per account.` };
  const row = { id, ...v.profile, added_at: existing?.added_at || now, updated_at: now };
  // A save is also the "use this one" action: most-recent first.
  store.profiles[key] = [row, ...list.filter((p) => p.id !== id)];
  writeStore(store);
  return { ok: true, profile: publicProfile(row), profiles: store.profiles[key].map(publicProfile) };
}

export function deleteRemoteProfile(account, id) {
  const store = readStore();
  const key = accountKey(account);
  const list = Array.isArray(store.profiles[key]) ? store.profiles[key] : [];
  const next = list.filter((p) => p.id !== String(id || ''));
  if (next.length === list.length) return { ok: false, error: 'No such SSH profile.' };
  store.profiles[key] = next;
  writeStore(store);
  return { ok: true, profiles: next.map(publicProfile) };
}

export function getRemoteProfile(account, id) {
  // Raw profile, for connecting only. Every listing goes through publicProfile.
  const list = readStore().profiles[accountKey(account)];
  const rows = Array.isArray(list) ? list : [];
  if (id) return rows.find((p) => p.id === String(id)) || null;
  return rows[0] || null;
}

function sshBinary() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export function remoteStatus(account) {
  const profiles = listRemoteProfiles(account);
  const ssh = sshBinary();
  return {
    ok: true,
    available: Boolean(ssh),
    ssh: ssh || null,
    platform: process.platform,
    profiles,
    count: profiles.length,
    defaults: {
      // These are hints for the form, never a saved credential. Daytona's SSH
      // gateway is the one the user asked to try first.
      host: process.env.ANTICODEX_SSH_HOST || 'ssh.app.daytona.io',
      port: Number(process.env.ANTICODEX_SSH_PORT) || 22,
      username: process.env.ANTICODEX_SSH_USER || '',
      key_path: process.env.ANTICODEX_SSH_KEY || null
    },
    note: ssh
      ? 'Remote runs use the local OpenSSH client with BatchMode=yes: your ~/.ssh/config, ssh-agent and keys are tried, and a missing key is a sentence rather than a prompt.'
      : 'OpenSSH is not installed on this machine, so remote execution is unavailable. Install the OpenSSH client to use a remote sandbox.'
  };
}

/** Build the smallest possible argv for one remote operation. Not exported
 *  directly: callers pass a profile that has already been validated/saved. */
function sshArgs(profile, remoteCommand) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-p', String(profile.port)
  ];
  if (profile.auth === 'keys' && profile.key_path) args.push('-i', profile.key_path);
  args.push(`${profile.username}@${profile.host}`, remoteCommand);
  return args;
}

function runSsh(profile, remoteCommand, { timeoutMs = DEFAULT_TIMEOUT, input = null } = {}) {
  const bin = sshBinary();
  if (!bin) return Promise.resolve({ ok: false, error: 'OpenSSH is not installed on this machine.' });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, sshArgs(profile, remoteCommand), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // A remote program must not inherit a browser/agent secret through the
        // SSH connection's environment. OpenSSH sends almost none by default;
        // clearing these two is cheap and explicit.
        SSH_ASKPASS: '',
        SSH_ASKPASS_REQUIRE: 'never'
      }
    });
    let stdout = '', stderr = '', done = false, timedOut = false;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        exit_code: typeof extra.code === 'number' ? extra.code : (extra.error ? 255 : 0),
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        truncated: stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        ...(extra.error ? { ok: false, error: extra.error } : {})
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT) + 5000);
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUTPUT * 2) stdout += c.toString(); });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUTPUT * 2) stderr += c.toString(); });
    child.on('error', (e) => finish({ error: e.code === 'ENOENT' ? 'Cannot start the OpenSSH client.' : String(e.message || e) }));
    child.on('close', (code) => finish({ code: timedOut ? 124 : code }));
    if (input != null) {
      try { child.stdin.end(String(input)); } catch { /* closed early */ }
    } else {
      try { child.stdin.end(); } catch { /* closed early */ }
    }
  });
}

/** A connection test that also answers "what is over there?": kernel, Node,
 *  Python and the login shell's directory. No user-supplied command runs. */
export async function testRemoteProfile(account, input = {}) {
  // Test the draft, not a stale saved copy — but a hidden access string lives
  // only in the store, so an empty username is filled from the saved row.
  let candidate = null;
  if (input.id) {
    const saved = getRemoteProfile(account, input.id);
    if (saved) {
      const merged = {
        ...saved, ...input,
        username: String(input.username || '').trim() ? input.username : saved.username,
        host: String(input.host || '').trim() || saved.host,
        port: input.port || saved.port,
        label: String(input.label || '').trim() || saved.label,
        secret_username: input.secret_username ?? saved.secret_username
      };
      const v = validateProfile(merged);
      if (v.profile) candidate = { id: 'draft', ...v.profile };
      else return { ok: false, error: v.error };
    }
  }
  if (!candidate) {
    const v = validateProfile(input);
    if (v.error) return { ok: false, error: v.error };
    candidate = { id: 'unsaved', ...v.profile };
  }
  const probe = "printf 'anticodex-ok\\n'; uname -srm 2>/dev/null || true; printf 'node '; command -v node 2>/dev/null || echo 'missing'; printf 'python '; command -v python3 2>/dev/null || echo 'missing'; printf 'cwd '; pwd 2>/dev/null || true";
  const out = await runSsh(candidate, probe, { timeoutMs: 20_000 });
  if (out.error) return { ok: false, ...out, error: out.error };
  if (out.timed_out) return { ok: false, ...out, error: 'The SSH connection timed out. Check the host, port, key and network egress.' };
  if (out.exit_code === 255) {
    return { ok: false, ...out, auth: true, error: `SSH could not connect or authenticate: ${(out.stderr || '').trim().slice(-500) || 'exit 255'}` };
  }
  return {
    ok: out.exit_code === 0 && /anticodex-ok/.test(out.stdout),
    ...out,
    probe: out.stdout.split('\n').filter(Boolean),
    error: out.exit_code === 0 ? undefined : (out.stderr || '').trim().slice(-500) || `exit ${out.exit_code}`
  };
}

/** Upload then execute one snippet. The remote path and command are built from
 *  validated values; `code` travels over stdin, never inside the command. */
export async function runRemoteCode(account, { id, language = 'node', code, timeout_ms } = {}) {
  const profile = getRemoteProfile(account, id);
  if (!profile) return { ok: false, error: 'No saved SSH profile. Add one on the Sandbox page first.' };
  const lang = LANGS[language];
  if (!lang) return { ok: false, error: `Unknown language "${language}". Supported: ${Object.keys(LANGS).join(', ')}.` };
  const source = String(code ?? '');
  if (!source.trim()) return { ok: false, error: 'There is no code to run.' };
  if (source.length > MAX_CODE) return { ok: false, error: `This snippet is ${source.length} bytes; the limit is ${MAX_CODE}.` };
  const timeout = Math.min(Number(timeout_ms) > 0 ? Number(timeout_ms) : DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const seconds = Math.max(1, Math.ceil(timeout / 1000));
  const runId = crypto.randomBytes(8).toString('hex');
  const remote = `/tmp/anticodex-${runId}.${lang.ext}`;

  const upload = await runSsh(profile, `cat > ${remote}`, { input: source, timeoutMs: 20_000 });
  if (upload.error || upload.timed_out || upload.exit_code !== 0) {
    return {
      ok: false, stage: 'upload', ...upload,
      error: upload.error || (upload.timed_out ? 'Uploading the snippet timed out.' : `Upload failed (exit ${upload.exit_code}): ${(upload.stderr || '').trim().slice(-400)}`)
    };
  }

  const remoteCommand = [
    `timeout ${seconds}s ${lang.bin} ${lang.args.join(' ')} ${remote}`,
    `rc=$?`,
    `rm -f ${remote}`,
    `exit $rc`
  ].join('; ');
  const out = await runSsh(profile, remoteCommand, { timeoutMs: timeout + 10_000 });
  const result = {
    ...out,
    ok: !out.error && !out.timed_out && out.exit_code === 0,
    run_id: runId,
    remote: true,
    host: profile.host,
    username: profile.username,
    language: lang.id,
    language_label: lang.label,
    timeout_ms: timeout
  };
  if (out.error) result.error = out.error;
  else if (out.timed_out) result.error = `The remote run was killed after ${seconds}s.`;
  else if (out.exit_code === 124) result.error = `The remote run hit its ${seconds}s limit.`;
  else if (out.exit_code === 127) result.error = 'The remote shell could not start that runtime (or `timeout` is missing). Check node/python3 on the remote machine.';
  else if (out.exit_code === 255) result.error = `SSH failed: ${(out.stderr || '').trim().slice(-400)}`;
  return result;
}

export const REMOTE_LANGUAGES = Object.values(LANGS).map(({ bin, args, ...rest }) => rest);
