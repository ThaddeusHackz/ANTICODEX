# ANTICODEX Forensic Report
### Reverse-engineering sweep of ChatGPT/Codex + Claude desktop apps, web products, and CLI agents
**Date:** 2026-10-18 · **Method:** REA v42 + leanrea fast-path · **Evidence classes:** [seen] = directly observed artifact, [inferred] = reasoned from evidence/training knowledge

> Scope note: everything marked **[seen]** below was extracted from real artifacts supplied by the owner —
> the Windows Store (MSIX) packages and runtime data directories for both desktop apps in the Google Drive
> `ANTICODEX` folder — plus the public `openai/codex` (Apache-2.0) and `anthropics/claude-code` repositories.
> Live `chatgpt.com` / `claude.ai` network capture was **not** possible from the build sandbox (allowlisted
> egress); web-product findings are reconstructured from the shipped clients, manifests, config surfaces and
> public knowledge, and are marked **[inferred]** where not directly observed. Credential files in the capture
> (`auth.json`, `.env`, `.sandbox-secrets/`) were deliberately **not opened**.

---

## 0. Tooling installed and how it was used

| Tool | Source | Role in this sweep |
|---|---|---|
| **REA (Reverse Engineer Anything) v42** | `morluto/rea` → installed to `skills/` (5 skill packs + reference playbooks: `reverse-engineer-anything`, `rea-tool-design`, `rea-analysis-optimization`, `rea-ci-tests-audit`, `rea-changelog-update`) | Master methodology: route by artifact type, evidence-first claims, runtime observation playbooks |
| **leanrea** | `aicodeking/leanrea` → installed to `skills/leanrea/` | Fast-path command router (Electron/asar, PE/ELF, JS bundles, SQLite, plists, HAR, websites) — used for every extraction step below |
| **openai/codex** | shallow-cloned to `vendor/codex` (Apache-2.0) | Architecture ground truth for the Codex desktop app + CLI (codex-rs workspace: `app-server`, `code-mode`, `cloud-tasks`, `bwrap` sandboxing, `apply-packet`, protocol crates) |
| **anthropics/claude-code** | shallow-cloned to `vendor/claude-code` | CLI/agent product surface (skills, plugins, hooks, CLAUDE.md memory model) |

Security vetting of both skill packs (grep for `curl|bash`, `eval`, reverse-shell patterns) found only expected
offensive-security tooling inside REA's pwntools/pwndbg crash-analysis bridges and installers — **no malicious
payloads** [seen].

---

## 1. ChatGPT / Codex Windows desktop app (`OpenAI.Codex`)

Evidence: `ANTICODEX/CHATGPT files to reverse engineer/` — full MSIX package layout + `.codex/` runtime dir.

### 1.1 Package identity (AppxManifest.xml) [seen]
```
Identity            Name="OpenAI.Codex"  Version="26.1013.4894.0"  Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"
DisplayName         ChatGPT · PublisherDisplayName "OpenAI" · brand BackgroundColor #3143FF
Executables         app/ChatGPT.exe (shell, 4.8 MB) · resources/codex.exe (bundled Codex CLI)
                    resources/codex-command-runner.exe (alias codex-core-command-runner.exe)
                    resources/codex-windows-sandbox-service.exe (SYSTEM Windows service)
                    resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe
                    (alias codex-chrome-native-host.exe)
Service             CodexSandboxService.OpenAI.Codex — StartAccount=localSystem, StartupType=auto
Firewall            TCP 1455, 1457 (shell↔codex IPC) · proxy pools 3128-3159 and 8081-8112 for codex.exe
COM server          windows-account.node (clsid d28d30e7-17f3-41d9-93f0-9bae6dc4884b) — account integration
Explorer menu       "OpenProjectInCodex" on directories (via the COM class)
Protocol            codex://  (%1 single-argument)
File types          .skill (Codex skills!) · spreadsheet takeover .csv/.docx/.pptx/.xls/.xlsm/.xlsx/.tsv
Startup task        "ChatGPT" login launch
Copilot key         com.microsoft.windows.copilotkeyprovider app-extension (Copilot-key launch)
Capabilities        runFullTrust, unvirtualizedResources, packagedServices, localSystemServices,
                    graphicsCaptureProgrammatic, graphicsCaptureWithoutBorder (screen capture!)
Registry carve-outs Chrome NativeMessagingHosts (browser bridge), virtualization exclusions for
                    LocalAppData\OpenAI
```

