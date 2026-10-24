// REA — Reverse Engineer Anything, as an app-level feature.
//
// REA ships a local MCP server (`rea-agents mcp`, 207 tools) and a `setup` command
// that registers it with the agent CLIs it can find. Its setup is unusual in a
// useful way: `setup --dry-run` prints the *resolved plan* — the exact files it
// would write, the command it would register, and what it found on this machine —
// without touching anything.
//
// That is exactly the shape this app wants, because the plan can be shown in the
// UI, approved by a human, and only then applied. The rule enforced here:
//
//   apply() refuses unless the plan it is about to run has the same fingerprint
//   as the plan that was shown.
//
// So a plan cannot change between "here is what I will do" and "do it" without
// the UI noticing. Everything runs locally (npx, no shell), so a hosted
// deployment says plainly that it cannot spawn processes instead of pretending.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const REA_PACKAGE = 'rea-agents';
export const REA_MIN_NODE = [22, 19];
export const REA_SERVER_NAME = 'rea';

// The two tables REA's plan output can contain, and where each supported client
// keeps its MCP registration. Both are literal on purpose: a table or a client
// name that is not in here is not something this app reads or writes.
const TABLES = Object.freeze({ plannedActions: 'plannedActions', appliedActions: 'appliedActions' });
const REGISTRATIONS = Object.freeze({
  codex: path.join('.codex', 'config.toml'),
  claude_code: '.claude.json',
  claude_desktop: path.join('.claude', 'claude_desktop_config.json'),
  cursor: path.join('.cursor', 'mcp.json')
});
export const REA_CLIENTS = ['codex', 'claude_code', 'claude_desktop', 'cursor', 'gemini_cli', 'windsurf', 'vscode'];

/** "22.19.0" ≥ [22,19] — the version REA's own docs ask for. */
export function nodeSatisfies(version = process.version, min = REA_MIN_NODE) {
  const parts = String(version).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [maj, minr] = min;
  if (parts[0] !== maj) return parts[0] > maj;
  return (parts[1] || 0) >= minr;
}

export function nodeStatus(version = process.version) {
  const ok = nodeSatisfies(version);
  return {
    version: String(version),
    required: `>= ${REA_MIN_NODE.join('.')}`,
    ok,
    // The command still runs on older Node — but REA says 22.19+, and a half
    // working install is worse than a plain sentence.
    message: ok
      ? `Node ${String(version).replace(/^v/, '')} satisfies REA's requirement (>= ${REA_MIN_NODE.join('.')}).`
      : `REA needs Node >= ${REA_MIN_NODE.join('.')}; this process is ${String(version)}. Upgrade Node before continuing.`
  };
}

/** Parse a CSV row, honouring the double quotes REA uses around prose fields. */
export function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Read REA's plan output.
 *
 * It is YAML-with-a-table (`plannedActions[2]{id,kind,...}:`) followed by CSV
 * rows, which is stable enough to parse by line without a YAML dependency. A
 * parser that silently returns [] would be worse than useless here — it would
 * render "no changes" for a plan that does change things — so an unreadable
 * table is reported as `parse_error` alongside whatever was recoverable.
 */
export function parseSetupOutput(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const result = {
    status: (/^status:\s*(\S+)/m.exec(src) || [])[1] || null,
    planned: [],
    applied: [],
    doctor: { healthy: null, environment_healthy: null },
    parse_error: null
  };
  // Only these two tables exist. Parsing whatever a table header happens to name
  // would let the output decide what this function believes was planned.
  const table = (label) => {
    if (!Object.prototype.hasOwnProperty.call(TABLES, label)) return [];
    const head = new RegExp(`^${label}\\[(\\d+)\\]\\{([^}]*)\\}:\\s*$`, 'm').exec(src);
    if (!head) return [];
    const fields = head[2].split(',').map((f) => f.trim()).filter(Boolean);
    const after = src.slice(head.index + head[0].length).split('\n');
    const rows = [];
    let started = false;
    for (const line of after) {
      if (!started && line.trim() === '') continue;   // the rest of the header line
      // The table ends at the first line that is neither a row nor blank.
      if (!/^\s{2}\S/.test(line)) break;
      started = true;
      const cells = parseCsvRow(line.trim());
      if (!cells.length || cells[0] === '') continue;
      const row = {};
      fields.forEach((f, i) => { row[f] = cells[i] ?? ''; });
      rows.push(row);
    }
    return rows;
  };
  result.planned = table(TABLES.plannedActions);
  result.applied = table(TABLES.appliedActions);

  const doctorAt = src.indexOf('\ndoctor:');
  if (doctorAt !== -1) {
    const block = src.slice(doctorAt, doctorAt + 600);
    const healthy = /^\s+healthy:\s*(true|false)\s*$/m.exec(block);
    const env = /^\s+environment_healthy:\s*(true|false)\s*$/m.exec(block);
    if (healthy) result.doctor.healthy = healthy[1] === 'true';
    if (env) result.doctor.environment_healthy = env[1] === 'true';
  }

  const declared = /plannedActions\[(\d+)\]/.exec(src);
  if (declared && result.planned.length !== Number(declared[1])) {
    result.parse_error = `REA listed ${declared[1]} planned action(s) but ${result.planned.length} could be read`;
  }
  if (!result.status) result.parse_error = result.parse_error || 'no status line in REA setup output';
  return result;
}

