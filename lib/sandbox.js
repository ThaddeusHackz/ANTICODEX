// A sandbox for generated code — local, disposable, and honest about its limits.
//
// The shape is deliberately boring: every run gets a new directory under the data
// folder, one process with a wall-clock limit, a scrubbed environment, and its
// output captured and capped. That is enough to answer "does the code the model
// just wrote actually run", which is the only question a code agent has to get
// right, and it is small enough to read in one sitting.
//
// What it is *not*: a security boundary against a determined attacker. Without a
// container or a separate user account, a process can still reach this machine's
// network and its own temporary files. So the bridge refuses to run it for remote
// callers (see handleSandbox) — the sandbox belongs to the person sitting at the
// machine, which is exactly the desktop app's situation.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_PATH } from './keys.js';

const ROOT = path.join(path.resolve(DATA_PATH), 'sandbox');
const MAX_CODE = 200_000;
const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT = 8000;
const MAX_TIMEOUT = 15000;
const KEEP_RUNS = 25;

export const LANGUAGES = Object.freeze({
  node: { id: 'node', label: 'JavaScript (Node)', ext: 'mjs', bin: 'node', args: ['--max-old-space-size=256'], hint: 'top-level await works' },
  python: { id: 'python', label: 'Python 3', ext: 'py', bin: 'python3', args: ['-I', '-B'], hint: 'isolated mode: no PYTHON* env, no site-packages surprises' },
  bash: { id: 'bash', label: 'Shell', ext: 'sh', bin: 'bash', args: ['--noprofile', '--norc'], hint: 'runs in the run directory with a scrubbed environment' }
});

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/** Which of the supported runtimes exist on this machine. */
export function sandboxStatus() {
  const found = {};
  for (const [id, lang] of Object.entries(LANGUAGES)) {
    found[id] = { ...lang, available: which(lang.bin) };
  }
  return {
    available: true,
    root: ROOT,
    languages: Object.values(found).map(({ bin, args, ...rest }) => rest),
    limits: { max_code_bytes: MAX_CODE, max_output_bytes: MAX_OUTPUT, timeout_ms: DEFAULT_TIMEOUT, max_timeout_ms: MAX_TIMEOUT },
    runs: listRuns().length
  };
}

function which(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** A run id is also a directory name, so it must not be able to mean anything else. */
export function isRunId(id) {
  return /^[a-z0-9]{8,32}$/.test(String(id || ''));
}

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || base.includes('\0')) return null;
  if (!/^[\w.\- ]{1,64}$/.test(base)) return null;
  return base;
}

