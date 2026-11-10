// Codex parity map — what the real `openai/codex` workspace does, and where this
// app does the same job (or does not).
//
// `lib/codex-repos.js` is the evidence: 121 crates read from the upstream tree,
// with source sizes and module lists. This file is the interpretation — one row
// per surface a user actually touches, naming the upstream crates that implement
// it and the ANTICODEX file that reimplements it.
//
// The `implemented` flag is a filesystem check, not a promise. A row that points
// at a file which does not exist reports `missing` on the page, so this table
// cannot drift into marketing: delete the implementation and the page says so.
//
// Regenerate the evidence with `node scripts/rea-codex-sweep.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_CRATES, CODEX_DOCS, CODEX_SOURCE } from './codex-repos.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @typedef {Object} CodexSurface
 * @property {string} id
 * @property {string} label
 * @property {'chat'|'agent'|'workspace'|'safety'|'extend'|'platform'} group
 * @property {string[]} crates        upstream crates/modules that implement it
 * @property {string[]} files         files here that implement it (first = primary)
 * @property {string} [route]         where to see it in this app
 * @property {string} [action]        bridge action that drives it
 * @property {string} parity          what "the same thing" means, concretely
 * @property {string} [gap]           what is still different, said plainly
 */

/** @type {CodexSurface[]} */
export const CODEX_SURFACES = [
  {
    id: 'chat', label: 'Chat / composer', group: 'chat',
    crates: ['core', 'tui', 'codex-client', 'model-provider-info', 'models-manager', 'responses-api-proxy'],
    files: ['web/src/pages/Chat.jsx', 'lib/providers.js', 'api/bridge.js'],
    route: '/', action: 'chat_stream',
    parity: 'Streamed answers from 26 provider endpoints, phase + heartbeat events, reasoning streamed separately, Stop that aborts the real request.',
    gap: 'Codex streams one fixed provider; here the wire format is per-provider, so a few providers answer in one piece instead of streaming.'
  },
  {
    id: 'threads', label: 'Threads, history & search', group: 'chat',
    crates: ['thread-store', 'thread-manager-sample', 'message-history', 'state', 'codex-home'],
    files: ['lib/store.js', 'web/src/lib/state.jsx', 'web/src/App.jsx'],
    route: '/', action: 'threads',
    parity: 'Per-account threads written locally first and merged with the server copy by id; a new chat appears in the rail immediately, offline included.',
    gap: 'Upstream keeps SQLite with WAL; this keeps JSON (Supabase or data/db.json). Full-text search over old threads is lexical, not FTS5.'
  },
  {
    id: 'app-server', label: 'App-server control plane', group: 'platform',
    crates: ['app-server', 'app-server-protocol', 'app-server-transport', 'app-server-client', 'app-server-daemon', 'uds', 'stdio-to-uds'],
    files: ['api/bridge.js', 'lib/mcp-stdio.js'],
    route: '/mcp', action: 'mcp',
    parity: 'One action-routed endpoint (`/api/bridge`) that both the website and the desktop app call, with the same handlers.',
    gap: 'Codex runs a local JSON-RPC app-server with a generated TS schema; this is an HTTP action router. No UDS transport.'
  },
  {
    id: 'workspace', label: 'Workspace / file tree / editor', group: 'workspace',
    crates: ['file-system', 'file-watcher', 'file-search', 'worktree', 'git-utils'],
    files: ['lib/workspacefs.js', 'web/src/pages/Codex.jsx', 'web/src/pages/Workspace.jsx'],
    route: '/codex', action: 'workspace_fs',
    parity: 'A real directory per account: contained paths (no `..`, no symlink escape), list/read/write/mkdir/rm, preview, and command execution with the policy gate.',
    gap: 'No filesystem watcher yet (the tree refreshes on demand), and no git worktree management.'
  },
  {
    id: 'sandbox', label: 'Sandboxed execution', group: 'safety',
    crates: ['sandboxing', 'linux-sandbox', 'bwrap', 'windows-sandbox-rs', 'windows-sandbox-service', 'exec', 'exec-server', 'process-hardening', 'network-proxy'],
    files: ['lib/sandbox.js', 'lib/daytona.js', 'web/src/pages/Sandbox.jsx'],
    route: '/sandbox', action: 'sandbox / daytona',
    parity: 'Language runs in a fresh directory with a scrubbed environment, a wall-clock kill, capped output and the files it wrote — locally, or on a Daytona box over SSH/REST.',
    gap: 'No bubblewrap/seatbelt kernel sandbox on this host: the local runner is a process boundary, not a kernel one. Daytona is the real isolation story.'
  },
  {
    id: 'approvals', label: 'Approval modes', group: 'safety',
    crates: ['execpolicy', 'guardian-context', 'hooks', 'codex-mcp'],
    files: ['lib/workspace.js', 'lib/policy.js'],
    route: '/codex', action: 'workspace / policy',
    parity: 'suggest / auto-edit / auto-run, enforced server-side before any filesystem or process call, with a pending-approval queue the UI resolves.',
    gap: 'Codex also ships a policy language (Starlark-ish exec rules). Here the rule table is a fixed allow/deny list plus per-run approval.'
  },
  {
    id: 'patches', label: 'Patch proposals / apply-patch', group: 'agent',
    crates: ['apply-patch', 'core::apply_patch', 'rollout'],
    files: ['lib/workspace.js', 'web/src/pages/Codex.jsx'],
    route: '/codex', action: 'workspace',
    parity: 'A model proposal is shown as a diff and only written when approved; the approval mode decides whether that is a click or automatic.',
    gap: 'The patch format is unified diff, not Codex\'s apply-patch envelope, so a patch from Codex itself needs a conversion step.'
  },
  {
    id: 'skills', label: 'Skills (SKILL.md)', group: 'extend',
    crates: ['skills', 'core-plugin-common', 'plugin-host', 'plugins'],
    files: ['lib/skills.js', 'lib/skillkit.js', 'web/src/pages/Skills.jsx'],
    route: '/skills', action: 'skills',
    parity: '2,208 indexed skills from permissively licensed sources; hybrid retrieval, budgeted prompt grounding with `skill_get` pointers, install into ~/.qoder, ~/.codex or ~/.claude, and a frontmatter parser that repairs rather than rejects.',
    gap: 'Plugin packaging (.codex-plugin/plugin.json owners, dependency manifests) is read but not installable, and no marketplace.'
  },
  {
    id: 'agents-md', label: 'AGENTS.md / project memory', group: 'extend',
    crates: ['config', 'codex-home', 'prompts', 'context-fragments'],
    files: ['lib/workspace.js', 'web/src/pages/Claude.jsx'],
    route: '/codex', action: 'workspace',
    parity: 'AGENTS.md discovered from the workspace root upward and injected as context, with the same "nearest file wins" rule.',
    gap: 'No nested per-directory fragments merged at call time; memory is one project file.'
  },
  {
    id: 'mcp', label: 'MCP servers & connectors', group: 'extend',
    crates: ['mcp', 'codex-mcp', 'rmcp-client', 'message-board-mcp'],
    files: ['lib/mcp.js', 'lib/mcp-stdio.js', 'lib/tool-cache.js', 'web/src/pages/Mcp.jsx'],
    route: '/mcp', action: 'mcp',
    parity: 'HTTP, SSE and a real stdio transport (a supervised child process), OAuth with PKCE, a 21-server catalog, a tool playground and a per-server tool cache.',
    gap: 'No MCP prompts/resources surface — tool calls only.'
  },
  {
    id: 'config', label: 'config.toml & providers', group: 'platform',
    crates: ['config', 'config-schema', 'model-provider', 'model-provider-info', 'ollama', 'lmstudio'],
    files: ['lib/configimport.js', 'lib/providers.js', 'web/src/pages/Setup.jsx'],
    route: '/setup', action: 'import_config / export_config',
    parity: 'Reads ~/.codex/config.toml as a plan, shows the diff, and only writes after approval; exports back out. Local gateways (Ollama, LM Studio, vLLM) are first-class.',
    gap: 'Not every TOML key has an equivalent here; unknown keys are reported as unmapped rather than invented.'
  },
  {
    id: 'hooks', label: 'Lifecycle hooks', group: 'extend',
    crates: ['hooks', 'plugin-host', 'core-plugins'],
    files: ['lib/policy.js'],
    route: '/settings', action: 'policy',
    parity: 'Feature policy flags are applied per account and enforced by the bridge.',
    gap: 'Pre/post tool-use hook scripts are not executed. This is the largest remaining gap in the extend group.'
  },
  {
    id: 'memories', label: 'Memories & goals', group: 'agent',
    crates: ['memories', 'thread-store', 'state'],
    files: ['web/src/pages/Claude.jsx', 'lib/store.js'],
    route: '/claude', action: 'threads',
    parity: 'Persistent project memory (ANTICODEX.md) and plans in the Agent Studio, carried between turns.',
    gap: 'No separate goals ledger with completion state; memory is a document the model reads.'
  },
  {
    id: 'code-mode', label: 'Structured code mode', group: 'agent',
    crates: ['code-mode', 'code-mode-host', 'code-mode-protocol', 'code-mode-runtime', 'v8-poc'],
    files: ['lib/sandbox.js', 'web/src/pages/Sandbox.jsx'],
    route: '/sandbox', action: 'sandbox',
    parity: 'The model writes a snippet and it is executed with the real runtime, returning stdout, stderr, exit code and written files.',
    gap: 'No embedded JS runtime with the tool namespace bridged into it (v8-poc upstream); this runs the snippet as a process.'
  },
  {
    id: 'cloud', label: 'Cloud tasks', group: 'platform',
    crates: ['cloud-tasks', 'cloud-tasks-client', 'cloud-client', 'cloud-config', 'workload-identity'],
    files: ['lib/qoder.js', 'web/src/pages/Qoder.jsx'],
    route: '/qoder', action: 'qoder',
    parity: 'Qoder Cloud Agents (Forward + Managed): identities, templates, sessions, events, SSE streaming — implemented from the published SDK contracts.',
    gap: 'Not OpenAI\'s cloud task API; this talks to Qoder\'s. The shape (create session → send → stream events) is the same.'
  },
  {
    id: 'rea', label: 'Reverse engineering', group: 'extend',
    crates: ['—'],
    files: ['lib/rea.js', 'scripts/rea-codex-sweep.mjs', 'web/src/pages/Rea.jsx'],
    route: '/rea', action: 'rea',
    parity: 'REA installed as both a skill pack and an MCP server (207 tools), with a dry-run plan shown and fingerprinted before it is applied — plus the sweep that produced this very table.',
    gap: 'REA cannot decompile without the analysis engines it names; the page lists which are missing instead of guessing.'
  },
  {
    id: 'qoder', label: 'Qoder CLI / ACP', group: 'extend',
    crates: ['—'],
    files: ['lib/qoder.js', 'lib/qoder-repos.js', 'web/src/pages/Qoder.jsx', 'lib/qoder-fieldkit.js'],
    route: '/qoder', action: 'qoder',
    parity: 'qodercli driven over `--acp` (stdio NDJSON JSON-RPC) as a pickable agent, plus a field guide of every Qoder surface and its evidence status.',
    gap: 'Needs qodercli on the machine; the page says so and offers the install line.'
  },
  {
    id: 'rea-time', label: 'Runtime observation', group: 'safety',
    crates: ['otel-trace-websocket', 'analytics', 'feedback', 'diagnostics', 'rollout-trace'],
    files: ['lib/model-health.js', 'lib/tool-cache.js'],
    route: '/model-health', action: 'model_health',
    parity: 'Every model call recorded with latency, first-token time and verdict; an id the endpoint rejects is hidden from the picker until it works or the verdict expires.',
    gap: 'No OpenTelemetry export or trace replay.'
  },
  {
    id: 'desktop', label: 'Desktop shell', group: 'platform',
    crates: ['tui', 'cli', 'terminal-detection', 'arg0', 'feedback'],
    files: ['desktop/main.mjs', 'desktop/updater.mjs', 'desktop/keychain.mjs', 'desktop/computer-use.mjs'],
    route: '/computer', action: 'update_check / pair',
    parity: 'Electron app: account pairing, local keychain, auto-update the user accepts, `anticodex://` deep links, computer-use bridge.',
    gap: 'Windows packaging is wired (package-win.mjs); a signed macOS/iOS build is a separate pipeline (see docs/IOS.md).'
  },
  {
    id: 'voice', label: 'Voice & dictation', group: 'chat',
    crates: ['voice-host', 'realtime-webrtc', 'transcription'],
    files: ['lib/extras.js'],
    route: '/settings', action: 'extras',
    parity: 'Whisper transcription for voice input and ElevenLabs for read-aloud, resolved through the same keychain as every other service.',
    gap: 'No realtime WebRTC duplex voice session.'
  },
  {
    id: 'multi-agent', label: 'Agent roles & collaboration', group: 'agent',
    crates: ['agent-roles', 'agent-graph-store', 'agent-identity', 'collaboration-mode-templates', 'message-board', 'agent-message-board-client', 'agent-message-board-host'],
    files: ['lib/workspace.js', 'web/src/pages/Claude.jsx'],
    route: '/claude', action: 'workspace',
    parity: 'Agent Studio with plans, a live tool log and per-project memory.',
    gap: 'No multi-agent message board or role graph — one agent per turn here.'
  },
  {
    id: 'secrets', label: 'Keychain & login', group: 'platform',
    crates: ['keyring-store', 'login', 'secrets', 'aws-auth', 'codex-api'],
    files: ['lib/keys.js', 'lib/authx.js', 'desktop/keychain.mjs'],
    route: '/settings', action: 'login / user_keys',
    parity: 'scrypt-hashed accounts, session tokens, GitHub OAuth, emailed 6-digit codes with expiry, and per-account provider keys resolved before env.',
    gap: 'No OS keychain on the web build (desktop only), and no hardware-backed store.'
  }
];

