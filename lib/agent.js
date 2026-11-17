// The agent: what OpenCode does, built on the machine this app actually has.
//
// OpenCode's shape, as implemented by sst/opencode, is the reference:
//
//   1. an agent has a *permission set* (allow / ask / deny per tool, with glob
//      patterns inside bash and file paths) rather than a boolean per tool;
//   2. a *stepped loop* — LLM → tool calls → results → LLM — with a hard step cap,
//      after which the model is forced to answer in text (no more tool calls);
//   3. tools are thin: read, write, edit, patch, bash, grep, glob, list, skill,
//      plus MCP tools; each returns a small, structured result;
//   4. file time tracking so an edit cannot clobber a file that changed since it
//      was read;
//   5. a `plan` agent (read-only) and a `build` agent (full) as the two primary
//      modes, and subagents that run in their own context;
//   6. permission decisions are remembered per session ("allow always") so the
//      same question is not asked twice.
//
// What is different here, deliberately:
//   * the target is a *machine*, not a process. Every tool runs either on this
//     host or inside the user's Daytona sandbox over SSH (`execAnywhere`), and the
//     transcript says which one on every result. That is the piece opencode does
//     not have, and this app's whole point.
//   * the loop is a generator that yields events, so the HTTP layer can stream it
//     as SSE and the desktop app can render the same steps; nothing here writes to
//     a response object.
//   * permission prompts are *first class*: an `ask` rule pauses the loop and hands
//     the caller a question with an id, and resuming with "allow always" records the
//     pattern for that session. A denial is fed back to the model as a tool error,
//     which is what opencode does too — the model must learn, not crash.
//
// Nothing in this module spawns a shell directly. It calls lib/daytona.js or
// lib/sandbox.js, which already own the timeouts, output caps and the local
// scrub. That keeps one place where "run a command" is decided.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { sshExec, daytonaStatus } from './daytona.js';
import { wsRootFor, wsList, wsRead, wsWrite, wsExec, resolveInside } from './workspacefs.js';

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const ALLOW = 'allow', ASK = 'ask', DENY = 'deny';

/** Built-in agents, mirroring opencode's Build / Plan split. `steps` is the hard
 *  cap on tool rounds; when it is reached the model is asked to answer in text. */
export const AGENTS = Object.freeze({
  build: {
    id: 'build',
    label: 'Build',
    // The default: read freely, edit with a prompt the first time, and treat shell
    // commands as something to check unless they are obviously safe.
    permission: {
      read: ALLOW,
      glob: ALLOW,
      grep: ALLOW,
      list: ALLOW,
      skill: ALLOW,
      web: ALLOW,
      write: ASK,
      edit: ASK,
      patch: ASK,
      bash: { '*': ASK, 'ls*': ALLOW, 'cat *': ALLOW, 'pwd': ALLOW, 'echo *': ALLOW, 'git status*': ALLOW, 'git diff*': ALLOW, 'git log*': ALLOW, 'node -v': ALLOW, 'npm test*': ASK },
      external_directory: ASK
    },
    steps: 12,
    description: 'Full development: reads, writes, edits and runs commands. Asks before it changes something.'
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    // Read-only by construction, so a 30-step exploration can never touch a file.
    permission: {
      read: ALLOW, glob: ALLOW, grep: ALLOW, list: ALLOW, skill: ALLOW, web: ALLOW,
      write: DENY, edit: DENY, patch: DENY, bash: DENY, external_directory: DENY
    },
    steps: 10,
    description: 'Read-only analysis: reads, searches and explores, and cannot change anything.'
  },
  explore: {
    id: 'explore',
    label: 'Explore',
    permission: { read: ALLOW, glob: ALLOW, grep: ALLOW, list: ALLOW, skill: ALLOW, web: DENY, write: DENY, edit: DENY, patch: DENY, bash: DENY, external_directory: DENY },
    steps: 8,
    description: 'Fast codebase exploration in its own context. Read-only, no network, no shell.'
  }
});

export function agentList() {
  return Object.values(AGENTS).map((a) => ({ id: a.id, label: a.label, steps: a.steps, description: a.description, permission: a.permission }));
}

