// ANTICODEX — workspace context, matching what Codex actually does.
//
// Two things live here, both taken from `openai/codex` (Apache-2.0, cloned and
// read on 2026-10-24 — see docs/REA-EVIDENCE.md §9):
//
//   1. AGENTS.md discovery. Codex loads `$CODEX_HOME/AGENTS.md` first, then one
//      doc per directory from the project root down to the working directory,
//      then nested docs as it touches subdirectories. The merged text is injected
//      as a *user* message wrapped exactly like this:
//
//          # AGENTS.md instructions for <project>
//
//          <INSTRUCTIONS>
//          …
//          </INSTRUCTIONS>
//
//      (`codex-rs/core/src/compact_tests.rs`, `tui/src/status/helpers.rs`)
//      Budget: `project_doc_max_bytes`, default 32 KiB.
//
//   2. Sandbox + approval. Codex names them precisely and this product uses the
//      same names so a config means the same thing on both sides:
//
//        sandbox:  read-only{network_access} · workspace-write{writable_roots,
//                  network_access, exclude_tmpdir_env_var, exclude_slash_tmp} ·
//                  external-sandbox{network_access} · danger-full-access
//        approval: untrusted (alias "untrusted") · on-request (alias
//                  "on-failure") · granular{sandbox_approval, rules,
//                  skill_approval, request_permissions, mcp_elicitations} · never
//
//      (`codex-rs/protocol/src/protocol.rs`)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const PROJECT_DOC_FILENAMES = ['AGENTS.md'];

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

/** Read a file without ever throwing; returns null when it is not a file. */
function readMaybe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { text: fs.readFileSync(file, 'utf8'), bytes: st.size, mtime: st.mtimeMs };
  } catch { return null; }
}

/**
 * Directories from the filesystem root down to `cwd`, so the *most specific*
 * doc comes last and therefore wins in the merged text.
 */