### 1.2 Engine architecture [seen + inferred]
- The `app/` payload is a **Chromium-embedded shell** (chrome.dll ≈ 330 MB, `v8_context_snapshot.bin`,
  `owl-shell-runtime.json`, d3dcompiler/dxcompiler, Vulkan+SwiftShader) — the same class of architecture as
  Electron but a custom CEF-style wrapper ("owl shell") [seen file inventory].
- `ChatGPT.exe` (4.8 MB) is the thin launcher over the Chromium runtime [seen sizes; role inferred].
- `codex.exe` is the bundled **Codex CLI agent**; `codex-command-runner.exe` is a separate full-trust app with a
  CLI execution alias — the "run commands for me" surface [seen manifest; roles inferred].
- A **localSystem Windows service** provides the sandbox (`codex-windows-sandbox-service.exe`), with localhost
  proxy pools (3128-3159 / 8081-8112) that agent-driven commands route through [seen manifest + firewall ranges].
- **Browser integration**: Chrome native-messaging host (`codex-chrome-native-host.exe`) + registry write carve-out
  — this is how the ChatGPT/Codex desktop app drives Chrome (the "browser integration / agent mode" feature) [seen].
- **Screen capture** is declared at the package level (`graphicsCaptureProgrammatic`, `graphicsCaptureWithoutBorder`)
  — the desktop vision / computer-use pipeline [seen].
- Windows account integration via a COM-surrogate native module (`windows-account.node`) [seen].

### 1.3 `.codex/` runtime state directory (65 items) [seen]
This is the gold: the live user-state schema of the product.

| Area | Evidence | Reconstructed feature |
|---|---|---|
| Config | `config.toml`, `gpt6.config.toml`, `version.json` (`latest_version 0.160.0`), `installation_id`, `.env` | TOML config + separate model config ("gpt6"), self-update checker with `dismissed_version` |
| Auth | `auth.json` *(not opened)*, `cap_sid` | Account/session tokens, capability session id |
| Conversations | `thread_history_1.sqlite` (+wal/shm, 6.4 MB), `session_index.jsonl`, `history.jsonl`, `sessions/`, `archived_sessions/` | SQLite thread store + JSONL session index |
| Memory | `memories/`, `memories_1.sqlite`, `goals_1.sqlite` | Persistent memories + **goals** engine |
| Work queue | `queue_1.sqlite` (+wal), `state_5.sqlite`, `logs_2.sqlite` (38 MB) | Background task queue, global state, telemetry logs |
| Sandbox | `.sandbox/`, `.sandbox-bin/`, `.sandbox-secrets/`, `.sandbox_migration` | Filesystem sandbox with its own bins + secrets store + schema migration marker |
| Agents | `skills/` (+ `.skill` file association), `plugins/`, `code-mode*` crates in OSS, `node_repl/`, `packages/`, `vendor_imports/` | Skill packages (installable .skill files), plugin system, Node REPL, package imports |
| MCP | `mcp-oauth-locks/` | **MCP OAuth flows with lock files** (exactly the ChatGPT connector pattern) |
| Browser/computer | `browser/`, `computer-use/` | Browser control + computer-use feature dirs |
| Server surfaces | `app-server-daemon/`, `app-server-control/` | Local app-server (matches `app-server*` crates in openai/codex) |
| UX extras | `pets/`, `visualizations/`, `dictation-history/`, `transcription-history.jsonl`, `.personality_migration` | Companions ("pets"), charting, voice dictation w/ transcription history, **personality** migrations |
| Files | `attachments/`, `backups/`, `cache/`, `tmp/`, `sqlite/`, `thread-writer-locks/`, `tmp/`, `.tmp/` | Standard durability scaffolding |

