// ANTICODEX — a real workspace directory the Codex page operates on.
//
// The virtual tree (seeded localStorage files) stayed a demo; the Codex desktop
// app edits the repo on disk, so this module gives the web/desktop workspace a
// *real* directory with the two properties that make that safe to expose:
//
//   1. Containment — every path resolves inside the workspace root. Absolute
//      paths, NUL bytes, `..` that climbs out, and symlink parents that escape
//      are all refused before any fs call. The check runs on the resolved path,
//      not the joined string, because `a/../../b` joins clean but resolves out.
//   2. Policy — approval/sandbox enforcement lives in the bridge (decideApproval
//      from lib/workspace.js, the same engine the settings show), not here;
//      this module is the mechanism the policy gates.
//
// Where the root lives: DATA_PATH/workspaces/<account>. DATA_PATH follows the
// existing storage rules (desktop userData, server data dir, read-only in
// serverless) — on a read-only disk the bridge reports the honest
// "needs the desktop app or a local server" answer, exactly like the sandbox.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_PATH } from './keys.js';

export const WS_ROOT = path.join(path.resolve(DATA_PATH), 'workspaces');

const MAX_READ = 2 * 1024 * 1024;      // 2 MB shown in the editor
const MAX_WRITE = 2 * 1024 * 1024;     // 2 MB written
const MAX_LIST = 2000;                 // entries per directory listing
const MAX_COMMAND = 4000;              // shell line length
const EXEC_TIMEOUT = 20000;            // wall clock, not a suggestion
const MAX_OUTPUT = 64000;              // same cap the sandbox uses

/** An account key is a directory name, so it must not be able to mean anything else. */
export function safeAccountKey(k) {
  const s = String(k || 'default');
  return /^[\w.-]{1,40}$/.test(s) && s !== '.' && s !== '..' ? s : 'default';
}

export function wsRootFor(account) {
  return path.join(WS_ROOT, safeAccountKey(account));
}

/**
 * Resolve `rel` inside `root`, refusing anything that leaves it.
 * Returns {abs} or {error}. The nearest existing ancestor is realpath-checked
 * so `link -> /elsewhere/file.txt` cannot smuggle a write out of the box.
 */
export function resolveInside(root, rel) {
  const raw = String(rel ?? '');
  if (!raw) return { error: 'A path is required.' };
  if (raw.includes('\0')) return { error: 'Invalid path.' };
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return { error: 'Paths must be relative to the workspace.' };
  const norm = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, norm);
  const rootRes = path.resolve(root);
  if (abs !== rootRes && !abs.startsWith(rootRes + path.sep)) return { error: 'This path is outside the workspace.' };
  // realpath walk: resolve the deepest existing ancestor.
  let probe = abs;
  const missing = [];
  while (!fs.existsSync(probe)) {
    missing.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const real = fs.realpathSync(probe);
    const realRoot = (() => { try { return fs.realpathSync(rootRes); } catch { return rootRes; } })();
    const rebuilt = missing.length ? path.join(real, ...missing) : real;
    if (rebuilt !== realRoot && !rebuilt.startsWith(realRoot + path.sep)) {
      return { error: 'This path leaves the workspace through a link.' };
    }
  } catch { /* nothing exists yet — the join check above already passed */ }
  return { abs, rel: norm };
}

function relOf(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

export function wsList(root, rel = '') {
  const r = rel === '' || rel === '.' ? { abs: root } : resolveInside(root, rel);
  if (r.error) return { ok: false, error: r.error };
  if (!fs.existsSync(r.abs)) return { ok: true, path: rel, dirs: [], files: [] };
  let st;
  try { st = fs.statSync(r.abs); } catch (e) { return { ok: false, error: `Cannot read folder: ${e.code || e.message}` }; }
  if (!st.isDirectory()) return { ok: false, error: 'Not a directory.' };
  const dirs = [], files = [];
  for (const e of fs.readdirSync(r.abs, { withFileTypes: true }).slice(0, MAX_LIST)) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(r.abs, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: relOf(root, p) });
    else if (e.isFile()) {
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch { /* vanished mid-listing */ }
      files.push({ name: e.name, path: relOf(root, p), bytes });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, path: rel, dirs, files };
}

function looksBinary(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  return head.includes(0);
}

export function wsRead(root, rel) {
  const r = resolveInside(root, rel);
  if (r.error) return { ok: false, error: r.error };
  let st;
  try { st = fs.statSync(r.abs); } catch { return { ok: false, error: `No such file: ${rel}` }; }
  if (st.isDirectory()) return { ok: false, error: 'That is a directory.' };
  if (st.size > 16 * 1024 * 1024) return { ok: false, error: `File is ${(st.size / 1048576).toFixed(1)} MB — the editor will not open it. (limit 16 MB)` };
  const buf = fs.readFileSync(r.abs);
  if (looksBinary(buf)) return { ok: false, binary: true, error: 'This file is binary, not text.' };
  const truncated = buf.length > MAX_READ;
  return { ok: true, path: relOf(root, r.abs), bytes: st.size, truncated, content: buf.subarray(0, MAX_READ).toString('utf8') };
}

export function wsWrite(root, rel, content) {
  const r = resolveInside(root, rel);
  if (r.error) return { ok: false, error: r.error };
  const body = String(content ?? '');
  if (Buffer.byteLength(body) > MAX_WRITE) return { ok: false, error: `Content is ${Buffer.byteLength(body)} bytes; the limit is ${MAX_WRITE}.` };
  fs.mkdirSync(path.dirname(r.abs), { recursive: true });
  fs.writeFileSync(r.abs, body);
  return { ok: true, path: relOf(root, r.abs), bytes: Buffer.byteLength(body) };
}

