// Qoder field kit — the product surface, as data.
//
// Two things live here.
//
// 1. NAV_SPEC: the rail the owner asked for, item by item, in order, with the
//    route each one has in this app and what it does. The sidebar renders from
//    this list, so "the UI should look like this" is a data change, not a
//    redesign — and an item with no destination is visible as such instead of
//    being quietly dropped.
//
// 2. SURFACES / FUNCTIONS: the Qoder field guide. For each documented Qoder
//    capability: what it is, what the evidence is, and where it lives here.
//    Status is one of
//      live      — implemented here, works on this machine/site
//      partial   — implemented with a stated limit
//      needs-cli — needs `qodercli` (or another binary) on the machine
//      external  — a Qoder-hosted service; this app integrates, it does not host
//      unrunnable— cannot run here, and the reason is named
//
// The honest answer to "impart your 1,730 skills": Qoder does not publish its
// catalog as a list, so it cannot be copied. What this app does instead is index
// every permissively licensed skill it can pin (2,208 today) *and* read the skills
// already installed under `~/.qoder/skills`, so anything the user has — Qoder's
// included — is resolvable by the same engine, with retrieval and grounding.
// `lib/skillkit.js` does the resolving; this file says so in words a page can print.

export const NAV_SPEC = [
  { id: 'new', label: 'New chat', icon: '＋', route: '/?new=1', kind: 'action', note: 'Starts a fresh thread in the current workspace.' },
  { id: 'search', label: 'Search chats', icon: '⌕', route: '/?search=1', kind: 'action', note: 'Full-text over your threads, titles first, then message bodies.' },
  { id: 'library', label: 'Library', icon: '▤', route: '/library', kind: 'page', note: 'Every artifact produced: images, videos, documents, generated files, with provenance.' },
  { id: 'chat', label: 'Chat', icon: '⌗', route: '/', kind: 'page', note: 'Multi-model chat with tools, attachments, streaming and reasoning.' },
  { id: 'codex', label: 'Codex', icon: '⌘', route: '/codex', kind: 'page', note: 'The code workspace: real files, diff proposals, approvals, terminal.' },
  { id: 'agent-studio', label: 'Agent Studio', icon: '✳', route: '/studio', kind: 'page', note: 'Plans, project memory, skills, tool log, and the agent picker (models + qodercli).' },
  { id: 'workspace', label: 'Workspace', icon: '▦', route: '/workspace', kind: 'group', note: 'Section label for the workspace pages below.' },
  { id: 'sandbox', label: 'Sandbox', icon: '⌥', route: '/sandbox', kind: 'page', note: 'Run code locally or on Daytona; see exactly what ran and where.' },
  { id: 'images', label: 'Images', icon: '▦', route: '/images', kind: 'page', note: 'Flux image generation and editing.' },
  { id: 'video', label: 'Video', icon: '▶', route: '/video', kind: 'page', note: 'Hailuo text-to-video, polled to completion.' },
  { id: 'connectors', label: 'Connectors', icon: '⇄', route: '/mcp', kind: 'page', note: 'MCP servers: catalog, OAuth, tool playground, stdio supervision.' },
  { id: 'computer', label: 'Computer Use', icon: '▣', route: '/computer', kind: 'page', note: 'Screen capture, input control, app launch — desktop bridge.' },
  { id: 'skills', label: 'Skills', icon: '✦', route: '/skills', kind: 'page', note: '2,208 indexed skills + yours from ~/.qoder, with retrieval, grounding and export.' },
  { id: 'rea', label: 'REA', icon: '⟲', route: '/rea', kind: 'page', note: 'Reverse Engineer Anything as an MCP server, with a fingerprinted setup plan.' },
  { id: 'qoder', label: 'Qoder', icon: '◈', route: '/qoder', kind: 'page', note: 'This field guide: cloud agents, ACP, the CLI, and the evidence for each claim.' },
  { id: 'setup', label: 'Bring your setup', icon: '⇪', route: '/setup', kind: 'page', note: 'Import a Codex config.toml / Claude settings.json as a reviewed diff.' },
  { id: 'daytona', label: 'Daytona', icon: '⛅', route: '/sandbox?target=daytona', kind: 'page', note: 'The remote box: SSH fields, probe, and per-run target reporting.' },
  { id: 'parity', label: 'Codex parity', icon: '◎', route: '/parity', kind: 'page', note: 'Each Codex crate, where this app implements the same job, and what is still missing.' },
  { id: 'evidence', label: 'Evidence', icon: '⌸', route: '/evidence', kind: 'page', note: 'The reverse-engineering record: what was read, from which commit, and what it proved.' },
  { id: 'settings', label: 'Settings', icon: '⚙', route: '/settings', kind: 'page', note: 'Keys, providers, personalization, data, model health.' }
];