### 1.4 Public `openai/codex` workspace (Apache-2.0) [seen]
`codex-rs/` confirms the agent internals the desktop app wraps: `app-server` + `app-server-protocol` (JSON-RPC-ish
control plane), `code-mode`/`code-mode-runtime` (structured code execution), `bwrap` (Linux sandbox), `apply-patch`
(diff/patch engine), `cloud-tasks`/`cloud-client` (cloud sandboxes), `chatgpt` (auth/model client), `codex-api`,
`backend-client`, `agent-graph-store`, `agent-roles`, `analytics`. ANTICODEX re-implements equivalent surfaces
(workspace, approvals, patch proposals, sandbox exec, MCP) as original code — Apache-2.0 attribution in NOTICE.

---

## 2. Claude desktop app (`AnthropicPBC.Claude`)

Evidence: `ANTICODEX/CLAUDE files to reverse engineer/` — MSIX package + `.claude/` runtime dir.

### 2.1 Package identity (AppxManifest.xml) [seen]
```
Identity            Name="AnthropicPBC.Claude" Version="2.42304.0.0" Publisher="CN=0ED83B57-1FA9-465C-98F8-41F190D0DF7F"
DisplayName         Claude · "Desktop application for Claude.ai" · publisher "Anthropic, PBC"
Executables         app/Claude.exe · resources/cowork-svc.exe
Service             CoworkVMServiceStore — localSystem, ETW trigger, named pipe \\.\pipe\cowork-vm-service-store
                    (VM service for "Cowork" — Claude's autonomous computer-use/agent product)
Browser bridge      com.anthropic.claude_browser_extension native messaging registered for
                    Chrome, Brave, Edge, Prisma Access, Island, Chromium, Arc, Vivaldi, Opera
Chrome extension    IDs fcoeoabgfenejglbffodgkkbkcdhcgfn (prod) and dngcpimnedloihjnnfngkgjoidhnaolf (Nest)
Office add-in       sideload via WEF TrustedCatalogs (LocalAppData\Microsoft\Office\16.0\WEF) — Claude for Office
Protocol/alias      claude:// · claude-desktop-msstore.exe · startup task "ClaudeStartup" with --startup param
User data           LocalAppData\Claude-Data (1P), LocalAppData\Claude-3p (3P), LocalAppData\Claude\logs
Min OS              10.0.18362 · per-monitor scale resources (125–400%)
Firewall            broad in/out TCP for Claude.exe and cowork-svc.exe
```

### 2.2 `.claude/` runtime directory (16 items) [seen]
`settings.json`, `policy-limits.json` (+ `.stamp.json`), `remote-settings.json`, `telemetry/`, `skills/`,
`shell-snapshots/`, `sessions/`, `session-env/`, `plugins/`, `backups/`, `plans/`, `file-history/`, `ide/`,
`projects/`, `.last-cleanup`.
→ Claude Code-style **plans**, **file-history**, **shell-snapshots**, **session-env**, **IDE integration**,
**policy limits** (usage caps delivered remotely), **skills/plugins** all live in the desktop app too [seen].

### 2.3 `anthropics/claude-code` repo [seen]
Docs/CLAUDE.md/plugins/examples for the terminal agent: skills, hooks, MCP, CLAUDE.md project memory, plan mode,
subagents. The desktop app is Electron/Chromium-class (chrome.dll etc. in `app/`) with the same plugin/skill model.

---

## 3. Web products (chatgpt.com & claude.ai) — feature inventory [inferred from shipped clients + public knowledge]

**ChatGPT product class:** sidebar threads + search, model picker (GPT-class + reasoning o-series), temporary chat,
custom GPTs/Assistants, memory + reference controls, voice mode, canvas/artifacts, file analysis (incl. spreadsheets
→ the `.csv/.xlsx` takeover in the desktop manifest [seen]), image gen (incl. GPT-4o image), web browsing w/ citations,
deep research, tasks/scheduled jobs (queue sqlite [seen]), connectors (MCP), codex coding agent (cloud tasks), SSO.

**Claude product class:** chats + Projects (shared instructions/artifacts), styles, artifacts panel, extended
thinking, MCP connectors, skills, Claude Code (terminal + IDE), Cowork computer-use, file analysis, styles/brand tone,
usage/policy limits (policy-limits.json [seen]), prompt library, citations, Google/Office integrations (WEF catalog
[seen]).

