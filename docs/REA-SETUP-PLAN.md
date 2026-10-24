# REA setup plan — reviewed and applied

**Status: APPLIED on 2026-10-24** with approval (`--client claude_code`, no Hopper). Verification
results are in [`REA-EVIDENCE.md`](REA-EVIDENCE.md) §1; the product-side connector and the
config-import engine built from the Drive artifacts are documented in the same file.

Generated from the actual `--dry-run` output on this machine. The text below is the plan exactly as it
was shown before anything was written.

## 0. Preflight — what is already true (read-only, done)

| Check | Result |
|---|---|
| `node --version` | **v22.22.3** ✅ (REA 6.7.0 declares `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`) |
| `npm --version` | 10.9.8 |
| `npx rea-agents@latest --version` | **6.7.0** (`rea` + `rea-agents` bins) |
| `rea mcp doctor --json` | **healthy: true**, server name **`rea`**, protocol `2025-11-25`, **207 tools / 6 prompts**, catalog digest matches the package |
| Detected agent clients | **none** of the 23 REA supports (Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, VS Code, Copilot CLI, …) |
| Native analysis engines | Ghidra ✗, IDA ✗, JADX ✗, Kuna ✗ (no `GHIDRA_INSTALL_DIR` etc.) — also no tshark / sigrok / WABT |

## 1. `npx rea-agents@latest setup` — the exact proposed actions

With **no client detected**, a bare `setup --dry-run` resolves to an empty plan
(`plannedActions: []`). Scoped to a real client, the plan is:

```json
[
 { "id": "configure_client:claude_code", "kind": "configure_client", "operation": "create",
   "target": "/home/user/.claude.json",
   "detail": "Add the REA MCP registration for Claude Code; preserve unrelated configuration.
              Command: \"npx\" \"-y\" \"rea-agents@6.7.0\" \"mcp\". No additional provider
              environment variables. Existing server environment overrides are retained." },
 { "id": "install_skill:claude_code", "kind": "install_skill", "operation": "install",
   "target": "/home/user/.claude/skills/reverse-engineer-anything",
   "detail": "Install or update the REA skill in Claude Code's personal skill directory." }
]
```

- **Writes:** `/home/user/.claude.json` (create) and `/home/user/.claude/skills/reverse-engineer-anything/` (install). Outside the repo — nothing in ANTICODEX is touched by `setup`.
- **Backups:** REA writes a `.bak` of any file it rewrites; the plan re-resolves the backup path if the file changed between plan and apply.
- **Does not:** install Hopper, Ghidra, Java, Node, npm, or any system package. `--install-hopper` is the only opt-in and is **not** requested here (it is macOS-only and this is Linux).
- **Skill replacement:** the bundled REA skill replaces the copy in `~/.claude/skills`; the repo's own `skills/reverse-engineer-anything/` is left alone.
- **Apply command (same scope):** `npx -y rea-agents@latest setup --client claude_code --yes`

## 2. Extra registration requested in the brief — "MCP server named `rea`"

`rea setup` only writes *agent client* config. To make `rea` a first-class connector **inside
ANTICODEX** (website + desktop), I propose these two additions, which the setup command does not do:

1. **Repo-level `.mcp.json`** (portable, project-scoped, standard `mcpServers` shape):
   ```json
   { "mcpServers": { "rea": { "command": "npx", "args": ["-y", "rea-agents@6.7.0", "mcp"] } } }
   ```
2. **Native connector** in the product (`lib/mcp.js`), so the browser UI and the `.exe` can call
   REA's 207 tools over stdio — the bridge today speaks **HTTP/SSE only** and cannot spawn a
   local MCP process.

## 3. Code changes this plan would make

| File | Change |
|---|---|
| `lib/mcp.js` | add `StdioMcpClient` (spawn + newline/Content-Length JSON-RPC), a `createClient(url)` factory, route `collectTools`/`executeTool`/`probeServer` through it, accept `stdio:` URLs, add REA to `MCP_CATALOG` with `id: "rea"` |
| `api/bridge.js` | `mcp:connect` / `probe` / `test` / `call` accept a stdio connection; expose `rea` status (`version`, `tools`, `healthy`) |
| `web/src/pages/Mcp.jsx` | REA card: tool count, live probe, tool playground, "run doctor" |
| `web/src/pages/Codex.jsx` | REA tools available to the agent pane (evidence bundles, `analyze-javascript-application`, `inspect-artifact`) |
| `desktop/main.mjs` | same bridge in-process → REA works offline in the `.exe`; no keychain entries needed |
| `tests/test-mcp-stdio.mjs` (new) | fixture stdio MCP server: initialize → tools/list → tools/call, plus a real-REA smoke test behind `REA_E2E=1` |
| `README.md`, `docs/REA-MCP.md` (new) | document the connector, the transcript, and the verification evidence |

## 4. Reverse-engineering targets (Google Drive → `ANTICODEX/`)

`ANTICODEX/` (`1ILynWHvqLaCACzMSo9nt23_KDKBi1-p7`) holds two unpacked **Windows MSIX/AppX** trees:

**`CHATGPT files to reverse engineer`** — ChatGPT/Codex desktop, Chromium 155.0.8059.80
`AppxManifest.xml`, `AppxBlockMap.xml`, `priconfig.xml`, `resources.pri`, `app/ChatGPT.exe`,
`app/Codex.exe`, `app/chrome.dll` (330 MB), `app/resources/app.asar` (**582 MB**),
`app/resources/{skills, plugins, plugin-signatures, artifact-template-picker, cua_node,
accessibility, default_app, native, tectonic, app.asar.unpacked}`, `pyproto/google/…`,
`owl-electron-app.json`, `owl-app.ini`, `masque-proxy-origins.txt`, and a `.codex/` home
(`config.toml`, `.codex-global-state.json`, `models_cache.json`, `session_index.jsonl`,
`thread_history_1.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`, `state_5.sqlite`).

**`CLAUDE files to reverse engineer`** — Claude desktop
`AppxManifest.xml`, `app/claude.exe` (**245 MB**), `app/resources/`, `.claude/` home
(`settings.json`, `policy-limits.json`, `skills/`, `plugins/`, `plans/`, `projects/`,
`file-history/`, `ide/`, `session-env/`, `sessions/`, `telemetry/`).

### What I will and will not touch
- **Will read:** manifests, runtime JSON/INI, config schemas, skills/plugins manifests, SQLite
  schemas (read-only copies), `pyproto` definitions, `.codex`/`.claude` state.
- **Will skip:** `auth.json`, `.env`, `cap_sid`, `.sandbox-secrets/`, `installation_id` — credentials
  and identifiers are not evidence I need and will not be copied into the repo.
- **Will not** redistribute any proprietary asset (icons, strings, code) — findings are recorded as
  behaviour + schema, and features are re-implemented as original ANTICODEX code.

### Hard limits (say so now, not later)
1. **`chatgpt.com` and `claude.ai` live sites cannot be reached from this sandbox.** Egress is
   allowlisted to npm/PyPI/GitHub; `curl https://chatgpt.com` and `curl https://claude.ai` both
   return `000` (no route). REA's browser tools (`capture_browser_scenario`,
   `analyze-web-bundle`) need a reachable origin, so a live session against those domains is
   impossible here. The two Drive app trees are the evidence I *can* work from — which is what those
   folders are for.
2. **`app.asar` (582 MB) and `claude.exe` (245 MB) exceed the 100 MB connector download cap**, so the
   ASAR cannot be pulled into the sandbox through Google Drive. Its *unpacked* siblings
   (`apps/resources/skills`, `plugins`, `artifact-template-picker`, `cua_node`, `accessibility`,
   `native`, `app.asar.unpacked`) are small and will be analysed; for the ASAR itself I will deliver
   the exact `rea analyze-javascript-application` command to run against your local copy.
3. **No native decompiler** is installed, so `chrome.dll` / `codex.exe` / `claude.exe` cannot be
   disassembled here. Built-in target-free inspectors (`inspect_go_binary`, `inspect_rust_binary`,
   `inspect_pe_resources`, `inspect_binary_layout`) and all JavaScript/Electron/SQLite analysis do
   work with no engine installed.
4. **No provider API keys exist in this checkout** (`lib/keys.js` slots are empty, no key env vars).
   Nothing will be hardcoded into Git; the connector work resolves keys the way the app already
   does (desktop keychain → account keys → env → admin config).

## 5. Features to implement from the evidence

Candidates, each traceable to a file in the two trees (final list confirmed by the analysis):

- **Skills + plugin registry** — `app/resources/skills`, `plugin-signatures`, `.claude/skills`,
  `.claude/plugins` → install/list/enable skills and signed plugins in Agent Studio.
- **Artifact templates** — `app/resources/artifact-template-picker` → template picker in Chat/Codex.
- **Approval modes + sandbox profile** — `.codex/config.toml`, `.sandbox`, `codex-command-runner.exe`
  → named approval modes and a visible sandbox policy per workspace.
- **Model catalog with capabilities** — `models_cache.json` → richer model picker metadata
  (context window, reasoning effort, tool support).
- **Memory / goals / session index** — `memories_1.sqlite`, `goals_1.sqlite`,
  `session_index.jsonl` → project memory + goals panel.
- **Policy limits + telemetry toggle** — `.claude/policy-limits.json`, `telemetry/` → an
  admin-visible limits panel and an honest telemetry switch.
- **Plan mode** — `.claude/plans`, `plans/` → plan-before-execute in the agent thread.
- **Desktop parity** — every one of the above behind the same bridge, so the `.exe` gets it too.

## 6. Verification after applying

1. `npx -y rea-agents@latest mcp doctor --json` → healthy, 207/207 tools.
2. `npx -y rea-agents@latest doctor --json` → registration healthy for the configured client.
3. `cat ~/.claude.json` → `mcpServers.rea.command == "npx"`, version-pinned.
4. ANTICODEX: `POST /api {action:"mcp", op:"probe", url:"stdio:rea"}` → `server.name == "rea"`,
   `tools.length == 207`.
5. `npm test` (API + auth + web mount + desktop) stays green, plus the new stdio test.
6. A live preview of the site with the REA connector card connected.

## 7. Out of scope for this plan

- Installing Hopper / Ghidra / IDA / JADX / Java / Node upgrades.
- Cloning ChatGPT or Claude UI, assets, strings or code into ANTICODEX.
- Fetching `chatgpt.com` / `claude.ai` (blocked by the sandbox, see §4.1).
- Writing secrets into the repo.