export const QODER_SURFACES = [
  {
    id: 'cloud-agents', label: 'Cloud Agents', status: 'external',
    what: 'Qoder runs agent sessions on its own infrastructure: identities, templates, sessions, events, and an SSE feed.',
    evidence: 'qoder-cloud-agents-sdk-{ts,python,go,java} — base URLs, bearer auth, cursor pagination, event shapes.',
    here: 'lib/qoder.js implements the client (qcaRequest/qcaPage/qcaEvents) against the same bases; /qoder drives it.',
    limit: 'Needs QODER_PAT. The page reports which env var is in use, never the token.'
  },
  {
    id: 'acp', label: 'ACP (Agent Client Protocol)', status: 'needs-cli',
    what: '`qodercli --acp` speaks NDJSON JSON-RPC over stdio so a host app can drive the CLI as an agent.',
    evidence: 'qoder-acp-demos — the handshake, session/new, session/prompt, and the update stream.',
    here: 'createAcpClient + streamAcpAnswer; the CLI is pickable as a model in Chat and Codex and streams through the same SSE frames.',
    limit: 'Requires qodercli on PATH. Settings → Agents shows the install command and probes the version.'
  },
  {
    id: 'cli', label: 'qodercli', status: 'needs-cli',
    what: 'The command line agent: review, chat, custom tasks, and the ACP host mode.',
    evidence: 'qoder-action pins the version it is tested with.',
    here: 'qoderCliStatus() probes it; the GitHub Action generator emits a workflow at that pin.',
    limit: 'Not bundled — it is a Node CLI installed globally, and this app will not vendor someone else\'s binary.'
  },
  {
    id: 'action', label: 'GitHub Action', status: 'live',
    what: 'A workflow that runs qodercli over a PR: review comments, @qoder mentions, custom tasks.',
    evidence: 'qoder-action inputs.yaml + action.yml.',
    here: 'qoderActionWorkflow() generates a complete .github/workflows file you can paste.',
    limit: 'It needs the QODER_PAT repo secret; the page says so next to the generated file.'
  },
  {
    id: 'skills', label: 'Skills', status: 'partial',
    what: 'Qoder ships a catalog of skills (the owner counts 1,730) that its agent can invoke.',
    evidence: 'The catalog is not a published list; ~/.qoder/skills is the local, inspectable surface, and SKILL.md follows the same open format Codex uses.',
    here: '2,208 pinned open-source skills are indexed and resolvable, ~/.qoder/skills is read live, and exportSkill() writes any of them back into ~/.qoder/skills with normalised frontmatter.',
    limit: 'Qoder\'s proprietary catalog cannot be copied. Anything installed locally is picked up automatically, so the number you see is yours + the open corpus.'
  },
  {
    id: 'mcp', label: 'MCP servers', status: 'live',
    what: 'Qoder registers MCP servers under ~/.qoder/settings.json → mcpServers, both stdio and HTTP.',
    evidence: 'The same settings shape every Qoder client reads.',
    here: 'The Connectors page manages them; `skills`/`mcp` bridge actions read and merge the same file, preserving existing keys.',
    limit: 'Writes are loopback-only: a hosted deployment describes the file instead of editing it.'
  },
  {
    id: 'quests', label: 'Quests / multi-step tasks', status: 'partial',
    what: 'A long-running task decomposed into steps the agent works through with checkpoints.',
    evidence: 'Described in Qoder product docs; no machine-readable contract published.',
    here: 'Agent Studio plans + the workspace pending-approval queue give the same shape (plan → step → approve → verify).',
    limit: 'No resume-after-crash checkpointing of a quest; a plan is in-memory for the turn.'
  },
  {
    id: 'repos', label: 'Repo wiki / context', status: 'partial',
    what: 'Indexes a repository so answers can cite real files.',
    evidence: '49 repositories surveyed; qoderAI/better-harness describes the evidence loop.',
    here: 'AGENTS.md discovery + the file tree + file reads; the agent sees the workspace rather than an embedding index.',
    limit: 'No embedding index, so "find the function that…" is grep-plus-model, not semantic search.'
  },
  {
    id: 'daytona', label: 'Daytona sandbox', status: 'live',
    what: 'A remote Linux box reachable over SSH, used as the machine an agent runs commands on.',
    evidence: 'ssh.app.daytona.io:22, a workspace user, key auth.',
    here: 'lib/daytona.js: SSH exec/list/read/write, REST sandbox list/create, a probe, and execAnywhere() so every run reports `local` or `daytona:<name>`.',
    limit: 'Egress to Daytona must be allowed from wherever this runs. From a hosted web deploy that is usually blocked; from the desktop app it is not.'
  }
];

/** Qoder's own connection form, answered from current config. */
export function daytonaFields() {
  return {
    'Host address': 'ssh.app.daytona.io',
    Port: '22',
    Username: 'ssh <workspace-user>  (the "ssh " prefix is a label in Qoder\'s console; the login name is what follows it)',
    Authentication: 'First try "Use local SSH config and keys"; otherwise the public key shown on the Sandbox page',
    Name: 'Daytona'
  };
}

export const QODER_ACTIONS = [
  { action: 'qoder op:"status"', does: 'Token env in use, ACP client state, CLI version, base URLs.' },
  { action: 'qoder op:"cloud.whoami"', does: 'One cheap list call — is the PAT good?' },
  { action: 'qoder op:"repos"', does: 'All 49 surveyed repositories with what was taken from each.' },
  { action: 'qoder op:"action.workflow"', does: 'Generate the GitHub Action workflow at the tested qodercli pin.' },
  { action: 'qoder op:"acp.prompt"', does: 'Drive qodercli over ACP for one prompt, streaming updates.' },
  { action: 'qoder op:"fieldkit"', does: 'This guide: nav spec, surfaces, and evidence status.' }
];

export function qoderFieldKit() {
  return {
    ok: true,
    nav: NAV_SPEC,
    surfaces: QODER_SURFACES,
    actions: QODER_ACTIONS,
    daytona: daytonaFields(),
    tally: QODER_SURFACES.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }), {}),
    note: 'Status is evidence, not intent: live / partial / needs-cli / external / unrunnable, each with its limit named.'
  };
}