export function wsMkdir(root, rel) {
  const r = resolveInside(root, rel);
  if (r.error) return { ok: false, error: r.error };
  fs.mkdirSync(r.abs, { recursive: true });
  return { ok: true, path: relOf(root, r.abs) };
}

export function wsRemove(root, rel) {
  const r = resolveInside(root, rel);
  if (r.error) return { ok: false, error: r.error };
  const rootRes = path.resolve(root);
  if (path.resolve(r.abs) === rootRes) return { ok: false, error: 'Refusing to remove the workspace itself.' };
  if (!fs.existsSync(r.abs)) return { ok: false, error: `No such file or folder: ${rel}` };
  fs.rmSync(r.abs, { recursive: true, force: true });
  return { ok: true, removed: relOf(root, r.abs) };
}

/** The environment a workspace command sees: PATH, the workspace as HOME so
 *  caches land inside the box, and nothing else — same scrub as the sandbox. */
export function wsEnv(root) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    LANG: process.env.LANG || 'C.UTF-8',
    NO_COLOR: '1',
    NODE_OPTIONS: '--no-warnings'
  };
}

/**
 * Run one shell line with the workspace as cwd. This is the feature the terminal
 * was pretending to have: real processes, real output, capped and killed on
 * schedule. It is not a security boundary — the bridge only lets the machine's
 * owner reach it (loopback) and only after the approval policy has cleared it.
 */
export function wsExec(root, { command, timeout_ms = EXEC_TIMEOUT } = {}) {
  const line = String(command ?? '').trim();
  if (!line) return { ok: false, error: 'There is no command to run.' };
  if (line.length > MAX_COMMAND) return { ok: false, error: `Command is ${line.length} characters; the limit is ${MAX_COMMAND}.` };
  const started = Date.now();
  const shell = process.platform === 'win32' ? 'bash' : 'bash';
  return new Promise((resolve) => {
    const child = execFile(shell, ['--noprofile', '--norc', '-c', line], {
      cwd: root,
      env: wsEnv(root),
      timeout: Math.min(Number(timeout_ms) > 0 ? Number(timeout_ms) : EXEC_TIMEOUT, EXEC_TIMEOUT),
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT * 2,
      windowsHide: true
    }, (err, stdout, stderr) => {
      const duration_ms = Date.now() - started;
      const timed_out = Boolean(err && (err.killed || /SIGTERM|ETIMEDOUT/.test(String(err.code))));
      const so = String(stdout || '').slice(0, MAX_OUTPUT);
      const se = String(stderr || '').slice(0, MAX_OUTPUT);
      if (err && !timed_out && typeof err.code === 'number' && err.code !== 0) {
        resolve({ ok: true, exit_code: err.code, stdout: so, stderr: se, duration_ms, truncated: stdout?.length > MAX_OUTPUT || stderr?.length > MAX_OUTPUT });
        return;
      }
      if (err && (timed_out || (typeof err.code === 'number' && err.code !== 0))) {
        resolve({ ok: true, exit_code: timed_out ? 124 : err.code, stdout: so, stderr: se || `killed (${err.code || 'signal'})`, timed_out, duration_ms });
        return;
      }
      resolve({ ok: true, exit_code: 0, stdout: so, stderr: se, duration_ms, truncated: String(stdout || '').length > MAX_OUTPUT || String(stderr || '').length > MAX_OUTPUT });
    });
    child.on('error', (e) => {
      resolve({ ok: false, error: e.code === 'ENOENT' ? `Cannot start ${shell} on this machine.` : String(e.message || e), duration_ms: Date.now() - started });
    });
  });
}

export function wsStatus(account) {
  const root = wsRootFor(account);
  let exists = false, files = 0;
  try {
    exists = fs.existsSync(root);
    if (exists) files = fs.readdirSync(root).filter((n) => !n.startsWith('.')).length;
  } catch { /* read-only disk: reported below by the bridge's gate anyway */ }
  return { root, exists, files };
}

// --- line diff (shared by the bridge's proposal preview and the UI) ----------

/** Exact-diff with a bounded LCS over the changed middle: equal prefix and
 *  suffix are trimmed, then the middle is aligned so a line that merely moved
 *  is not counted as removed+added. Middle is capped — past 250k line pairs the
 *  honest answer is "replace the middle", not a hung browser tab. */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const mid = [];
  if (A.length * B.length <= 250000) {
    const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { mid.push({ t: ' ', line: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { mid.push({ t: '-', line: A[i] }); i++; }
      else { mid.push({ t: '+', line: B[j] }); j++; }
    }
    while (i < A.length) { mid.push({ t: '-', line: A[i] }); i++; }
    while (j < B.length) { mid.push({ t: '+', line: B[j] }); j++; }
  } else {
    for (const line of A) mid.push({ t: '-', line });
    for (const line of B) mid.push({ t: '+', line });
  }
  const hunks = [];
  for (let k = 0; k < start; k++) hunks.push({ t: ' ', line: a[k] });
  hunks.push(...mid);
  for (let k = endA; k < a.length; k++) hunks.push({ t: ' ', line: a[k] });
  return { hunks, added: hunks.filter((h) => h.t === '+').length, removed: hunks.filter((h) => h.t === '-').length };
}

/** Preview payload for a proposed write: what exists now vs what would be written. */
export function wsPreview(root, rel, content) {
  const current = wsRead(root, rel);
  if (current.binary) return { ok: false, error: current.error };
  const d = diffLines(current.ok ? current.content : '', String(content ?? ''));
  return {
    ok: true,
    path: rel,
    exists: current.ok,
    added: d.added,
    removed: d.removed,
    hunks: d.hunks.slice(0, 400),
    truncated_hunks: d.hunks.length > 400
  };
}