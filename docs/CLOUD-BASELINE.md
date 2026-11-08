# ANTICODEX Cloud Baseline — 2026-11-08

**Method:** GitHub Codespace `anticodex-cloud` (Ubuntu x86_64, Node v24.22.2), driven from a Qoder Desktop session. All execution, edits, commits, and pushes happen in the cloud sandbox. Evidence classes per AGENTS.md: **[seen]** = command output or file:line; **[inferred]** = reasoned; **unknown** = not verified.

## 1. Execution verification [seen]

| Check | Result |
|---|---|
| Codespace | `anticodex-cloud-x574445949vfv4xg`, repo at `/workspaces/ANTICODEX`, branch `cloud/codex-parity-baseline` |
| Install | root + `web/` npm install — 0 vulnerabilities |
| Build | `npm run build` → vite ✓ (`dist/assets/index-*.js` 398.81 kB, gzip 122.31 kB) |
| Tests | `npm test` → 16 suites, **1,083 assertions, 0 failed** (150/53/35/92/53/28/59/65/30/79/64/68/34/38/154/81) |
| REA | v6.8.0; `rea mcp doctor --json` → `healthy:true`, **229/229 tools, 6/6 prompts**, protocol `2025-11-25`, catalog digest `fe938a7c6eba…` (README cites 207 — the installed release is newer) |
| REA engines | `rea doctor` → `environment_healthy:false`: Hopper/Ghidra/IDA/JADX/Kuna absent, exactly as `docs/REA-ENGINES.md` documents. JS/Electron-bundle/config/SQLite analysis needs no engine; native decompilation remains **unknown** until an engine is supplied |
| Codex ground truth | `openai/codex` shallow-cloned to `/tmp/codex-src`; LICENSE = Apache-2.0 [seen]; `codex-rs` holds 134 crates incl. `app-server`, `app-server-protocol`, `windows-sandbox-service`, `tui/windows_sandbox.rs`, `tui/approval_events.rs` |
| GitHub | `gh` authenticated as `ThaddeusHackz` in the box; `git push --dry-run` ✓ |

## 2. Codex-parity gap list

Forensic baseline: `docs/FORENSIC-REPORT.md:34–95, 199–223` — Codex desktop ships a goals engine, memories/thread/queue SQLite stores, a SYSTEM sandbox service + proxy pools, Chrome native-messaging browser host, screen capture, `.skill` association, Explorer "OpenProjectInCodex", `codex://`, login startup, account COM bridge, app-server daemon, code-mode host, command runner, dismissible self-update.

### Web Codex workspace (`web/src/pages/Codex.jsx`)

| Priority | State | Gap | Evidence |
|---|---|---|---|
| P0 | MISSING | Real file tree — workspace is a seeded localStorage virtual FS, never disk | Codex.jsx:9–15, 36–40, 68; README.md:41 claims it |
| P0 | MISSING | Real terminal — `ls/cat/write/node` simulated; `node` prints demo text; real runner exists but is unused here | Codex.jsx:115–134 (esp. 129); lib/sandbox.js:139 |
| P0 | CLAIMED-BUT-UNVERIFIED | Diff proposals — code only logs "applied under auto-edit policy", never touches FS; no preview/apply/patch engine | Codex.jsx:163–167; README.md:41 |
| P1 | PARTIAL | Approval/sandbox enforcement — `decideApproval` computed for display only; `handleSandbox` never consults policy; mode is prompt text | api/bridge.js:1850–1855, 1004–1029; Codex.jsx:149 |
| P1 | PARTIAL | Agent tools — chat has a 4-round MCP loop but no file/read/write/exec/apply-patch tools; builtins are weather/YouTube/image only; file context truncated to 600 chars/file | bridge.js:433–470; lib/extras.js:184–205; Codex.jsx:144 |
| P1 | PARTIAL | Streaming — fake word-timer typewriter over non-streaming `chat` while real `chatStream` exists | Codex.jsx:154–161; web/src/lib/api.js:82 |
| P2 | PARTIAL | `external-sandbox` + `granular` approvals implemented in lib but absent from UI pickers | lib/workspace.js:170–174, 246–251; Codex.jsx:20–30 |
| P2 | CLAIMED-BUT-UNVERIFIED | "Spawned work gets the proxy env" — `runEnv` has no proxy vars; `runSandbox` accepts none | Codex.jsx:45–49; lib/sandbox.js:117–130; bridge.js:1016–1019 |