**ANTICODEX ships equivalents:** threads + search, multi-provider model picker (NVIDIA NIM + custom), memory
(ANTICODEX.md), files+vision, web search w/ source chips, image studio (Flux), video studio (Hailuo), MCP connector
catalog w/ OAuth-style authorize pages + permission editor, Codex workspace (files/diff/terminal/approvals), Agent
Studio (plans/memory/skills/tool log), computer-use (pairing + desktop bridge), connectors, admin console.

---

## 4. How each discovery was mapped into ANTICODEX

| RE finding | ANTICODEX implementation |
|---|---|
| `codex://` protocol + account COM bridge | `anticodex://` deep-link registration + `acx:state` desktop bridge (main.mjs) |
| `codex-windows-sandbox-service` + proxy pools | Sandbox terminal + approval modes (suggest/auto-edit/auto-run) in Codex workspace; desktop `computer-use.mjs` with confirm-gated privileged actions |
| `codex-chrome-native-host` | Playwright/Puppeteer MCP connectors + browser automation catalog entries |
| `graphicsCapture*` capabilities | `acx:computer screenshot` via Electron desktopCapturer → vision model |
| `.skill` file association + `skills/` | Skills panel (REA, leanrea + claude-desktop skill surfaces) in Agent Studio |
| `mcp-oauth-locks` | MCP authorize tickets + approve flow + permission editor (mcp.js / Mcp.jsx) |
| `memories/`, `goals_1.sqlite` | Project memory editor + plan list in Agent Studio |
| `plans/`, `file-history/`, `shell-snapshots/` | Plan editor, file tree with persisted virtual FS, terminal history in Codex workspace |
| `policy-limits.json`, `remote-settings.json` | Admin console (global keys, broadcasts) + `/api/releases/latest` update feed |
| `version.json` self-update (`dismissed_version`) | Desktop updater with user-accept gate (`updater.mjs`) |
| Claude `CoworkVMServiceStore` | Computer-use page: pairing codes, action confirmations, live console |
| Claude browser-extension native hosts | MCP browser connectors + "Integration" category |
| Spreadsheet takeover (`.xlsx` …) | File/vision analysis in chat (attach → vision-capable model) |

---

## 5. Evidence appendix (verbatim highlights)

**ChatGPT/Codex AppxManifest (extract):** `Identity Name="OpenAI.Codex" … Version="26.1013.4894.0"` ·
`<desktop6:Service Name="CodexSandboxService.OpenAI.Codex" StartupType="auto" StartAccount="localSystem" />` ·
`<desktop:ExecutionAlias Alias="codex-chrome-native-host.exe" />` · `<uap3:Protocol Name="codex" …/>` ·
`<uap:FileType>.skill</uap:FileType>` · firewall `LocalPortMin=1455 LocalPortMax=1455`, `3128-3159`, `8081-8112`.

**Claude AppxManifest (extract):** `Identity Name="AnthropicPBC.Claude" … Version="2.42304.0.0"` ·
`<desktop6:Service Name="CoworkVMServiceStore" …> <desktop6:TriggerCustom … Value="\\pipe\cowork-vm-service-store" />` ·
NativeMessagingHosts for `com.anthropic.claude_browser_extension` across 9 browsers ·
`<virtualization:ExcludedDirectory>$(KnownFolder:LocalAppData)\\Claude-3p</…>`, `Claude-Data`, `Claude\\logs`.

**version.json:** `{"latest_version":"0.160.0","last_checked_at":"2026-10-04T21:29:32.379041400Z","dismissed_version":null}`

---

## 6. Verdict

Both desktop apps are Chromium-shell products with (a) a privileged local **service** for sandbox/VM duties,
(b) **browser-native-messaging** integration, (c) **MCP + OAuth** connector stores, (d) **skills/plugins**,
(e) **memory/goals/plans**, (f) **screen-capture**-based computer-use, and (g) **self-update** feeds. ANTICODEX
reproduces every one of those capability classes as original, cleanly-branded software — Prism UI, multi-provider
NVIDIA-first model routing, Flux + Hailuo media, Supabase backend, Windows desktop with accept-to-update — without
copying any proprietary asset, name, or copyrighted code from OpenAI or Anthropic.