export function resolveAgent(id) {
  return AGENTS[String(id || 'build')] || AGENTS.build;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Glob → RegExp for command patterns. `*` spans any characters, `**` is the same
 *  here (a shell command is one line, so there are no path segments to respect). */
function globRe(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Decide one tool call. Returns `{ decision, pattern, reason }`.
 *
 * The rules follow opencode's precedence: the LAST matching pattern wins, so a
 * config can start with `*: allow` and then carve out the dangerous ones. A rule
 * written as a bare string applies to everything for that tool. An `ask` that was
 * already answered "always" for this exact pattern is remembered in `session`.
 */
export function decide(agent, toolName, subject, session = {}) {
  const rules = agent.permission || {};
  const rule = rules[toolName];
  const remembered = session.grants || {};
  const rememberedFor = (pattern) => remembered[`${toolName}:${pattern}`];

  if (rule === undefined) {
    // A tool the agent did not mention is allowed for `build` and denied for the
    // read-only agents — an unlisted tool must never widen a restricted agent.
    return { decision: agent.id === 'build' ? ALLOW : DENY, pattern: '*', reason: 'not listed in this agent’s permissions' };
  }
  if (typeof rule === 'string') {
    // A deny the user gave for this tool outranks an allow in the agent config:
    // "never do that again" has to mean it, or revoking a command is impossible.
    if (rememberedFor('*') === DENY) return { decision: DENY, pattern: '*', reason: 'you denied this earlier in the session' };
    if (rule === ASK) {
      const g = rememberedFor('*');
      if (g === ALLOW) return { decision: ALLOW, pattern: '*', reason: 'you allowed this earlier in the session' };
      if (g === DENY) return { decision: DENY, pattern: '*', reason: 'you denied this earlier in the session' };
      return { decision: ASK, pattern: '*', reason: `agent “${agent.label}” asks before every ${toolName}` };
    }
    return { decision: rule, pattern: '*', reason: `agent “${agent.label}” sets ${toolName}: ${rule}` };
  }
  // Pattern map: last match wins.
  const text = String(subject ?? '');
  let winner = null;
  for (const [pattern, action] of Object.entries(rule)) {
    const re = pattern === '*' ? null : globRe(pattern);
    if (!re || re.test(text)) winner = { pattern, action };
  }
  if (!winner) {
    // No pattern matched: treat as ask, never as a silent deny, so the user sees
    // what the model wanted instead of a mysteriously missing capability.
    winner = { pattern: '*', action: rule['*'] ?? ASK };
  }
  // Same precedence inside a pattern map: a remembered deny for the winning pattern
  // (or for `*`) wins over an `allow` the agent config granted.
  if (rememberedFor(winner.pattern) === DENY) return { decision: DENY, pattern: winner.pattern, reason: 'you denied this earlier in the session' };
  if (rememberedFor('*') === DENY && winner.action === ALLOW) return { decision: DENY, pattern: winner.pattern, reason: 'you denied this tool earlier in the session' };
  if (winner.action === ASK) {
    const g = rememberedFor(winner.pattern);
    if (g === ALLOW) return { decision: ALLOW, pattern: winner.pattern, reason: 'allowed earlier in this session' };
    if (g === DENY) return { decision: DENY, pattern: winner.pattern, reason: 'denied earlier in this session' };
    return { decision: ASK, pattern: winner.pattern, reason: `“${winner.pattern}” needs your approval` };
  }
  return { decision: winner.action, pattern: winner.pattern, reason: `matches “${winner.pattern}”` };
}

// ---------------------------------------------------------------------------
// Tool definitions (the schemas a model is given)
// ---------------------------------------------------------------------------

export function toolDefs(agent, { includePublicApi = true, publicApiTool = null, mcpTools = [] } = {}) {
  const defs = [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a text file from the workspace, with line numbers. Use offset/limit for large files.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path relative to the workspace root, or absolute inside it' },
            offset: { type: 'number', description: 'First line (1-based)' },
            limit: { type: 'number', description: 'How many lines (default 400, max 2000)' }
          },
          required: ['file_path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write',
        description: 'Create a file, or replace its whole contents. Creates parent directories.',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit',
        description: 'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Returns a diff.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'patch',
        description: 'Apply a unified diff to one or more files in the workspace.',
        parameters: {
          type: 'object',
          properties: { patch_text: { type: 'string', description: 'A unified diff (---/+++/@@ hunks)' } },
          required: ['patch_text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command. Runs on the target machine for this session (see the system prompt) and returns stdout, stderr and the exit code.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'number', description: 'Default 20000, max 120000' },
            description: { type: 'string', description: 'One short line on why, shown to the user with the approval prompt' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents with a regular expression. Returns file:line:text.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Directory to search, default the workspace root' },
            glob: { type: 'string', description: 'File pattern, e.g. "*.js"' },
            ignore_case: { type: 'boolean' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'Find files by name pattern, e.g. "**/*.tsx".',
        parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list',
        description: 'List a directory: names, sizes, and whether each entry is a directory.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }
    },
    {
      type: 'function',
      function: {
        name: 'skill',
        description: 'Load the full text of a skill from the installed skills atlas, by slug.',
        parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'todo_write',
        description: 'Record or update the task list for this session. Use it to keep a multi-step job honest.',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
                required: ['text', 'status']
              }
            }
          },
          required: ['todos']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'question',
        description: 'Ask the user a clarifying question and stop. Use only when you cannot proceed without the answer.',
        parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] }
      }
    }
  ];
  if (includePublicApi && publicApiTool) defs.push(publicApiTool);
  for (const t of mcpTools.slice(0, 20)) defs.push(t);
  return defs;
}