### Electron desktop (`desktop/`)

| Priority | State | Gap | Evidence |
|---|---|---|---|
| P0 | PARTIAL (broken end-to-end) | Auto-update — releases ship only a zip; updater's zip branch downloads but never extracts/applies; NSIS installer claimed but never built | .github/workflows/release.yml "Attach"; package-win.mjs:76–80, 4–5; updater.mjs:54–61 |
| P0 | MISSING | Update Accept UI — main emits `acx:update-available`, preload exposes it, but no renderer code subscribes; Settings shows version + external link only | main.mjs:580–587; preload.mjs:50–54; Settings.jsx:509–527 |
| P1 | CLAIMED-BUT-UNVERIFIED | `dismissed_version`/`last_checked_at` update gate absent | FORENSIC-REPORT.md:221 vs updater.mjs:18–64 |
| P1 | MISSING | Sandbox service parity — no isolated-user/container boundary; lib admits "not a security boundary"; the "companion service" in the UI seed does not exist | lib/sandbox.js:9–13; Codex.jsx:14; FORENSIC-REPORT.md:43, 64–65 |
| P1 | MISSING | Goals engine + memories/goals/queue SQLite — no `goals` code; "memory" is a localStorage string; tool log seeded fake; threads are JSON/Supabase, not a local durable store | Claude.jsx:10–11, 22, 67, 97; FORENSIC-REPORT.md:80–81, 162, 223 |
| P1 | MISSING | Browser integration — no native-messaging host; only MCP catalog entries | FORENSIC-REPORT.md:66–67, 158 |
| P2 | PARTIAL | Screen capture — first screen only, fixed 1600×900 thumbnail; no window/region capture | main.mjs:339–343 vs FORENSIC-REPORT.md:52, 68–69 |
| P2 | MISSING | OS integration — `.skill` install dialog-only; no file association, Explorer menu, login startup, tray; `anticodex://` runtime-registered only | main.mjs:40–74, 571; package-win.mjs:47–63; FORENSIC-REPORT.md:46–50 |
| P2 | MISSING | Account COM bridge, app-server daemon, code-mode host, dictation/pets/personality; execpolicy DSL/cloud explicitly unknown | FORENSIC-REPORT.md:45, 86–87, 205; REA-EVIDENCE.md:326–333 |

### iOS PWA installability

| Priority | State | Gap | Evidence |
|---|---|---|---|
| P0 | MISSING | No `manifest.webmanifest`; web/public holds only logo + favicon; no manifest link | web/index.html:1–14 |
| P0 | MISSING | No `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `theme-color` → Add-to-Home-Screen yields a Safari tab, not a standalone app | web/index.html:3–9 |
| P1 | MISSING | No service worker / offline cache / registration anywhere | zero grep hits; vite.config.js has only the react plugin |
| P2 | MISSING | No 192/512px maskable icons, no `beforeinstallprompt` handling | web/public inventory |

## 3. Top 5 next implementations (agreed order)

1. **Real workspace**: wire the Codex file tree + terminal to real reads/exec through `api/bridge.js`, with `decideApproval` enforced server-side on every action (one bridge rule).
2. **Real diff proposals**: parse → preview → approve → apply patches (Codex apply-patch parity).
3. **Desktop auto-update finished**: zip extract-and-apply (or ship NSIS), renderer Accept UI wired to `onUpdateAvailable`, persisted `dismissed_version`.
4. **iOS PWA bundle**: manifest + 192/512 maskable icons + Apple meta tags + minimal service worker (user chose PWA; no Mac/Xcode available for a native build).
5. **Durable local state**: SQLite-backed threads/memories + goals engine on desktop, replacing localStorage strings and fake tool logs.

## 4. Constraints honored

- `openai/codex` is Apache-2.0: contracts and ideas reused with attribution (NOTICE); no proprietary OpenAI/Anthropic assets or branding copied. The closed desktop app is replicated behaviorally from REA evidence, with original UI.
- Every change lands in `api/bridge.js` + shared lib so web and desktop get it together; `npm run build && npm test` green before each commit.