/** Crates upstream ships but that have no user-facing equivalent here, named so
 *  the gap list is complete rather than flattering. */
export const CODEX_UNPORTED = [
  'realtime-webrtc', 'otel-trace-websocket', 'mxc-sandbox', 'code-mode-runtime (v8 bridge)',
  'plugin-host marketplace', 'hooks execution', 'azure/aws workload identity', 'mlc/agent-message-board'
];

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** The map, resolved against the filesystem. */
export function codexParity() {
  const rows = CODEX_SURFACES.map((s) => {
    const present = s.files.filter(exists);
    const status = present.length === s.files.length ? 'parity' : present.length ? 'partial' : 'missing';
    return {
      id: s.id,
      label: s.label,
      group: s.group,
      crates: s.crates,
      files: s.files,
      present,
      route: s.route || null,
      action: s.action || null,
      parity: s.parity,
      gap: s.gap || null,
      status
    };
  });
  const tally = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  return {
    ok: true,
    source: CODEX_SOURCE,
    counts: { crates: CODEX_CRATES.length, docs: CODEX_DOCS.length },
    tally,
    rows,
    unported: CODEX_UNPORTED
  };
}

/** One crate by name, with the surfaces that claim it — the reverse lookup the
 *  evidence page uses when you click a crate. */
export function crateDetail(name) {
  const crate = CODEX_CRATES.find((c) => c.name === name);
  if (!crate) return null;
  const rows = codexParity().rows.filter((r) => r.crates.includes(name) || r.crates.some((c) => c.startsWith(`${name}::`)));
  return { crate, surfaces: rows };
}

/** The largest crates upstream, for the "what Codex actually is" panel. */
export function biggestCrates(n = 12) {
  return CODEX_CRATES.slice(0, n).map((c) => ({
    name: c.name, kind: c.kind, source_files: c.source_files,
    kb: Math.round(c.source_bytes / 1024), modules: c.modules.length
  }));
}