/** Which tools this agent may even see. A denied tool is not offered at all — the
 *  same rule opencode applies, and the reason a plan agent cannot be talked into a
 *  write. `ask` tools are offered: the approval prompt is the point. */
export function allowedTools(agent, defs) {
  return defs.filter((d) => {
    const name = d.function?.name || d.name;
    const r = agent.permission?.[name];
    if (r === DENY) return false;
    if (r === undefined) return agent.id === 'build';
    if (typeof r === 'object') return Object.values(r).some((v) => v !== DENY);
    return r !== DENY;
  });
}

// ---------------------------------------------------------------------------
// Target: this machine or the Daytona sandbox
// ---------------------------------------------------------------------------

/** Where this session's tools run. `daytona` is the default when a workspace is
 *  configured — the whole point of connecting one — and the answer is explicit
 *  rather than inferred at each call, so the transcript can label every step. */
export function resolveTarget(target) {
  const st = daytonaStatus();
  const wanted = String(target || 'auto');
  if (wanted === 'local') return { mode: 'local', label: `this machine (${os.hostname()})`, configured: true };
  if (wanted === 'daytona') {
    if (!st.configured) {
      return {
        mode: 'local', label: `this machine (${os.hostname()})`, configured: false,
        note: 'Daytona was requested but no workspace is connected, so commands run here. Connect one on the Sandbox page.'
      };
    }
    return { mode: 'daytona', label: `Daytona · ${st.ssh.user || st.ssh.target}`, configured: true, status: st };
  }
  // auto
  return st.configured
    ? { mode: 'daytona', label: `Daytona · ${st.ssh.user || st.ssh.target}`, configured: true, status: st }
    : { mode: 'local', label: `this machine (${os.hostname()})`, configured: false, note: 'No Daytona workspace is connected, so commands run here.' };
}

// A remote workspace directory for the agent. On Daytona the box is persistent, so
// the directory is stable across sessions; locally it is the account's workspace.
const REMOTE_DIR = '.anticodex/workspace';