export function listRuns(limit = KEEP_RUNS) {
  try {
    return fs.readdirSync(ensureRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isRunId(d.name))
      .map((d) => {
        const dir = path.join(ROOT, d.name);
        const files = safeListFiles(dir);
        const stat = fs.statSync(dir);
        return { id: d.name, at: stat.mtimeMs, files };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function safeListFiles(dir, limit = 50) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .slice(0, limit)
      .map((e) => {
        const p = path.join(dir, e.name);
        let bytes = 0;
        try { bytes = fs.statSync(p).size; } catch { /* vanished */ }
        return { name: e.name, bytes };
      });
  } catch { return []; }
}

function prune() {
  const runs = listRuns(500);
  for (const stale of runs.slice(KEEP_RUNS)) {
    try { fs.rmSync(path.join(ROOT, stale.id), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** The environment a run sees: a PATH, a private HOME, and nothing else. */
function runEnv(home) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LANG: process.env.LANG || 'C.UTF-8',
    NO_COLOR: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: '--no-warnings'
  };
  return env;
}

/**
 * Run one snippet.
 *
 * `timeout_ms` is capped rather than trusted, output is truncated rather than
 * buffered without limit, and the child is killed with SIGKILL because a program
 * that ignores SIGTERM is exactly what a timeout is for.
 */
export async function runSandbox({ language = 'node', code, timeout_ms, files = [], stdin = '' } = {}) {
  const lang = LANGUAGES[language];
  if (!lang) return { ok: false, error: `Unknown language "${language}". Supported: ${Object.keys(LANGUAGES).join(', ')}.` };
  const source = String(code ?? '');
  if (!source.trim()) return { ok: false, error: 'There is no code to run.' };
  if (source.length > MAX_CODE) return { ok: false, error: `This snippet is ${source.length} bytes; the limit is ${MAX_CODE}.` };
  if (!which(lang.bin)) return { ok: false, error: `${lang.label} is not installed on this machine (no "${lang.bin}" on PATH).` };

  const timeout = Math.min(Number(timeout_ms) > 0 ? Number(timeout_ms) : DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(ensureRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const main = `main.${lang.ext}`;
  fs.writeFileSync(path.join(dir, main), source);
  for (const f of Array.isArray(files) ? files.slice(0, 20) : []) {
    const name = safeName(f?.name);
    if (!name || name === main) continue;
    const body = String(f?.content ?? '');
    if (body.length > MAX_CODE) continue;
    const target = path.join(dir, name);
    // Belt and braces: the resolved path has to stay inside this run's directory.
    if (path.resolve(target) !== path.join(dir, name)) continue;
    fs.writeFileSync(target, body);
  }
  if (stdin) {
    try { fs.writeFileSync(path.join(dir, 'stdin.txt'), String(stdin).slice(0, 64_000)); } catch { /* optional */ }
  }

  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = execFile(
      lang.bin,
      [...lang.args, main],
      { cwd: dir, env: runEnv(dir), timeout, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        const exit = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
        resolve({
          exit_code: exit,
          signal: error?.signal || null,
          timed_out: Boolean(error && (error.killed || error.signal === 'SIGKILL' || /ETIMEDOUT/.test(String(error.code || '')))),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          spawn_error: error && !error.code && !error.signal ? String(error.message || error) : null
        });
      }
    );
    // Nothing to write and nothing to read: closing stdin is what stops a tool
    // that waits on it from hanging until the timeout.
    try { child.stdin?.end(); } catch { /* already closed */ }
  });

  const ms = Date.now() - started;
  const stdout = result.stdout.slice(0, MAX_OUTPUT);
  const stderr = result.stderr.slice(0, MAX_OUTPUT);
  prune();
  return {
    ok: !result.timed_out && !result.spawn_error && result.exit_code === 0,
    run_id: id,
    language: lang.id,
    language_label: lang.label,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    duration_ms: ms,
    stdout,
    stderr,
    truncated: result.stdout.length > MAX_OUTPUT || result.stderr.length > MAX_OUTPUT,
    files: safeListFiles(dir),
    ...(result.spawn_error ? { error: result.spawn_error } : {})
  };
}

/** Read a file a run produced (the UI shows what the code wrote, not just its log). */
export function readSandboxFile(runId, name) {
  if (!isRunId(runId)) return { ok: false, error: 'Unknown run.' };
  const base = safeName(name);
  if (!base) return { ok: false, error: 'That file name is not allowed.' };
  const dir = path.join(ROOT, runId);
  const file = path.join(dir, base);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, error: 'That path leaves the run.' };
  try {
    const buf = fs.readFileSync(file);
    return { ok: true, name: base, bytes: buf.length, content: buf.slice(0, MAX_OUTPUT).toString('utf8'), truncated: buf.length > MAX_OUTPUT };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Throw the runs away (the UI's "clear"). */
export function clearSandbox(runId = null) {
  try {
    if (runId && isRunId(runId)) { fs.rmSync(path.join(ROOT, runId), { recursive: true, force: true }); return { ok: true, cleared: 1 }; }
    const runs = listRuns(500);
    for (const r of runs) { try { fs.rmSync(path.join(ROOT, r.id), { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: true, cleared: runs.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