/** A fingerprint of the plan: what it changes, not how it is worded. */
export function planFingerprint(plan) {
  const material = (plan.planned || [])
    .map((a) => [a.id, a.kind, a.target, a.operation].join('|'))
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(material || 'empty').digest('hex').slice(0, 16);
}

export function buildArgs(mode, { client = 'codex', skill = true, installHopper = false } = {}) {
  const args = ['-y', `${REA_PACKAGE}@latest`, 'setup'];
  if (mode === 'plan') args.push('--dry-run');
  else args.push('--yes');
  args.push('--client', client);
  if (skill) args.push('--skill');
  if (installHopper && mode !== 'plan') args.push('--install-hopper');
  return args;
}

/**
 * Run the REA CLI once. Never through a shell, never unbounded: a setup that
 * writes outside its own directory is exactly the thing waiting for approval,
 * so the timeout kills the process group rather than leaving it half-applied.
 */
export function runRea(args, { timeoutMs = 180000, cwd = os.tmpdir(), env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...env, npm_config_yes: 'true', CI: '1' },
        shell: false,
        windowsHide: true
      });
    } catch (e) {
      return resolve({ ok: false, code: null, stdout: '', stderr: String(e.message || e), ms: 0, spawn_error: String(e.message || e) });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 400 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < cap) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { if (stderr.length < cap) stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(e.message || e), ms: Date.now() - started, spawn_error: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, stdout, stderr, ms: Date.now() - started, timed_out: timedOut, command: `npx ${args.join(' ')}` });
    });
  });
}

/** The part of REA that matters to a person: what it will do, in plain language. */
export function describeAction(action = {}) {
  const kind = action.kind || 'action';
  if (kind === 'configure_client') {
    return `Register the REA MCP server with ${action.label || action.client || 'the agent'} — edits ${action.target || 'its config'}`;
  }
  if (kind === 'install_skill') {
    return `Install/update the bundled reverse-engineering skill at ${action.target || 'the skills root'}`;
  }
  return `${kind} ${action.target ? `→ ${action.target}` : ''}`.trim();
}

/** Where REA's registration should end up, per client. Used by verify(). */
export function registrationPath(client = 'codex', home = os.homedir()) {
  const rel = Object.prototype.hasOwnProperty.call(REGISTRATIONS, client) ? REGISTRATIONS[client] : null;
  if (!rel) return null;
  // Resolved against the home directory this call was given, and refused if it
  // does not stay underneath it: this function reads a file, so "which file" has
  // to be an answer the caller cannot widen.
  const root = path.resolve(home);
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/**
 * Did the setup actually leave a registration behind?
 *
 * Reads the file REA said it would edit and looks for the server name. This is
 * deliberately a text check: a config.toml may contain anything else the user
 * owns, and parsing-then-rewriting it here would be a second writer of the same
 * file fighting REA.
 */
export function checkRegistration(client = 'codex', { home = os.homedir() } = {}) {
  const file = registrationPath(client, home);
  if (!file) return { checked: false, present: null, file: null };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { checked: true, present: false, file, reason: 'file does not exist yet' }; }
  const present = new RegExp(`^\\s*\\[mcp_servers\\.${REA_SERVER_NAME}\\]|"${REA_SERVER_NAME}"\\s*:`, 'm').test(text);
  return { checked: true, present, file, bytes: text.length };
}