async function remoteExec(command, { timeoutMs, cwd } = {}) {
  return sshExec(command, { timeoutMs, cwd });
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** Track the mtime of every file the agent read, so `edit` can refuse to write
 *  over a file that changed underneath it (opencode's FileTime, same idea). */
function fileTimeKey(target, relPath) { return `${target.mode}:${relPath}`; }

async function localRoot(account) {
  const root = wsRootFor(account);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Execute one tool call against the session's target. Never throws: a tool failure
 * is a result the model must see and reason about.
 */
export async function executeTool(call, ctx) {
  const name = call.name;
  const a = call.args || {};
  const { target, account, session, run } = ctx;
  const started = Date.now();
  const done = (result, extra = {}) => ({
    tool: name, ok: result?.ok !== false, duration_ms: Date.now() - started,
    target: target.label, ...result, ...extra
  });

  try {
    if (name === 'question') {
      return done({ ok: true, question: String(a.question || ''), options: Array.isArray(a.options) ? a.options.slice(0, 6) : [], ask_user: true });
    }
    if (name === 'todo_write') {
      session.todos = (a.todos || []).slice(0, 50).map((t) => ({ text: String(t.text || '').slice(0, 300), status: t.status || 'pending' }));
      return done({ ok: true, todos: session.todos });
    }
    if (name === 'skill') {
      const { skillBody } = await import('./skillkit.js');
      const one = skillBody(String(a.slug || ''));
      if (!one) return done({ ok: false, error: `No skill "${a.slug}" in the atlas.` });
      return done({ ok: true, slug: one.slug, chars: one.body.length, body: one.body.slice(0, 24000) });
    }
    if (name === 'public_api') {
      const { runPublicApi } = await import('./publicapis.js');
      const out = await runPublicApi(a);
      return done(out);
    }

    // --- commands ---------------------------------------------------------
    if (name === 'bash') {
      const command = String(a.command || '');
      if (!command.trim()) return done({ ok: false, error: 'command is empty' });
      const timeoutMs = Math.max(1000, Math.min(Number(a.timeout_ms) || 20000, 120000));
      if (target.mode === 'daytona') {
        const out = await remoteExec(command, { timeoutMs });
        return done({
          ok: out.ok, stdout: out.stdout, stderr: out.stderr, exit_code: out.exit_code,
          timed_out: out.timed_out, hint: out.hint, ran_on: target.label
        });
      }
      const root = await localRoot(account);
      const out = await wsExec(root, { command, timeout_ms: timeoutMs });
      return done({ ...out, ran_on: target.label });
    }

    // --- files ------------------------------------------------------------
    // Reads are served from the target too: reading a file on the Daytona box is
    // the difference between an agent that can inspect the machine it runs on and
    // one that inspects the browser's server.
    if (name === 'read') {
      const rel = String(a.file_path || '');
      const offset = Math.max(1, Number(a.offset) || 1);
      const limit = Math.max(1, Math.min(Number(a.limit) || 400, 2000));
      if (target.mode === 'daytona') {
        const dir = await remoteCwd(session, target);
        const abs = path.isAbsolute(rel) ? rel : path.posix.join(dir, rel);
        const out = await remoteExec(`sed -n '${offset},${offset + limit - 1}p' ${q(abs)} | cat -n`, {});
        if (!out.ok) return done({ ok: false, error: out.stderr || out.error || 'read failed', path: abs });
        return done({ ok: true, path: abs, offset, lines: out.stdout.split('\n').length, content: out.stdout, ran_on: target.label });
      }
      const root = await localRoot(account);
      const r = wsRead(root, rel);
      if (!r.ok) return done(r);
      const all = String(r.content || '').split('\n');
      const slice = all.slice(offset - 1, offset - 1 + limit);
      session.readAt = { ...(session.readAt || {}), [fileTimeKey(target, rel)]: await mtimeOf(target, root, rel) };
      return done({
        ok: true, path: r.path || rel, offset, total_lines: all.length,
        content: slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n'),
        ran_on: target.label
      });
    }

    if (name === 'write') {
      const rel = String(a.file_path || '');
      const content = String(a.content ?? '');
      if (Buffer.byteLength(content) > 400_000) return done({ ok: false, error: 'That content is over 400 KB.' });
      if (target.mode === 'daytona') {
        const dir = await remoteCwd(session, target);
        const abs = path.isAbsolute(rel) ? rel : path.posix.join(dir, rel);
        // base64 through stdin avoids every quoting trap a heredoc has with
        // backticks, $ and NUL in source code.
        const b64 = Buffer.from(content, 'utf8').toString('base64');
        const out = await remoteExec(`mkdir -p $(dirname ${q(abs)}) && printf %s ${q(b64)} | base64 -d > ${q(abs)} && wc -c < ${q(abs)}`, {});
        if (!out.ok) return done({ ok: false, error: out.stderr || out.error, path: abs });
        return done({ ok: true, path: abs, bytes: Number(String(out.stdout).trim()) || content.length, created: true, ran_on: target.label });
      }
      const root = await localRoot(account);
      const r = wsWrite(root, rel, content);
      return done({ ...r, created: true, ran_on: target.label });
    }

    if (name === 'edit') {
      const rel = String(a.file_path || '');
      const oldStr = String(a.old_string ?? '');
      const newStr = String(a.new_string ?? '');
      if (!oldStr) return done({ ok: false, error: 'old_string is empty — use write to create a file.' });
      const root = target.mode === 'local' ? await localRoot(account) : null;
      let before;
      if (target.mode === 'daytona') {
        const dir = await remoteCwd(session, target);
        const abs = path.isAbsolute(rel) ? rel : path.posix.join(dir, rel);
        const got = await remoteExec(`cat ${q(abs)}`, {});
        if (!got.ok) return done({ ok: false, error: got.stderr || `no such file: ${abs}` });
        before = got.stdout;
      } else {
        const got = wsRead(root, rel);
        if (!got.ok) return done(got);
        before = String(got.content);
      }
      // File-time guard, local only where mtimes are ours to trust.
      const key = fileTimeKey(target, rel);
      if (session.readAt?.[key] !== undefined) {
        const now = await mtimeOf(target, root, rel);
        if (now && session.readAt[key] && now > session.readAt[key]) {
          return done({ ok: false, error: `${rel} changed on disk since you read it. Read it again before editing.` });
        }
      }
      const count = before.split(oldStr).length - 1;
      if (count === 0) return done({ ok: false, error: `old_string not found in ${rel}. Read the file and copy the exact text.` });
      if (count > 1 && a.replace_all !== true) {
        return done({ ok: false, error: `old_string appears ${count} times in ${rel}; pass replace_all or include more context.` });
      }
      const after = a.replace_all === true ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      if (target.mode === 'daytona') {
        const dir = await remoteCwd(session, target);
        const abs = path.isAbsolute(rel) ? rel : path.posix.join(dir, rel);
        const b64 = Buffer.from(after, 'utf8').toString('base64');
        const out = await remoteExec(`printf %s ${q(b64)} | base64 -d > ${q(abs)}`, {});
        if (!out.ok) return done({ ok: false, error: out.stderr || out.error });
        return done({ ok: true, path: abs, replacements: a.replace_all === true ? count : 1, diff: unifiedDiff(before, after, abs), ran_on: target.label });
      }
      const w = wsWrite(root, rel, after);
      if (!w.ok) return done(w);
      return done({ ok: true, path: w.path, replacements: a.replace_all === true ? count : 1, diff: unifiedDiff(before, after, rel), ran_on: target.label });
    }

    if (name === 'patch') {
      const text = String(a.patch_text || '');
      const parsed = parseUnifiedDiff(text);
      if (!parsed.files.length) return done({ ok: false, error: 'No file sections found — a patch needs "--- a/path" and "+++ b/path".' });
      const root = target.mode === 'local' ? await localRoot(account) : null;
      const applied = [];
      for (const f of parsed.files.slice(0, 20)) {
        let before = '';
        if (target.mode === 'daytona') {
          const dir = await remoteCwd(session, target);
          const abs = path.posix.isAbsolute(f.path) ? f.path : path.posix.join(dir, f.path);
          const got = await remoteExec(`cat ${q(abs)} 2>/dev/null || true`, {});
          before = got.stdout || '';
          const res = applyHunks(before, f.hunks);
          if (!res.ok) { applied.push({ path: abs, ok: false, error: res.error }); continue; }
          const b64 = Buffer.from(res.content, 'utf8').toString('base64');
          const w = await remoteExec(`mkdir -p $(dirname ${q(abs)}) && printf %s ${q(b64)} | base64 -d > ${q(abs)}`, {});
          applied.push({ path: abs, ok: w.ok, error: w.ok ? undefined : (w.stderr || w.error), diff: unifiedDiff(before, res.content, abs) });
        } else {
          const got = wsRead(root, f.path);
          before = got.ok ? String(got.content) : '';
          if (!got.ok && f.hunks.some((h) => h.oldCount > 0)) { applied.push({ path: f.path, ok: false, error: got.error }); continue; }
          const res = applyHunks(before, f.hunks);
          if (!res.ok) { applied.push({ path: f.path, ok: false, error: res.error }); continue; }
          const w = wsWrite(root, f.path, res.content);
          applied.push({ path: f.path, ok: w.ok, error: w.ok ? undefined : w.error, diff: unifiedDiff(before, res.content, f.path) });
        }
      }
      const anyFailed = applied.some((x) => !x.ok);
      return done({ ok: !anyFailed, files: applied, applied: applied.filter((x) => x.ok).length, failed: applied.filter((x) => !x.ok).length, ran_on: target.label });
    }

    if (name === 'list') {
      const rel = String(a.path || '');
      if (target.mode === 'daytona') {
        const dir = await remoteCwd(session, target);
        const abs = path.posix.isAbsolute(rel) ? rel : path.posix.join(dir, rel || '.');
        const out = await remoteExec(`ls -la ${q(abs)} 2>&1 | head -200`, {});
        return done({ ok: out.ok, path: abs, listing: out.stdout, ran_on: target.label });
      }
      const root = await localRoot(account);
      const r = wsList(root, rel);
      return done({ ...r, ran_on: target.label });
    }

    if (name === 'grep' || name === 'glob') {
      const dir = String(a.path || '');
      const pattern = String(a.pattern || '');
      if (!pattern) return done({ ok: false, error: 'pattern is empty' });
      if (target.mode === 'daytona') {
        const cwd = await remoteCwd(session, target);
        const abs = path.posix.isAbsolute(dir) ? dir : path.posix.join(cwd, dir || '.');
        const cmd = name === 'grep'
          ? `grep -rn ${a.ignore_case ? '-i ' : ''}--exclude-dir=node_modules --exclude-dir=.git -E ${q(pattern)} ${q(abs)} 2>/dev/null | head -200`
          : `find ${q(abs)} -type f ${a.glob ? '-name ' + q(a.glob) : ''} 2>/dev/null | head -200`;
        const out = await remoteExec(cmd, {});
        return done({ ok: true, output: out.stdout, matches: out.stdout ? out.stdout.trim().split('\n').length : 0, ran_on: target.label });
      }
      const root = await localRoot(account);
      const out = name === 'grep'
        ? grepLocal(root, dir, pattern, { ignore_case: a.ignore_case, glob: a.glob })
        : globLocal(root, dir, a.glob || pattern);
      return done({ ...out, ran_on: target.label });
    }

    if (name === 'web_fetch') {
      const { callApi } = await import('./publicapis.js');
      void callApi;
      const url = String(a.url || '');
      const { blockedTarget } = await import('./publicapis.js');
      const blocked = blockedTarget(url);
      if (blocked) return done({ ok: false, error: `Refusing to fetch ${url}: ${blocked}` });
      const res = await fetch(url, { headers: { 'user-agent': 'ANTICODEX/1', accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      return done({ ok: res.ok, status: res.status, bytes: text.length, content: text.slice(0, 20000) });
    }

    return done({ ok: false, error: `unknown tool "${name}"` });
  } catch (e) {
    return { tool: name, ok: false, error: String(e?.message || e), duration_ms: Date.now() - started, target: target.label };
  }
}

async function mtimeOf(target, root, rel) {
  if (target.mode === 'daytona') {
    const dir = await remoteCwd({}, target);
    const abs = path.posix.isAbsolute(rel) ? rel : path.posix.join(dir, rel);
    const out = await sshExec(`stat -c %Y ${q(abs)} 2>/dev/null || echo 0`, {});
    return Number(String(out.stdout).trim()) || 0;
  }
  try { return Math.floor(fs.statSync(path.join(root, rel)).mtimeMs / 1000); } catch { return 0; }
}

/** The working directory for a session: stable per session, created on first use. */
async function remoteCwd(session, target) {
  if (session.remoteCwd) return session.remoteCwd;
  const dir = `${REMOTE_DIR}/${String(session.id || 'default').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}`;
  const out = await sshExec(`mkdir -p ~/${dir} && cd ~/${dir} && pwd`, {});
  session.remoteCwd = out.ok ? String(out.stdout).trim() : `~/${dir}`;
  return session.remoteCwd;
}

function grepLocal(root, dir, pattern, { ignore_case, glob } = {}) {
  let re;
  try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch (e) { return { ok: false, error: `bad regex: ${e.message}` }; }
  // The default is the workspace root, which resolveInside refuses as an empty
  // string — so `.` is the path that means "here".
  const base = resolveInside(root, dir || '.');
  if (base.error) return { ok: false, error: base.error };
  const hits = [];
  const walk = (abs, depth) => {
    if (hits.length >= 200 || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= 200) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (glob && !globRe(glob).test(e.name)) continue;
      let text;
      try {
        const st = fs.statSync(p);
        if (st.size > 2_000_000) continue;
        text = fs.readFileSync(p, 'utf8');
      } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(root, p)}:${i + 1}:${lines[i].slice(0, 300)}`);
          if (hits.length >= 200) return;
        }
      }
    }
  };
  walk(base.abs, 0);
  return { ok: true, matches: hits.length, output: hits.join('\n') };
}

function globLocal(root, dir, pattern) {
  // The default is the workspace root, which resolveInside refuses as an empty
  // string — so `.` is the path that means "here".
  const base = resolveInside(root, dir || '.');
  if (base.error) return { ok: false, error: base.error };
  const re = globRe(String(pattern).replace(/\*\*\//g, ''));
  const out = [];
  const walk = (abs, depth) => {
    if (out.length >= 400 || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (re.test(e.name)) out.push(path.relative(root, p));
    }
  };
  walk(base.abs, 0);
  return { ok: true, matches: out.length, files: out };
}

// ---------------------------------------------------------------------------
// Unified diff: apply and produce
// ---------------------------------------------------------------------------

export function parseUnifiedDiff(text) {
  const lines = String(text || '').split('\n');
  const files = [];
  let cur = null;
  let hunk = null;
  for (const line of lines) {
    const fm = line.match(/^---\s+(?:a\/)?(\S+)/);
    const tm = line.match(/^\+\+\+\s+(?:b\/)?(\S+)/);
    const hm = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (fm) {
      // A new file section; the ++ line follows and usually carries the real path.
      cur = { path: fm[1], hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (tm && cur) { cur.path = tm[1]; continue; }
    if (hm) {
      if (!cur) { cur = { path: null, hunks: [] }; files.push(cur); }
      hunk = { oldStart: Number(hm[1]), oldCount: hm[2] === undefined ? 1 : Number(hm[2]), newStart: Number(hm[3]), newCount: hm[4] === undefined ? 1 : Number(hm[4]), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue;                    // "\ No newline at end of file"
    if (line === '' ) { hunk.lines.push({ op: ' ', text: '' }); continue; }
    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') hunk.lines.push({ op, text: line.slice(1) });
    else if (op === 'd') { /* "diff --git" */ }
  }
  return { files: files.filter((f) => f.path && f.hunks.length) };
}

export function applyHunks(before, hunks) {
  const src = String(before ?? '').split('\n');
  const out = [];
  let cursor = 0;                                            // index into src
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1);
    if (start < cursor) return { ok: false, error: `hunk at line ${h.oldStart} overlaps the previous one` };
    while (cursor < start && cursor < src.length) out.push(src[cursor++]);
    for (const l of h.lines) {
      if (l.op === ' ') {
        if (src[cursor] !== l.text) {
          return { ok: false, error: `context mismatch at source line ${cursor + 1}: expected ${JSON.stringify(l.text.slice(0, 60))}, found ${JSON.stringify(String(src[cursor] ?? '').slice(0, 60))}` };
        }
        out.push(src[cursor++]);
      } else if (l.op === '-') {
        if (src[cursor] !== l.text) {
          return { ok: false, error: `remove mismatch at source line ${cursor + 1}: expected ${JSON.stringify(l.text.slice(0, 60))}, found ${JSON.stringify(String(src[cursor] ?? '').slice(0, 60))}` };
        }
        cursor++;
      } else if (l.op === '+') {
        out.push(l.text);
      }
    }
  }
  while (cursor < src.length) out.push(src[cursor++]);
  return { ok: true, content: out.join('\n') };
}

/** A minimal unified diff, enough for the transcript and for review. */
export function unifiedDiff(before, after, label = 'file') {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  // Trim the common head and tail so the diff is the change, not the file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1; let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) { tailA--; tailB--; }
  if (head > tailA && head > tailB) return '';
  const ctxStart = Math.max(0, head - 3);
  const ctxEndA = Math.min(a.length - 1, tailA + 3);
  const ctxEndB = Math.min(b.length - 1, tailB + 3);
  const lines = [`--- a/${label}`, `+++ b/${label}`,
    `@@ -${ctxStart + 1},${ctxEndA - ctxStart + 1} +${ctxStart + 1},${ctxEndB - ctxStart + 1} @@`];
  for (let i = ctxStart; i < head; i++) lines.push(` ${a[i]}`);
  for (let i = head; i <= tailA; i++) lines.push(`-${a[i]}`);
  for (let i = head; i <= tailB; i++) lines.push(`+${b[i]}`);
  for (let i = tailA + 1; i <= ctxEndA; i++) lines.push(` ${a[i]}`);
  const clipped = lines.slice(0, 200);
  if (lines.length > 200) clipped.push(`… ${lines.length - 200} more diff lines`);
  return clipped.join('\n');
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const MAX_STEP_MESSAGE = 'You have reached the step limit for this turn. Answer now, in text, with what you found and what is left to do. Do not call any more tools.';

export function systemPrompt({ agent, target, cwd, skills = '', extra = '' }) {
  const lines = [
    `You are ANTICODEX, a coding agent. You are operating on ${target.label}.`,
    '',
    'Rules of the loop:',
    '- Read before you write. Never guess a file\'s contents when you can read it.',
    '- Edit with the `edit` tool (exact strings) or `patch` (unified diff). Use `write` only for new files or a whole-file rewrite.',
    '- Every command and file operation reports the machine it ran on. Do not claim a result you did not see.',
    '- If a tool fails, read the error and fix the cause. A denial is an answer: say what you would have done and why.',
    '- Keep a task list with `todo_write` for anything with more than two steps.',
    `- You have at most ${agent.steps} tool rounds this turn. Spend them.`,
    ''
  ];
  if (agent.id !== 'build') lines.push(`You are in ${agent.label} mode: you cannot modify files or run commands. Analyse, and propose changes as diffs in your answer.`, '');
  if (cwd) lines.push(`Working directory on that machine: ${cwd}`, '');
  if (skills) lines.push(skills, '');
  if (extra) lines.push(extra);
  return lines.join('\n');
}

/**
 * Run the agent loop.
 *
 * An async generator of events so the HTTP layer can stream them:
 *   { type: 'session' }  { type: 'assistant_delta' }  { type: 'tool_start' }
 *   { type: 'tool_end' } { type: 'permission' }       { type: 'todo' }
 *   { type: 'step' }     { type: 'done' }             { type: 'error' }
 *
 * `callModel({ messages, tools })` is injected so this module has no opinion about
 * providers — the bridge passes its existing chat() with the session's keys.
 * `askPermission` is injected the same way: it resolves to 'allow' | 'allow_always'
 * | 'deny', and the loop waits for it, which is what makes 'ask' real.
 */
export async function* runAgent({
  messages: initial = [],
  agent: agentId = 'build',
  target: targetId = 'auto',
  account,
  session = {},
  callModel,
  askPermission,
  onStep,
  skillsBlock = '',
  mcpTools = [],
  publicApiEnabled = true,
  maxSteps
}) {
  const agent = resolveAgent(agentId);
  const target = resolveTarget(targetId);
  const sess = { id: session.id || `ag_${Date.now().toString(36)}`, grants: session.grants || {}, todos: session.todos || [], ...session };
  const steps = Math.max(1, Math.min(Number(maxSteps) || agent.steps, 40));

  yield { type: 'session', agent: agent.id, agentLabel: agent.label, target: target.label, targetMode: target.mode, note: target.note, steps, sessionId: sess.id };
  if (skillsBlock) yield { type: 'skills', chars: skillsBlock.length };

  let { publicApiTools } = await import('./publicapis.js');
  const publicTool = publicApiEnabled ? (publicApiTools()[0] || null) : null;
  const defs = allowedTools(agent, toolDefs(agent, { includePublicApi: publicApiEnabled, publicApiTool: publicTool, mcpTools }));

  const system = systemPrompt({ agent, target, cwd: target.mode === 'daytona' ? REMOTE_DIR : (account ? `~/.anticodex/workspace/${account}` : ''), skills: skillsBlock });
  let messages = [{ role: 'system', content: system }, ...initial];

  const transcript = [];
  let finalText = '';
  let round = 0;
  let forcedText = false;

  while (round < steps) {
    round++;
    let out;
    try {
      out = await callModel({ messages, tools: forcedText ? [] : defs, agent, step: round });
    } catch (e) {
      yield { type: 'error', error: String(e?.message || e), step: round };
      return;
    }
    const text = String(out?.content || '');
    if (text) {
      finalText += (finalText ? '\n\n' : '') + text;
      yield { type: 'assistant_delta', text, step: round };
    }
    const calls = Array.isArray(out?.tool_calls) ? out.tool_calls : [];
    if (!calls.length) {
      yield { type: 'done', text: finalText, rounds: round, sessionId: sess.id, todos: sess.todos, grants: sess.grants, target: target.label };
      return;
    }

    messages = [...messages, { role: 'assistant', content: text, tool_calls: calls }];
    for (const call of calls.slice(0, 8)) {
      const name = call.function?.name || call.name || '';
      let args = {};
      try { args = JSON.parse(call.function?.arguments ?? call.arguments ?? '{}'); } catch { args = {}; }
      const subject = name === 'bash' ? String(args.command || '') : String(args.file_path || args.path || args.pattern || args.slug || args.id || '');
      const verdict = decide(agent, name, subject, sess);

      yield { type: 'tool_start', step: round, tool: name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 400) : v])), decision: verdict.decision, reason: verdict.reason, target: target.label };

      if (verdict.decision === DENY) {
        const result = { tool: name, ok: false, denied: true, error: `Denied by the “${agent.label}” agent (${verdict.reason}).`, target: target.label };
        transcript.push({ round, ...result });
        yield { type: 'tool_end', step: round, ...result };
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result).slice(0, 8000) });
        continue;
      }
      if (verdict.decision === ASK) {
        const request = {
          type: 'permission', step: round, tool: name, subject: subject.slice(0, 400),
          pattern: verdict.pattern, reason: verdict.reason, args: { ...args, content: undefined },
          id: `perm_${round}_${transcript.length}`
        };
        yield request;
        let answer = 'deny';
        if (typeof askPermission === 'function') {
          try { answer = String(await askPermission(request) || 'deny'); } catch { answer = 'deny'; }
        }
        // No asker means no consent: an `ask` rule cannot silently become an allow.
        if (answer === 'allow_always') sess.grants[`${name}:${verdict.pattern}`] = 'allow';
        if (answer === 'deny_always') sess.grants[`${name}:${verdict.pattern}`] = 'deny';
        if (answer === 'deny' || answer === 'deny_always') {
          const result = { tool: name, ok: false, denied: true, error: 'The user denied this call.', target: target.label };
          transcript.push({ round, ...result });
          yield { type: 'tool_end', step: round, ...result };
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result).slice(0, 8000) });
          continue;
        }
      }

      const result = await executeTool({ name, args }, { target, account, session: sess, run: { round } });
      transcript.push({ round, tool: result.tool, ok: result.ok, duration_ms: result.duration_ms, target: result.target, diff: result.diff, error: result.error });
      yield { type: 'tool_end', step: round, ...result };
      if (result.todos) yield { type: 'todo', todos: result.todos };
      if (result.ask_user) {
        // A clarifying question ends the turn: the model cannot answer itself.
        yield { type: 'done', text: finalText || result.question, rounds: round, sessionId: sess.id, todos: sess.todos, grants: sess.grants, target: target.label, question: { text: result.question, options: result.options } };
        return;
      }
      // Results are capped so one huge file cannot eat the context window.
      messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(slim(result)).slice(0, 24000) });
      if (typeof onStep === 'function') { try { onStep({ round, name, ok: result.ok }); } catch { /* observer */ } }
    }

    if (round === steps) {
      // Force a text answer rather than stopping mid-thought (opencode's MAX_STEPS).
      forcedText = true;
      messages = [...messages, { role: 'user', content: MAX_STEP_MESSAGE }];
      yield { type: 'step_limit', steps };
    }
  }

  // One last text-only call so the turn always ends with an answer.
  try {
    const last = await callModel({ messages, tools: [], agent, step: steps + 1 });
    if (last?.content) {
      finalText += (finalText ? '\n\n' : '') + last.content;
      yield { type: 'assistant_delta', text: last.content, step: steps + 1 };
    }
  } catch (e) {
    yield { type: 'error', error: String(e?.message || e) };
  }
  yield { type: 'done', text: finalText, rounds: steps, sessionId: sess.id, todos: sess.todos, grants: sess.grants, target: target.label, step_limited: true };
}

function slim(result) {
  const out = { ...result };
  for (const k of ['content', 'stdout', 'stderr', 'output', 'listing', 'body']) {
    if (typeof out[k] === 'string' && out[k].length > 12000) out[k] = `${out[k].slice(0, 12000)}\n… truncated`;
  }
  delete out.entry;
  return out;
}

export const AGENT_LIMITS = Object.freeze({ max_steps: 40, default_steps: 12, max_tool_output: 24000, remote_dir: REMOTE_DIR });