function ancestorChain(cwd) {
  const out = [];
  let cur = path.resolve(cwd);
  for (;;) {
    out.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * @param {{cwd:string, codexHome?:string, filenames?:string[], stopAt?:string, nestedPaths?:string[]}} opts
 * @returns {{docs:Array, composed:string, bytes:number, truncated:boolean, instructions:string}}
 */
export function discoverAgentDocs({ cwd, codexHome, filenames, stopAt, nestedPaths = [] } = {}) {
  const names = Array.isArray(filenames) && filenames.length ? filenames : PROJECT_DOC_FILENAMES;
  const home = codexHome || path.join(os.homedir(), '.codex');
  const root = path.resolve(cwd || process.cwd());
  const docs = [];
  const seen = new Set();

  const add = (dir, scope, name) => {
    const file = path.join(dir, name);
    const real = (() => { try { return fs.realpathSync(file); } catch { return file; } })();
    if (seen.has(real)) return;
    const doc = readMaybe(file);
    if (!doc) return;
    seen.add(real);
    docs.push({
      path: real,
      display: displayPath(real, root, home),
      scope,
      filename: name,
      bytes: doc.bytes,
      text: doc.text,
      mtime: doc.mtime
    });
  };

  // 1. global override
  for (const name of names) add(home, 'global', name);

  // 2. project: root … cwd. A caller may pin the root (a repo) to avoid sucking
  //    in every AGENTS.md between / and the project.
  const chain = ancestorChain(root);
  const floor = stopAt ? path.resolve(stopAt) : null;
  const scoped = floor && chain.includes(floor) ? chain.slice(chain.indexOf(floor)) : chain;
  for (const dir of scoped) {
    if (dir === home) continue;
    for (const name of names) add(dir, dir === root ? 'project' : 'project-parent', name);
  }

  // 3. nested docs the agent touched — resolved against the workspace root when
  //    one is pinned, because that is the tree the agent is working in.
  for (const rel of nestedPaths) {
    const dir = path.resolve(floor || root, rel);
    if (!dir.startsWith(floor || root)) continue; // never read outside the workspace
    for (const name of names) add(dir, 'nested', name);
  }

  // Merge under the byte budget, most-specific last.
  let used = 0;
  let truncated = false;
  const parts = [];
  for (const doc of docs) {
    const room = PROJECT_DOC_MAX_BYTES - used;
    if (room <= 0) { truncated = true; doc.truncated = true; continue; }
    const body = doc.text.length > room ? doc.text.slice(0, room) : doc.text;
    if (body.length < doc.text.length) { truncated = true; doc.truncated = true; }
    used += Buffer.byteLength(body);
    parts.push(body.trimEnd());
  }
  const merged = parts.filter(Boolean).join('\n\n');

  return {
    docs: docs.map(({ text, ...rest }) => rest),
    composed: merged,
    bytes: used,
    truncated,
    max_bytes: PROJECT_DOC_MAX_BYTES,
    instructions: merged ? composeInstructions(path.basename(root), merged) : ''
  };
}

/** The exact wrapper Codex uses so the same file means the same thing here. */
export function composeInstructions(project, text) {
  return `# AGENTS.md instructions for ${project}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`;
}

/** `~/.codex/AGENTS.md`, `../AGENTS.md`, `AGENTS.md`, `nested/AGENTS.md` */
export function displayPath(abs, cwd, home) {
  const h = home || path.join(os.homedir(), '.codex');
  if (abs === h || abs.startsWith(h + path.sep)) return '~/.codex' + abs.slice(h.length).replace(/\\/g, '/');
  const rel = path.relative(cwd || process.cwd(), abs);
  return (rel || path.basename(abs)).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

export const SANDBOX_MODES = {
  'read-only': {
    label: 'Read-only',
    detail: 'The agent can read the workspace and nothing else.',
    fields: ['network_access']
  },
  'workspace-write': {
    label: 'Workspace write',
    detail: 'Read everything; write inside the workspace (and TMPDIR) only.',
    fields: ['writable_roots', 'network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp']
  },
  'external-sandbox': {
    label: 'External sandbox',
    detail: 'You are already sandboxed elsewhere — full disk, network per the box.',
    fields: ['network_access']
  },
  'danger-full-access': {
    label: 'Danger: full access',
    detail: 'No restrictions at all. Only for throwaway machines.',
    fields: []
  }
};

const NETWORK = new Set(['restricted', 'enabled', 'disabled']);

/** Accept the Codex wire shape (`"workspace-write"`, `{"workspace-write":{…}}`,
 *  `{mode, …}`) and return one canonical object. Unknown input never silently
 *  becomes "full access". */
export function normalizeSandboxPolicy(input) {
  if (input == null) return { mode: 'workspace-write', writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };
  if (typeof input === 'string') {
    const mode = SANDBOX_MODES[input] ? input : 'workspace-write';
    return {
      mode,
      writable_roots: [],
      network_access: false,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
      ...(SANDBOX_MODES[input] ? {} : { coerced_from: input })
    };
  }
  if (typeof input === 'object') {
    // {"read-only": {"network_access": true}} or {mode:"read-only", ...}
    if (input.mode) {
      const base = normalizeSandboxPolicy(input.mode);
      return {
        ...base,
        writable_roots: Array.isArray(input.writable_roots) ? input.writable_roots.filter((p) => typeof p === 'string') : base.writable_roots,
        network_access: typeof input.network_access === 'boolean' ? input.network_access : base.network_access,
        exclude_tmpdir_env_var: Boolean(input.exclude_tmpdir_env_var),
        exclude_slash_tmp: Boolean(input.exclude_slash_tmp)
      };
    }
    const key = Object.keys(input).find((k) => SANDBOX_MODES[k]);
    if (key) {
      const opts = input[key] && typeof input[key] === 'object' ? input[key] : {};
      return {
        mode: key,
        writable_roots: Array.isArray(opts.writable_roots) ? opts.writable_roots.filter((p) => typeof p === 'string') : [],
        network_access: typeof opts.network_access === 'boolean' ? opts.network_access : NETWORK.has(opts.network_access) ? opts.network_access === 'enabled' : false,
        exclude_tmpdir_env_var: Boolean(opts.exclude_tmpdir_env_var),
        exclude_slash_tmp: Boolean(opts.exclude_slash_tmp)
      };
    }
  }
  return { mode: 'workspace-write', writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };
}

/** Serialise back to the Codex wire shape (round-trips through config.toml). */
export function serdeSandboxPolicy(policy) {
  const p = normalizeSandboxPolicy(policy);
  if (p.mode === 'danger-full-access') return 'danger-full-access';
  if (p.mode === 'read-only') return { 'read-only': { network_access: p.network_access } };
  if (p.mode === 'external-sandbox') return { 'external-sandbox': { network_access: p.network_access ? 'enabled' : 'restricted' } };
  const opts = { network_access: p.network_access };
  if (p.writable_roots.length) opts.writable_roots = p.writable_roots;
  if (p.exclude_tmpdir_env_var) opts.exclude_tmpdir_env_var = true;
  if (p.exclude_slash_tmp) opts.exclude_slash_tmp = true;
  return { 'workspace-write': opts };
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

export const APPROVAL_CATEGORIES = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];

export const APPROVAL_MODES = {
  untrusted: { label: 'Untrusted project', detail: 'Nothing runs without you approving it, except reads.' },
  'on-request': { label: 'On request', detail: 'The agent asks when a step needs more than the sandbox allows.' },
  granular: { label: 'Granular', detail: 'Choose which kinds of approval prompt may reach you.' },
  never: { label: 'Never ask', detail: 'Refuse anything the sandbox does not allow; never interrupt you.' }
};

export function normalizeApprovalPolicy(input) {
  if (typeof input === 'string') {
    if (input === 'on-failure') return { mode: 'on-request', aliased_from: 'on-failure' };
    if (input === 'granular') {
      return { mode: 'granular', granular: Object.fromEntries(APPROVAL_CATEGORIES.map((k) => [k, true])) };
    }
    if (APPROVAL_MODES[input]) return { mode: input };
    return { mode: 'on-request', coerced_from: input };
  }
  if (input && typeof input === 'object') {
    if (input.granular && typeof input.granular === 'object') {
      return {
        mode: 'granular',
        granular: Object.fromEntries(APPROVAL_CATEGORIES.map((k) => [k, input.granular[k] !== false]))
      };
    }
    if (input.mode) {
      const base = normalizeApprovalPolicy(input.mode);
      return base.mode === 'granular'
        ? { ...base, granular: Object.fromEntries(APPROVAL_CATEGORIES.map((k) => [k, input.granular?.[k] !== false])) }
        : base;
    }
  }
  return { mode: 'on-request' };
}

export function serdeApprovalPolicy(policy) {
  const p = normalizeApprovalPolicy(policy);
  if (p.mode === 'granular') return { granular: { ...p.granular } };
  return p.mode;
}

// ---------------------------------------------------------------------------
// The decision: what happens to one action
// ---------------------------------------------------------------------------

const SANDBOX_GRANTS = {
  'read-only': { read: true, write: false, exec: false, network: false },
  'workspace-write': { read: true, write: true, exec: true, network: false },
  'external-sandbox': { read: true, write: true, exec: true, network: false },
  'danger-full-access': { read: true, write: true, exec: true, network: true }
};

/** 'auto' — run it · 'prompt' — ask the user · 'deny' — refuse and tell the model */
export function decideApproval({ sandbox, approval, action = 'exec', category = 'sandbox_approval' } = {}) {
  const sp = normalizeSandboxPolicy(sandbox);
  const ap = normalizeApprovalPolicy(approval);
  const grants = { ...SANDBOX_GRANTS[sp.mode] };
  if (sp.network_access) grants.network = true;
  if (sp.mode === 'read-only' || sp.mode === 'external-sandbox' || sp.mode === 'workspace-write') {
    // network_access is the only knob these modes expose
    if (!sp.network_access && action === 'network' && sp.mode === 'workspace-write') grants.network = false;
  }
  const allowed = Boolean(grants[action]);

  if (ap.mode === 'never') return allowed ? 'auto' : 'deny';
  if (ap.mode === 'untrusted') return action === 'read' && allowed ? 'auto' : 'prompt';
  if (ap.mode === 'granular') {
    const on = ap.granular?.[category] !== false;
    if (allowed && category === 'sandbox_approval' && action === 'read') return 'auto';
    return on ? 'prompt' : 'deny';
  }
  // on-request: the sandbox decides where it can; the user decides where it cannot.
  return allowed ? 'auto' : 'prompt';
}

/** One-line explanation for the UI, in the same voice as the rest of the app. */
export function describePolicy({ sandbox, approval } = {}) {
  const sp = normalizeSandboxPolicy(sandbox);
  const ap = normalizeApprovalPolicy(approval);
  const mode = SANDBOX_MODES[sp.mode];
  const am = APPROVAL_MODES[ap.mode];
  const net = sp.mode === 'danger-full-access' ? 'network on' : (sp.network_access ? 'network on' : 'network off');
  return `${mode.label} (${net}) · ${am.label}`;
}
