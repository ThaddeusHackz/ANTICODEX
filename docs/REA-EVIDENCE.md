# REA evidence report — ChatGPT / Claude desktop, and what was built from it

Date: 2026-10-24 · Branch: `arena/760b6c38-anticodex`
Method: REA 6.7.0 over MCP (stdio) + direct reads of the artifacts in Google Drive → `ANTICODEX/`.

Conventions used below (from the `leanrea`/`reverse-engineer-anything` skill pack):

* **seen** — read out of a named file on this machine, or printed by a command whose output is quoted.
* **inferred** — a conclusion that follows from the evidence but was not itself observed.
* **unknown** — not found. Not the same as "absent".

---

## 1. REA installation and registration — verification

| Check | Command | Result |
|---|---|---|
| Node version | `node --version` | `v22.22.3` — **seen**; satisfies `^22.19.0` declared by `rea-agents@6.7.0` |
| Package resolves | `npx -y rea-agents@latest --version` | `6.7.0` — **seen** |
| Server health | `npx -y rea-agents@latest mcp doctor --json` | `healthy: true`, `adapter: production-stdio`, server `rea@6.7.0`, protocol `2025-11-25`, tools `207/207`, prompts `6/6`, catalog digest matches the package — **seen** |
| Agent config | `npx -y rea-agents@latest setup --client claude_code --yes` | wrote `~/.claude.json` → `mcpServers.rea = { command: "npx", args: ["-y","rea-agents@6.7.0","mcp"] }` — **seen** (read back) |
| Skill install | same | `/home/user/.claude/skills/reverse-engineer-anything/{SKILL.md,references}` — **seen** |
| Project registration | `npx -y rea-agents@latest mcp add --agent claude-code --no-global` | created repo `.mcp.json` with the same `rea` entry — **seen** |
| Product connector | `POST /api/bridge {action:"mcp",op:"connect_begin",url:"stdio:rea"}` | `{ok:true, connected:true, id:"rea", tools:207, server_version:"6.7.0"}` — **seen** |
| Real tool call | `mcp op:"call" tool:"analyze_javascript_application"` on `web/dist` | Evidence bundle `ev_26be2e00…`, 38 580 bytes, `JavaScriptApplicationGraph` — **seen** (39.5 s) |

### Setup plan that was approved before applying

```
configure_client:claude_code  target=/home/user/.claude.json            operation=create
install_skill:claude_code     target=/home/user/.claude/skills/reverse-engineer-anything  operation=install
```

No system package, Node upgrade, Hopper/Ghidra/IDA install was performed — **seen** in the dry-run plan, and no such install was run.

Engines present after install: none of Ghidra / IDA / JADX / Kuna / Frida / TShark / sigrok / WABT —
`doctor` reports each as `missing_analysis_engine`. So REA ran in its engine-free mode: JavaScript /
Electron / ASAR / artifact inventory / SQLite / plist / Go / Rust / PE-resource inspection. Native
**disassembly** of `chrome.dll`, `codex.exe` and `claude.exe` was therefore **not** performed.

---

## 2. Targets

`ANTICODEX/` (Drive id `1ILynWHvqLaCACzMSo9nt23_KDKBi1-p7`) contains two unpacked Windows **MSIX** trees:

* `CHATGPT files to reverse engineer ` (trailing space) — 11 top-level entries
* `CLAUDE files to reverse engineer ` (trailing space) — 13 top-level entries

### Hard limits encountered (and how they were handled)

1. **`chatgpt.com` and `claude.ai` are not reachable from this sandbox.** `curl -m 8 https://chatgpt.com`
   → `000` (no route); same for `claude.ai` and `www.google.com`. Egress here is allowlisted to
   npm/PyPI/GitHub. REPL browser tools (`capture_browser_scenario`, `analyze_web_bundle`) need a
   reachable origin, so **no live session against either domain was performed** — **seen**.
2. **`app/resources/app.asar` is 582 072 504 bytes and `claude.exe` is 245 756 240 bytes.** The Drive
   connector's inline download caps at 100 MB, so neither could be pulled into the sandbox — **seen**
   (Drive metadata). Analysis therefore used the shipped *unpacked* resources, manifests, config and
   state files, which is where the application logic that matters for this task lives.
3. **No native decompiler**, per §1 — so `chrome.dll` (329 664 816 B) and `codex.exe` (341 312 816 B)
   were inventoried but not decompiled.

### What was read

| Artifact | Bytes | Read |
|---|---|---|
| ChatGPT `AppxManifest.xml` | 8 671 | full |
| Claude `AppxManifest.xml` | 9 898 | full (first 9 000 chars inline) |
| `.codex/config.toml` | 3 077 | full |
| `.codex/version.json`, `installation_id`, `session_index.jsonl` | ≤ 3 138 | metadata |
| `.codex/models_cache.json` | 386 275 | inventoried (not inlined) |
| `.codex/.codex-global-state.json` | 925 063 | inventoried |
| `.codex/*.sqlite` (`state_5`, `thread_history_1`, `memories_1`, `goals_1`, `queue_1`) | 4 KB–6.4 MB | inventoried |
| `.claude/settings.json` | 487 | full |
| `.claude/policy-limits.json` | 582 | full |
| `.claude/policy-limits.json.stamp.json`, `remote-settings.json` | 223 / 2 | inventoried |
| `app/resources/owl-electron-app.json` | 216 | full |
| `app/resources/artifact-template-picker/server.mjs` | 30 990 | inventoried |
| directory trees: `app/resources/{skills,plugins,plugin-signatures,tectonic,default_app,native,cua_node,accessibility,app.asar.unpacked}`, `.codex/{skills,plugins,sessions,memories,computer-use,browser}`, `.claude/{skills,plugins,plans,projects,session-env,sessions,telemetry,ide,file-history,shell-snapshots}` | — | enumerated |

**Not read, deliberately:** `auth.json`, `.env`, `cap_sid`, `.sandbox-secrets/`, `installation_id`.
Nothing credential-shaped was copied into the repository. See §6 for one that was found anyway.

---

## 3. ChatGPT / Codex desktop — findings

**Identity** — `OpenAI.Codex`, version `26.1013.4894.0`, `DisplayName` **ChatGPT**, publisher
`CN=50BDFD77-…` — **seen** (AppxManifest).

**Capabilities** — `runFullTrust`, `unvirtualizedResources`, `packagedServices`, `localSystemServices`,
`internetClient`, **`graphicsCaptureProgrammatic`**, **`graphicsCaptureWithoutBorder`** — **seen**.
The two graphics-capture restricted capabilities exist for computer use; they are the manifest-level
proof that screen capture is a first-class feature rather than a side door — **inferred**.

**Process and service surface** — **seen**:
* inbound firewall rules on TCP **1455** and **1457** for `app/ChatGPT.exe`, plus **3128–3159** and
  **8081–8112** for `app/resources/codex.exe` (a comment ties the proxy ranges to an upstream PR);
* Windows service `CodexSandboxService.OpenAI.Codex`, `StartupType=auto`, `StartAccount=localSystem`,
  binary `app/resources/codex-command-runner.exe`'s sibling `codex-windows-sandbox-service.exe`;
* startup task `App`, **`Enabled="true"`**;
* COM surrogate `windows-account.node`, CLSID `d28d30e7-17f3-41d9-93f0-9bae6dc4884b`, `ThreadingModel=STA`;
* Explorer context-menu verb **`OpenProjectInCodex`** on `Directory`;
* URI scheme **`codex://`** with `--single-argument %1`;
* a second MSIX application `CodexCoreCommandRunner` (alias `codex-core-command-runner.exe`);
* app-execution alias `codex-chrome-native-host.exe` → `app/resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe`;
* file associations claiming `.csv .docx .pptx .tsv .xls .xlsm .xlsx` **and `.skill`** with
  `AllowSilentDefaultTakeOver="true"` — a `.skill` file type is a packaging decision: skills are a
  distributable unit, not just a folder convention — **inferred**.

**Runtime layout** — `owl-electron-app.json` — **seen**: `runtimeName: "owl"`, `packagedFrom`
`…/codex/codex-apps/electron/out/Codex-win32-x64`, `runtimeArchiveSha` pinned. Chromium **155.0.8059.80**
(`app/155.0.8059.80.manifest`). So the shell is Electron with a separately versioned, hash-pinned
tool runtime ("owl"), not a plain Electron app — **inferred**.

**`config.toml` — the feature model** — **seen**, all of it:

```toml
model = "gpt-6-luna"                     # + model_provider, model_reasoning_effort = "xhigh"
notify = ["…codex-computer-use.exe", "turn-ended"]

[model_providers.omniroute]              # name, base_url, env_key,
requires_openai_auth = false             #   requires_openai_auth, wire_api = "responses"

[marketplaces.openai-bundled]            # source_type = "local", source = …
[plugins."codex-app-tools@openai-bundled"]  enabled = true      # 10 plugins, refs "name@marketplace"
[mcp_servers.node_repl]                  # command, args, env_vars, startup_timeout_sec, [.env] map
[mcp_servers.browseros-neo]  url = "http://127.0.0.1:9010/mcp"
[windows] sandbox = "elevated"
[desktop] followUpQueueMode = "steer"    # + git-always-force-push, git-pr-watch-auto-merge
[notice.model_migrations] "gpt-5.5" = "gpt-6-sol"
```

Things this establishes:

* A **turn-ended hook** (`notify`) that runs a program on end-of-turn — the desktop app's answer to a
  "notify me when the agent finishes" feature — **seen**.
* **MCP servers are declared config**, with a per-server `startup_timeout_sec` (120 s for `node_repl`)
  and an env allowlist (`NODE_REPL_UNTRUSTED_ENV_ALLOWLIST`) — **seen**. That is a stronger contract
  than "paste a URL": a local server is a supervised child process.
* **Plugins are enabled per marketplace** with a `name@marketplace` reference — **seen**.
* **Sandbox mode is a named setting** (`elevated`), not an implicit behaviour — **seen**.
* **`followUpQueueMode = "steer"`** — a message sent while a turn is running *steers* it instead of
  queueing behind it — **seen** as a setting; its exact UX is **inferred**.
* **Model migrations** are declared, so a renamed id still routes — **seen**.
* `BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"` and a browser-service path under
  `NODE_REPL_TRUSTED_SERVICES` — **seen**; browser control is a trusted service, not a loose script.

---

## 4. Claude desktop — findings

**Identity** — `AnthropicPBC.Claude`, version `2.42304.0.0`, publisher `CN=0ED83B57-…`, description
`Desktop application for Claude.ai` — **seen**.

**Capabilities** — `runFullTrust`, `localSystemServices`, `packagedServices`, `unvirtualizedResources`,
`internetClient` — **seen**. Note what is *not* there: no `graphicsCapture*`, so this build does not
take programmatic screen capture at the manifest level (it drives a VM service instead, below) —
**seen**, and **inferred** as a deliberate permission choice.

**Native-messaging fleet** — `virtualization:ExcludedKeys` registers
`com.anthropic.claude_browser_extension` for **Chrome, Brave, Edge, Prisma Access Browser, Island,
Chromium, Arc, Vivaldi, Opera** plus two Chrome extension ids (`fcoeoabgfenejglbffodgkkbkcdhcgfn`,
`dngcpimnedloihjnnfngkgjoidhnaolf`) and the Office add-in trusted catalog `…\Office\16.0\WEF\TrustedCatalogs`
— **seen**. Browser integration is an explicit allowlist of enterprise browsers, which is a
distribution requirement more than a technical one — **inferred**.

**Filesystem virtualisation exclusions** — **seen**: `%LOCALAPPDATA%\Claude-3p`, `Claude-Data`,
`Claude\logs`. Comments in the manifest explain that `index.pre.ts` moves userData out of the package
when it would land on a UNC-redirected `%APPDATA%`. So the shipped app has a documented MSIX
virtualisation workaround — **seen**.

**Services and IPC** — **seen**: service `CoworkVMServiceStore` → `app/resources/cowork-svc.exe`,
`StartupType=auto`, `StartAccount=localSystem`, with a **custom ETW trigger** on
`\pipe\cowork-vm-service-store`; startup task `ClaudeStartup` (`Enabled="false"`, `--startup`); URI
scheme `claude://`; alias `claude-desktop-msstore.exe`. A VM service triggered by a pipe name means the
"cowork" feature runs in a VM and is woken on demand — **inferred**.

**`.claude/settings.json`** — **seen**: `enableWorkflows: true`, `hasCompletedOnboarding: true`, and an
`env` block pointing `ANTHROPIC_BASE_URL` at `http://localhost:20128` with five model aliases
(`cc/claude-sonnet-5`, `cc/claude-opus-5`, `cc/claude-fable-5-1`, `cc/claude-haiku-4-5-20251001`).
Shape only is reproduced here; the token in that block is handled in §6.

**`.claude/policy-limits.json`** — **seen**, the whole model:

```json
{ "restrictions": { "allow_remote_control": {"allowed": false},
                    "allow_routines": {"allowed": false},
                    "allow_quick_web_setup": {"allowed": false},
                    "allow_cobalt_plinth": {"allowed": false}, …,
                    "enforce_web_search_mcp_isolation": {"allowed": false} },
  "compliance_taints": [], "monitoring_notice": null,
  "defaults": { "remote_control_at_startup": false } }
```

Every capability is a **named restriction with an explicit `allowed`** — including a *negative*
isolation flag (`enforce_web_search_mcp_isolation: false`), which this product's policy model also
covers. Codename flags (`cobalt_plinth`, `…juniper`, `…bramble`) are **unknown** — the feature behind
them is not described by any file read here.

**Directory surface** — **seen** (enumerated): `skills/`, `plugins/`, `plans/`, `projects/`,
`policy-limits.json.stamp.json`, `remote-settings.json`, `telemetry/`, `shell-snapshots/`, `sessions/`,
`session-env/`, `file-history/`, `backups/`, `ide/`. A `policy-limits.json.stamp.json` next to the
policy is a **freshness stamp**: the app can tell whether the policy it enforced is the one the
server last published — **inferred**.

---

## 5. What was implemented from this (and what was not)

Evidence → product change, each one traceable:

| Evidence | Change |
|---|---|
| `[mcp_servers.*]` with `command`/`url`/`env_vars`/`startup_timeout_sec`; REA itself is a stdio server | **stdio MCP transport** (`lib/mcp-stdio.js`) + `createClient()` factory; REA in the connector catalogue as `stdio:rea`, version-pinned |
| `[model_providers.*]`, `.claude/settings.json env` | **`import_config`** (`lib/configimport.js`): dry-run plan → approve → connects servers, applies flags, returns providers/aliases for this device |
| `policy-limits.json` | **`lib/policy.js`** + Settings → Policy, with the same named-capability shape |
| `"gpt-5.5" = "gpt-6-sol"` migrations, model aliases | returned by the importer and stored on the device (`acx_model_migrations`, `acx_model_aliases`) |
| `notify = [cmd, "turn-ended"]` | surfaced in the import plan (`notify_hook`) |
| `followUpQueueMode = "steer"`, git flags | surfaced in the import plan as `behaviour` |
| `[plugins."name@marketplace"] enabled` | listed in the plan with marketplace scope |
| `.skill` file type; `app/resources/skills` `.curated/` | confirms the existing `skills/` pack layout is the distributable unit — no change needed |
| graphics-capture capabilities, VM service, ETW pipe | **out of scope** — see §7 |

Not implemented on purpose:

* No proprietary asset, icon, string, code or UI was copied. Findings are recorded as **behaviour and
  schema**, and the features above are original ANTICODEX code.
* The 582 MB ASAR and the 245 MB / 341 MB binaries were not analysed, so any conclusion about their
  internal code would have been a guess. `rea analyze-javascript-application <path/to/app.asar>` is the
  command to run wherever that file lives.

---

## 6. One thing found that you should act on

`.claude/settings.json` in the Drive folder contains a live-looking bearer token in its `env` block
(`ANTHROPIC_AUTH_TOKEN`, value **not** reproduced here or stored anywhere in this repo). It sits in a
shared Drive folder alongside an app tree. **Rotate it**, and treat anything in that folder as
sensitive: `.codex/auth.json`, `.codex/.env`, `.codex/cap_sid` and `.codex/.sandbox-secrets/` are the
same class of file and were deliberately not read.

`ANTHROPIC_BASE_URL` in that file is `http://localhost:20128` — a local proxy, not Anthropic's API.
Inferred: the machine runs a local router in front of several providers, which is exactly the shape
ANTICODEX's own custom-gateway support expects.

---

## 9. `openai/codex` — source (Apache-2.0), cloned and read

Checked before cloning, via the GitHub API — **seen**:

```
openai/codex    license=Apache-2.0  size=696831KB  stars=130767
openai/chatgpt  HTTP 404
```

So **Codex is Apache-2.0 and may be cloned and studied**; **there is no
`openai/chatgpt` repository** — the chatgpt.com web app has no open-source release,
and a search for repositories named `chatgpt.com` returns unrelated community
projects (`chatgpt-comparison-detection`, `command_line_chatgpt`, …), none of them
OpenAI's. Anything claiming to be "the chatgpt.com source" is not.

`git clone --depth 1 --filter=blob:none` → 137 MB working tree, `LICENSE` is the
Apache License 2.0 — **seen**. `docs/*.md` are three-line stubs that redirect to
`developers.openai.com` (unreachable from this sandbox), so **the source is the
evidence**; everything below is read from `.rs` files.

### The two enums (`codex-rs/protocol/src/protocol.rs`) — **seen**

```rust
pub enum AskForApproval {
    UnlessTrusted,                 // serde "untrusted"
    OnRequest,                     // default, alias "on-failure"
    Granular(GranularApprovalConfig),
    Never,
}

pub enum SandboxPolicy {
    DangerFullAccess,                                  // "danger-full-access"
    ReadOnly { network_access: bool },                 // "read-only"
    ExternalSandbox { network_access: NetworkAccess }, // "external-sandbox"
    WorkspaceWrite {                                   // "workspace-write"
        writable_roots: Vec<AbsolutePathBuf>,
        network_access: bool,
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    },
}
```

`GranularApprovalConfig` (`protocol.rs:1124`) has five switches — **seen**:
`sandbox_approval`, `rules`, `skill_approval`, `request_permissions`,
`mcp_elicitations`. Its documented semantics: *true* = let that class of prompt
reach the user, *false* = reject automatically instead of asking.

Also **seen**, in the same file: `WritableRoot` exists specifically so that
`.codex`, `.git` and especially `.git/hooks` stay read-only *inside* a writable
root — a writable workspace is not a blanket grant.

### AGENTS.md — **seen**

* Search order (`tui/src/status/helpers.rs` test snapshot):
  `~/.codex/AGENTS.md, ../AGENTS.md, AGENTS.md, nested/AGENTS.md` — global
  first, then one document per directory from the project root down to the cwd,
  then nested documents as the agent touches subdirectories.
* Injection shape (`core/src/compact_tests.rs:430`): the merged text is sent as a
  **user** message wrapped in `# AGENTS.md instructions for project` … `<INSTRUCTIONS>…</INSTRUCTIONS>`.
* Budget: `project_doc_max_bytes`, default `32 * 1024`
  (`thread-manager-sample/src/main.rs:330`), plus `project_doc_fallback_filenames`.

### Implemented from this — `lib/workspace.js` + `action:"workspace"`

| Codex evidence | ANTICODEX |
|---|---|
| `AskForApproval` / `SandboxPolicy` | same four modes, same wire spellings, the `on-failure` alias, and `serdeSandboxPolicy()` so a policy round-trips to `config.toml` |
| `GranularApprovalConfig` | `granular` with the same five categories and the same true=prompt / false=deny reading |
| `decideApproval()` | one matrix: `auto` / `prompt` / `deny` per action (`read` / `write` / `exec` / `network`) |
| AGENTS.md order + wrapper + `project_doc_max_bytes` | `discoverAgentDocs()` reproduces the order, the exact wrapper, the 32 KiB budget, and reports truncation per document |
| `WritableRoot` / `.git/hooks` caution | writable roots are explicit and never inherited from an unknown mode: an unrecognised sandbox string **coerces to workspace-write** rather than to full access, and says so (`coerced_from`) |

**Not copied:** no Rust code, prompts, UI or assets were transplanted. What is
reused is the *contract* (enum names and their meanings), which is what makes a
`config.toml` mean the same thing in both products.

Still **unknown** after reading the source: the model-facing prompt around the
tools, the exact execpolicy DSL, and `codex cloud` behaviour — none of which this
change depends on.

## 7. Unknowns (explicitly not established)

* What `cobalt_plinth`, `cobalt_plinth_juniper`, `cobalt_plinth_bramble` are.
* Codex's execpolicy DSL and its cloud behaviour (§9 covers the parts used here).
* The inside of `app.asar` (582 MB, not downloaded) — routing, state management, component structure.
* The rendering layer of either app: not observed, only the manifests and config.
* Whether REA's browser tools work against either live site from a network that can reach them.
* Deep native behaviour of `chrome.dll` / `codex.exe` / `claude.exe` — no decompiler installed.

---

## 8. Reproducing this

```bash
# 1. REA itself
npx -y rea-agents@latest mcp doctor --json           # healthy, 207 tools
node tests/test-mcp-stdio.mjs                        # 22 assertions, no network
REA_E2E=1 node tests/test-mcp-stdio.mjs              # 31, spawns the real server

# 2. the connector, end to end
node server.mjs &
curl -s -X POST localhost:8787/api/bridge -H 'content-type: application/json' \
  -d '{"action":"mcp","op":"probe","url":"stdio:rea"}' | jq '.server, (.tools|length)'
# → {"name":"rea","version":"6.7.0"}  207

# 3. a real analysis through the connector
curl -s -X POST localhost:8787/api/bridge -H 'content-type: application/json' \
  -d '{"action":"mcp","op":"call","connection_id":"rea","tool":"analyze_javascript_application",
       "args":{"input_path":"'$PWD'/web/dist","format":"directory"}}' | jq '.result.content[0].text | fromjson | .evidence_id'

# 4. the import engine
node tests/test-import-config.mjs                    # 53 assertions
node tests/test-workspace.mjs                        # 59 assertions (AGENTS.md + sandbox/approval)
```

## 10. The openai/codex clone

```bash
gh api repos/openai/codex --jq '.license.spdx_id'    # Apache-2.0
git clone --depth 1 --filter=blob:none https://github.com/openai/codex
rg -n "enum SandboxPolicy|enum AskForApproval" -A 22 codex-rs/protocol/src/protocol.rs
rg -n "AGENTS.md instructions" -B2 -A6 codex-rs/core/src/compact_tests.rs
```
```

---

## 11. The Drive folder, actually opened (2026-10-24, second pass)

The user's instruction was to stop treating the large artifacts as blocked and work from
Drive instead. Drive turned out to hold the **unpacked Windows packages themselves**, which
is what made this pass possible:

```
ANTICODEX/                                   1ILynWHvqLaCACzMSo9nt23_KDKBi1-p7
├── CHATGPT files to reverse engineer /      1U8EaCGic8J3BLuKCF9Buj-On7adG16YG
│   ├── AppxManifest.xml                     8 671 B     (OpenAI.Codex, DisplayName "ChatGPT")
│   ├── app/  (35 entries)                   ChatGPT.exe, Codex.exe, chrome.dll, resources/
│   ├── .codex/                              Codex home shipped with the package
│   └── resources.pri, AppxBlockMap.xml, AppxSignature.p7x …
└── CLAUDE files to reverse engineer /       1TlnGmESxW4aZVrHM3ohii4AD6uarcwV9
    ├── AppxManifest.xml                     9 898 B     (Claude 2.42304.0)
    ├── app/  (19 entries)                   claude.exe 245 756 240 B, resources/
    └── .claude/                             Claude home shipped with the package
```

**seen** — Drive listings above; file sizes as returned by the Drive API.

### 11.1 What the ChatGPT package says about itself

| Fact | Value | Where |
|---|---|---|
| Package identity | `OpenAI.Codex`, publisher `CN=50BDFD77-…`, version `26.1013.4894.0` | `AppxManifest.xml` |
| Display name | `ChatGPT` — the ChatGPT app *is* the Codex shell | `AppxManifest.xml` |
| Electron runtime | `owl` (`runtimeName`), built from `codex/codex-apps/electron/out/Codex-win32-x64` | `resources/owl-electron-app.json` |
| App version / data dir | `26.1013.40934`, user-data directory named `Codex` | `resources/owl-app.ini` |
| Local listeners | TCP 1455 and 1457 (app), 3128–3159 and 8081–8112 (codex.exe proxies) | manifest firewall rules |
| Proxy origin | `https://codex-portals.api.openai.com` | `resources/masque-proxy-origins.txt` |
| Deep link | protocol `codex`, single-instance argument `%1` | manifest |
| File associations | `spreadsheet` → csv/docx/pptx/tsv/xls/xlsm/xlsx; **`.skill`** → skill install | manifest |
| Chrome integration | native-messaging host alias `codex-chrome-native-host.exe`, registered under `HKCU\Software\Google\Chrome\NativeMessagingHosts` | manifest |
| Bundled skill root | `resources/skills/.curated/{hatch-pet,onboard-new-user}/SKILL.md` (86 445 B and 16 162 B) | Drive listing of `resources/skills` |

**seen**. The interesting part is the last two rows: a skill is a *file type* the OS hands to
the app, and curated skills ship inside the package next to the binary.

### 11.2 What the Claude package says about itself

`app.asar` from the Claude package is **49 315 901 B** — under the connector's 100 MB inline
cap, so unlike the ChatGPT bundle it could be fetched whole and unpacked.

```
CLAUDE files …/app/resources/app.asar   49 315 901 B
  → 506 files, 79 851 163 B uncompressed (header parsed locally, no npm asar package)
  .vite/build/                 Electron main + 400+ chunks (aboutWindow, buddy,
                               computerUseTeach, computerUseWatchRecord, coworkArtifact,
                               designWindow, findInPage, file-index-worker, heavy-work-worker)
  .vite/renderer/              about_window, buddy_window, find_in_page, local_exec_consent,
                               main_window …
  resources/bundled-skills/    manifest.json + 6 × .skill   ← the contract we adopted
  resources/{artifact-libs,github-mcp,office365-mcp}/
  package.json                 @ant/desktop 2.42304.0, main .vite/build/index.pre.js
```

REA (`analyze_javascript_application`, `--artifact-format directory`) over that tree:

| Result | Value |
|---|---|
| Evidence id | `ev_7407f525c6fc80494533def77d9dc2cbaabe8e7d5febf08fc12cc542e51f48cf` |
| Subject digest | `sha256:57eb5abf…d564` (`format: directory`, `authority: shipped-artifact`) |
| Files | 453 relevant, 432 parsed, 0 parse failures, 5 skipped, 0 invalid UTF-8 |
| Volume | 40 601 712 B of text, 9 072 261 AST nodes visited, 6 805 findings, 78 modules |
| Graph | 1 704 nodes / 33 092 relations, 43 647 semantic nodes, 7 557 fingerprints |
| Electron surface | 15 browser windows, 41 explicit web preferences, 52 contextBridge APIs, 37 exposed members |
| IPC | 1 535 operations — only **10 literal channels**, 1 524 dynamic; 1 301 renderer transmissions, 231 renderer listeners, 3 main handlers |
| Utilities | 3 utility processes, 0 resolved entrypoints; 0 native addon bindings |
| Limitations | 855, almost all "Resource constraint … exceeds the parent's remaining result budget" |
| Unknowns | 31 959 |

**seen** (numbers quoted from the bundle). **Inferred**: 1 524 dynamic IPC channel operations
means the channel name is computed at runtime, so static analysis can name the *shape* of the
IPC surface but not its channels; that is why the numbers are reported rather than the names.

### 11.3 The packaged-skill contract (adopted)

`resources/bundled-skills/manifest.json` — **seen**:

```json
{ "agentSkillsRef": "1792020044",
  "skills": [ { "name": "docx", "description": "Use this skill whenever …", "tier": "always" }, … ] }
```

Each `*.skill` is a ZIP — **seen** by walking the central directory:

| Archive | Bytes | Entries | Shape |
|---|---|---|---|
| `docx.skill` | 163 372 | 61 | `docx/SKILL.md`, `docx/LICENSE.txt`, `docx/scripts/*.py`, `docx/scripts/office/…` |
| `pptx.skill` | 173 007 | 57 | `pptx/SKILL.md`, `pptx/scripts/{apply_theme.js,thumbnail.py,…}`, `office/` |
| `xlsx.skill` | 155 709 | 53 | `xlsx/SKILL.md`, `xlsx/scripts/recalc.py`, `office/validators/` |
| `pdf.skill` | 21 600 | 12 | `pdf/SKILL.md`, `REFERENCE.md`, `FORMS.md`, `pdf/scripts/*.py` |
| `frontend-design.skill` | 8 125 | 2 | `frontend-design/SKILL.md`, `LICENSE.txt` |
| `pdf-reading.skill` | 7 997 | 3 | `pdf-reading/SKILL.md`, `REFERENCE.md`, `LICENSE.txt` |

The `SKILL.md` frontmatter is the same three fields Codex uses, plus `license`:

```yaml
---
name: frontend-design
description: Guidance for distinctive, intentional visual design …
license: Complete terms in LICENSE.txt
---
```

**seen**. Contract adopted into `lib/skills.js`: a `.skill` is *a container for the same
`SKILL.md` a directory root holds*. Nothing was executed, no prompt text or script copied.

### 11.4 What was built from this pass

| Change | File | What it does |
|---|---|---|
| `.skill` reader | `lib/skills.js` — `readZipEntries`, `readZipFile`, `readSkillArchive` | parses a ZIP (stored + deflate) in-process, no dependency; a broken archive is an error row |
| manifest | `parseSkillsManifest`, `loadSkillArchives` | reads `{agentSkillsRef, skills[{name,description,tier}]}` beside the archives |
| registry merge | `loadSkills({archives})` | directory roots first, packaged archives last, so an editable copy always wins |
| archive-backed reads | `readSkillContents`, `skillInstructions` | `get`/`resolve` read the body straight out of the ZIP |
| install | `extractSkillArchive` | path-checked extraction to `<root>/<name>`; refuses traversal, multi-root archives and silent overwrite |
| bridge | `api/bridge.js` `skills` ops `archive` / `install` / `manifest` | local-only writes, absolute `.skill` paths only |
| website | `web/src/pages/Claude.jsx` | live registry, `.skill` + tier pills, licence and entry count, "Install .skill…" (desktop only) |
| desktop | `desktop/main.mjs` `acx:skillInstall`, `desktop/preload.mjs` | native file picker → the same extractor → `~/.codex/skills`, replace prompt on a name clash |
| tests | `tests/test-skills.mjs` (65), `tests/test-desktop.mjs` (90) | includes a ZIP built in-test, a traversal archive, and a two-root archive |

### 11.5 What is still not reachable

| Target | Why | Status |
|---|---|---|
| `chatgpt.com`, `claude.ai` over the network | sandbox egress is allowlisted to npm/PyPI/GitHub; both return `000` | **unknown**, not analysed |
| ChatGPT `app.asar` | above the connector's 100 MB inline download cap | **analysed by the relay** — 640 129 388 B, 21 789 files, 21 789 fact rows (§12.5) |
| `codex.exe` (341 312 816 B), `claude.exe` (245 756 240 B) | above the connector's inline cap | **analysed by the relay** — PE headers, imports, capabilities and toolchain in `relay/out/assets.json` (§12.4) |
| Claude `.vite/build` semantic detail for 400+ chunks | REA's result budget: 855 resource-constraint limitations | static facts only |
| Claude's `$BROWSER` shim (`claude-browser-shim.js`, 6 770 B) | read, not yet implemented | backlog: a URL handed to the OS browser should open in an in-app pane |

The honest summary: the *desktop packages* were reverse-engineered from Drive; the *websites*
were not, and were never reachable from this environment.

## 12. Pass 4 — artifact template picker and the sandbox boundary

### 12.1 The picker (Drive: `artifact-picker/server.mjs`, 30 990 B)

A standalone MCP server, `openai_artifact_template_picker` 1.0.0, protocol
`2025-06-18`, two tools: `list_artifact_templates` and `choose_artifact_template`.
It answers "what style should this document use?" with a picture grid and returns the
chosen skill path to the model.

**seen** in the file:

| Fact | Value |
|---|---|
| kinds | `document`/`presentation`/`spreadsheet`, plus `google-docs`/`google-slides`/`google-sheets` as workspace flavours of the same families (`document`, `presentation`, `spreadsheets`) |
| limits | 100 templates, **10 offered**, 1 000-char request, 8 MiB preview, 32 MiB total preview, 16 Mi pixels per preview, 32 Mi pixels total |
| elicitation | prefers `openai/elicitation/create` (`mode: "form"`, `x-openai-input` of type `file`), falls back to legacy `openai/form` with `openai/imagePicker`; `_meta.autoResolutionMs: 30000`; **no form extension → `{status:"unsupported"}`** rather than a degraded grid |
| on-disk shapes | personal `~/.codex/skills/remote-skills/skill-<id>/`, plugins `~/.codex/plugins/cache/<marketplace>/<owner>/<version>/skills/artifact-template-*/`; `CODEX_HOME` honoured |
| metadata | `SKILL.md` frontmatter (`name` must match `artifact-template-[a-z0-9][a-z0-9._-]*`), `artifact-template.json` (`schemaVersion: 1`, `kind`, `reference: assets/reference.<ext>`, optional `sourceUrl`, `preview`), `agents/openai.yaml` (`interface.display_name`, `interface.icon_large`) |
| refusals | realpath containment for every read; `plugin.json` owner must equal a namespaced name; exactly one installed version, else the plugin is skipped; Google templates need the canonical `https://docs.google.com/<path>/d/<id>/edit[?resourcekey=…]` and `/e/` shortcuts are rejected; preview must be a real PNG (magic + `IHDR`) ≤ 8192 px a side; icon must be inside the template and end in `.png` |
| statuses | `selected`, `uploaded`, `unsupported`, `unavailable`, `cancelled`, `declined`; the upload path asks for a display name (≤ 64, trimmed, no `<>`/CR/LF, must contain a letter or digit) |

The part worth copying is not the grid, it is that **every path is re-resolved before
use and a template that fails one check is silently dropped instead of failing the
list** — one bad download cannot take out the picker.

### 12.2 What was built from this pass

| Change | File | What it does |
|---|---|---|
| template validation | `lib/artifacts.js` | kinds/families, `readTrustedText` (realpath + size), `isCanonicalGoogleUrl`, `pngSize`, `parseSkillFrontmatter`, `parseInterface`, `loadTemplate`, `discoverTemplates`, `offer` (10 cards + preview budget), `resolveSelection` (ambiguity refused), `suggestDisplayName`/`validateDisplayName` |
| bridge | `api/bridge.js` `artifacts` — `kinds` / `roots` / `list` / `choose` | local-only reads of the ChatGPT home; unknown kind is a **400 with a code**, not an empty grid |
| chat | `web/src/pages/Chat.jsx`, `web/src/lib/api.js` | ▤ picker in the composer: kind tabs, preview cards, chosen template shown as a removable pill; the pick travels with the turn as `template` |
| prompt | `api/bridge.js` `normalizeChatTemplate` | the template is flattened and capped before it reaches a system prompt — a title cannot smuggle a newline-delimited block or a path |
| tests | `tests/test-artifacts.mjs` (79), `tests/test-desktop.mjs` (+7) | escaping reference/icon, fake PNG, 8193 px preview, plugin owner mismatch, non-canonical Google URL, ambiguous selection, preview budget, and the desktop bridge end-to-end |

### 12.3 The sandbox is a network + token boundary

Both shipped desktop apps enforce the sandbox at a layer lower than approvals:

- `codex-command-runner.exe` (Rust) imports `CreateRestrictedToken`,
  `AdjustTokenPrivileges`, `SetTokenInformation(TokenDefaultDacl | TokenGroups)` and
  speaks `--pipe-i/o` — the child runs as a **reduced token over named pipes**;
  `codex-windows-sandbox-setup.exe` carries `sandbox-secrets` and its own log.
- `cowork-svc.exe` (Go 1.25.14, 42 modules) is a **user-mode network stack**:
  gVisor `tcpip`, `gvisor-tap-vsock`, DHCP, `miekg/dns`, `inetaf/tcpproxy`, go-winio and
  `github.com/anthropics/win-httpproxy`.

**Built:** `lib/egress.js` — an allowlisting HTTP/CONNECT proxy with exact,
`*.suffix` and `*` rules, deny-wins evaluation, a bounded verdict log, live policy
changes and the `HTTP(S)_PROXY`/`NO_PROXY` environment a child needs — plus an
`egress` bridge action and a Codex-page network switch that actually starts it. It is
documented as **a policy, not a kernel**: a process that ignores `HTTP_PROXY` is not
contained, and the UI says so.

### 12.4 Relay status

The evidence runs live in `.github/workflows/relay.yml`; `relay/out/` is the published
record. Runs 2–4 collected the Claude MSIX, the Codex release and the Claude Code
binary; the ChatGPT MSIX (1 GB) failed twice on V8's ~512 MB string limit before the
download became a streamed pipeline (`Readable.fromWeb` → file, sha256 incremental, no
string for anything over 32 MiB) and the PE reader used a 2-byte `readSync`.

### 12.5 The ChatGPT Windows app, finally

The 979 994 720 B MSIX took four relay runs to get through, and every failure was
a different, honest error rather than a lost target:

| Run | Result | Root cause |
|---|---|---|
| 2 | `Cannot create a string longer than 0x1fffffe8` | unconditional `buf.toString('utf8')` on the whole installer |
| 3–5 | same error, no output at all | a crash in the stage killed the process, and `node … \| tee` reported success |
| 6 | `position … Received NaN` | asar entries for files in `app.asar.unpacked/` carry **no offset** |
| 7 | **ok** | streamed download, fd-based asar walk, unpacked files copied in |

Facts from run 7 (`relay/out/assets.json` → `chatgpt-win`):

| Field | Value |
|---|---|
| installer | 979 994 720 B, 3 665 entries |
| `app/resources/app.asar` | 640 129 388 B → **21 789 files**, 647 973 137 B unpacked, 8 unpacked entries, 0 invalid |
| top-level | `.vite/`, `webview/`, `node_modules/`, `native-menu-locales/`, `package.json` |
| file mix | 15 736 `.js`, 2 393 `.svg`, 999 `.json`, 937 `.webp`, 712 `.png`, 375 `.css`, 136 `.ts`, 62 `.md`, 50 `.rpt_desc` |
| text scanned | 336 181 840 B |
| main process | `codex.exe` 354 661 168 B — toolchain **bun + electron + rust**, pdb `codex.pdb` |
| siblings | `codex-windows-sandbox-service.exe` 56 033 584, `codex-computer-use-swift.exe` 56 534 320 (`cua_node/bin/node_modules/@oai/sky/bin/windows/swift/x64/`), `tectonic.exe` 55 059 760 (TeX), `node_repl.exe`, `codex-command-runner.exe` 8 743 216 (rust), `ChatGPT.exe` 4 719 920 (launcher) |
| skill surface | 736 files mention `SKILL.md`; `skills/remote-skills`, `skills/list`, `skills/config`, `skills/plugins`, `skills/editor`, `skills/manage`, `skills/changed` |
| persisted keys | `codex.conversation_snapshot_cache.persisted`, `codex.browser.pendingAccountPinReset`, `oai/apps/closedpromocode` |
| routes | `/api/auth/session`, `/api/auth/csrf`, `/backend-api/…`, `/backend-api/multiplayer/documents/`, `/backend-api/aip/ledger/links` |
| accelerators | `CmdOrCtrl+S`, `Escape`, `CmdOrCtrl+C`/`V`, `ArrowUp/Down/Left/Right`, `Enter` |

The renderer is a chunked webview bundle (no `ipcRenderer.invoke("…")` survived
minification, which is why the `ipc-handler` group is empty — an honest zero, not a
missing file). What *did* survive is the **skill channel names**, which is what the
new `/skills` page is modelled on: list / manage / config / plugins, with the
enable state kept per account rather than per browser.

**Built from this:** `web/src/pages/Skills.jsx` — Installed / Remote / Plugins /
Config, a name+description filter, per-account enable toggles, the roots that were
searched (missing ones dimmed), refused skills, and shadowed duplicates. Its Plugins
tab is the artifact template grid from §12.2, i.e. the same data the picker uses.

### 12.6 The websites, finally (relay run 8, web stage only)

`chatgpt.com` was never a bot wall — its shell carries **one inline 581 620 B
bootstrap script** that names the chunk files, and the earlier regex only looked at
`<script src>`. Saving inline blocks took the site from 1 file / 597 KB to
**26 files / 14.8 MB of text**, and `claude.ai` from 2 files to **42 files / 7.0 MB**.

| Fact | `chatgpt.com` | `claude.ai` |
|---|---|---|
| chunks fetched | 25 (`/cdn/assets/<id>.<hash>.js`, incl. a 1 131 621 B one) | 41 (`assets-proxy.anthropic.com/…/assets/v1/…`) |
| MCP tool names | `mcp__codex_apps__hotline` | `mcp__claude_browser__`, `mcp__computer`, `mcp__cowork__allow_cowork_file_delete`, `mcp__cowork__request_cowork_directory`, `mcp__elicit__present_options`, `mcp__secrets__request_secret`, `mcp__visualize__` |
| skill surface | `skills/list`, `skills/changed`, `skills/config`, `skills/manage`, `skills/plugins`, `skill/read` — the same names as the desktop app | `skills/list-skills`, `skills/list-org-skills` |
| routes | `/v1/environment-configs/{configId}`, `/auth/login?next=/codex/cloud`, `/dots`, `/dots/start` | `/api/chat_snapshots/{id}?rendering_mode=messages&render_all_tools=true`, `/api/published_artifacts/{id}`, `/api/organizations/{uuid}/cowork/remote_devices`, `/api/event_logging/v2/batch` |
| persisted state | `environment-catalog-cache-v2`, `codex.debug.dialogLayout`, `connector_oauth_classic_states` | `spa:locale`, `rq-cache-confirmed-account`, `conversation-store:unsaved:`, `conversation-store:clear-pending`, `claude:stale_entry_clock_suspect` |
| model ids in the bundle | `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.4` | `claude-ai`, `claude-code-desktop`, `claude-dot` |
| hosts | chatgpt.com 90, persistent.oaistatic.com 58, help.openai.com 23 | assets-proxy.anthropic.com 1 452, claude.ai 45, js.hcaptcha.com 20 |

Two conclusions worth keeping:

1. **The `mcp__<server>__<tool>` naming is a shared convention**, not a Claude
   quirk — `lib/mcp.js` already mangles tools to exactly that shape
   (`mcp__${conn.id}__${t.name}`, non-`\w` → `_`, 64 chars), which is why the same
   connection works for both families of model.
2. **The skill channel names are identical on the web and in the desktop app**
   (`skills/list`, `skills/manage`, `skills/config`, `skills/plugins`,
   `skills/changed`), so the `/skills` page built in §12.5 is the right shape for
   both surfaces rather than a desktop-only convenience.

## 13. Pass 5 — streaming, model health, and REA as a surface

Three complaints, three mechanisms, and one rule the three share: **never let the
UI imply something it has not checked.**

### 13.1 “They take sooo long, I don't even know if they will respond”

`api/bridge.js` gained `chat_stream`: the same chat request answered as server-sent
events. `lib/providers.js` gained `chatStream`, which speaks both wires properly
(Anthropic `content_block_delta`, OpenAI `choices[].delta` with tool-call fragments
reassembled by index) and emits, in order:

| Event | When | Why it exists |
|---|---|---|
| `phase: contacting` | before the request | the clock starts before the network, not after |
| `phase: connected` | when headers land | distinguishes “provider slow” from “we are slow” |
| `heartbeat` | every 5 s while waiting | silence with a timer is information; silence alone is not |
| `phase: streaming` + `delta` | first token, then each piece | the answer is readable as it is written |
| `tool` | when a connected MCP tool runs | a tool round is not a hung model |
| `done` | at the end | `first_token_ms`, `chars`, elapsed |
| `error` / `aborted` | on failure / cancel | Stop aborts the upstream request, not just the view |

The packaged app cannot stream from the renderer — it has neither the keychain keys
nor the local token a LAN gateway needs — so `desktop/main.mjs` proxies the stream
(`acx:api:stream`), forwards events on `acx:stream:event` tagged with a stream id,
and `acx:api:stream:abort` really cancels.

### 13.2 “…says there is nothing like this model available”

That sentence is the provider's own `model_not_found`. `lib/model-health.js` records
every real call as `{state, latency_ms, first_token_ms, last_error}` and classifies
failures into `missing | key | quota | network | retry | error` — a 404 alone is not
enough, the text has to be about the model. `modelIndex()` then hides two groups:

* **rejected** — the provider said the id does not exist (12-hour TTL, revived by any
  successful call, forgettable in Settings);
* **unverified** — catalog guesses for a provider whose live `/models` answer we
  already have. Offering a guess next to confirmed ids is how the rejected one got
  picked in the first place.

Nothing is deleted: `hidden` carries both groups with the provider's sentence, and
`include_hidden: true` returns them marked `dead: true`. Because the website and the
desktop app read the same index, one fix covers both.

One shape needed its own rule. NVIDIA NIM answers

```
{"status":404,"title":"Not Found","detail":"Function '<uuid>': Not found for account '…'"}
```

for *every* id when the key is unknown or the account lacks the “Public API
Endpoints” entitlement — a 404 that never mentions a model. Matching on the status
alone said “this endpoint has no model called X”, offered the picker, and recorded the
id as missing, so a model the endpoint itself lists vanished for twelve hours. Both
the sentence and the health record now read the body: a 404 that names an account, a
function or a page is a key problem, and it says so with the Settings link instead of
a swap that would fail identically. CI caught this on a fake key; it is the same
complaint as §13.2 with a different cause.

### 13.3 REA, installed by a human who saw the plan first

`lib/rea.js` parses REA 6.7.0's real `setup --dry-run` output — a YAML header with a
CSV table (`plannedActions[2]{id,kind,label,target,detail,external,operation}:`) —
without a YAML dependency, and refuses to guess: if the table's declared row count
does not match what was parsed, that is a `parse_error`, not “nothing to do”.

`/rea` walks: Node check → **plan** → **apply** → **verify** → **register**. The gate
is a fingerprint of `(id, kind, target, operation)` per action: `apply` re-runs the
plan first and returns **409 with the new plan** if the fingerprint moved, so what is
written is always what was shown. Verify is two independent proofs (the config file
names the server **and** a real MCP handshake lists its tools) rather than a green
tick from the thing that just did the writing.

### 13.4 The run, recorded (2026-10-24, this machine)

Approved through the surface the previous section describes, not by hand:

| step | answer | what proves it |
|---|---|---|
| `plan` | `fc2bc1f2a7c48eff`, 2 actions | `configure_client:codex` (create), `install_skill` |
| `apply` | `ok: true`, `status: ready`, 2.0 s | both actions executed, plan fingerprint unchanged |
| `verify` | `ok: true`, 12.0 s | `registration.present: true` **and** handshake `ok: true` |
| `register` | `ok: true`, 207 tools | connection row `rea` / `stdio:rea` / `connected` |

What is on disk afterwards:

```
~/.codex/config.toml                                  125 B
  [mcp_servers.rea]
  command = "npx"
  args = [ "-y", "rea-agents@6.7.0", "mcp" ]
  startup_timeout_sec = 30
  tool_timeout_sec = 450
~/.agents/skills/reverse-engineer-anything/SKILL.md  23,523 B  (+ references/, 92K total)
```

The handshake reports server `rea 6.7.0`, protocol `2025-06-18`, 207 tools — the
first of them static (`annotate_native_function`, `inspect_native_load_image`,
`resolve_native_call_targets`) and the rest addressed at a live IDA/Ghidra session,
which is why nothing here claims a binary was analysed. Node `v22.22.3` satisfies
the `>= 22.19` gate. Two things this boundary deliberately does *not* do: it does
not install REA's own MCP server on our side (it registers the same command with
Codex), and it does not touch a target binary.

---

## 14. Re-run on a clean machine, and the engines (2026-10-24, second sandbox)

The setup was repeated from scratch on a machine with no `~/.codex`, no `~/.agents`
and no `data/`, using the same three step chain, and every number below comes from
the bridge's own responses.

### 14.1 Apply, verify, register again

| step | answer | what proves it |
|---|---|---|
| `apply` (`npx -y rea-agents@6.7.0 setup --client codex --skill --yes`) | `appliedActions: [configured_codex, installed_skill]`, 2.7 s | `status: ready`, `codex: configured` |
| file on disk | `~/.codex/config.toml`, 125 B | `[mcp_servers.rea]` → `npx -y rea-agents@6.7.0 mcp` |
| skill on disk | `~/.agents/skills/reverse-engineer-anything/` | `SKILL.md` + `references/`, `installed_version: 42` |
| `verify` | `ok: true`, 3.46 s | registration present **and** handshake `rea 6.7.0`, protocol `2025-06-18`, **207 tools** |
| `register` | `ok: true`, 3.47 s, 207 tools | connection row `rea` / `stdio:rea` / `connected` / `local: true` |

A real tool call, not just a tool list: `analyze_javascript_application` on this
repository's own built frontend (`web/dist`, `format: directory`) returned an
`evidence_id`, `analysis_profile`, `raw_result` and `normalized_result` with
`coverage: complete-within-view` (1 of 5 files examined, the rest explicit
unknowns) in 53 s. That evidence is what makes "installed" more than "it answered
a handshake".

### 14.2 Engines are the honest gap

`rea doctor` on this machine: `healthy: false`, `environment_healthy: false`, and
five `missing_analysis_engine` checks — Hopper, Ghidra, IDA, JADX, Kuna. REA's
parsers inspect files without any of them; decompiling a native or Android binary
needs one. REA deliberately does not download them, and this sandbox's egress is
allowlisted to npm/PyPI/GitHub-source, so **no engine binary can be fetched here**
(GitHub release assets 302 to `release-assets.githubusercontent.com`, which is
blocked; the npm wrappers `pi-ghidra` and `jadx-headless-mcp` are thin shims that
download from exactly there, and no PyPI package ships a Ghidra or jadx build).

So the app now says it instead of guessing:

* `rea op:"engines"` runs `npx -y rea-agents@latest doctor` (2.4 s), parses the
  `scope_checks[]` table and returns the failures with the variable that fixes
  each one.
* `web/src/pages/Rea.jsx` renders **Analysis engines** on load: per-engine pill,
  what it is for, what it needs, the exact steps, and the env var, with a copy
  button. On a machine that has one, it says "all configured".
* An unreadable doctor report is an error (`parse_error`), never "nothing missing" —
  a table with a dropped row is reported as `7 check(s) but 6`.

To finish the engine on your own machine (where GitHub is reachable):

```bash
# Ghidra (native binaries)
curl -LO https://github.com/NationalSecurityAgency/ghidra/releases/download/<tag>/ghidra_<tag>_PUBLIC_<date>.zip
unzip ghidra_<tag>_PUBLIC_<date>.zip -d ~/tools
export GHIDRA_INSTALL_DIR=~/tools/ghidra_<tag>_PUBLIC        # Java 21+ required

# JADX (Android)
# download jadx-headless-mcp 0.7.1 from Samael-Z/jadx-headless-mcp releases
export REA_JADX_MCP_JAR=/absolute/path/jadx-headless-mcp-0.7.1.jar
```

Then `rea op:"engines"` again — both should move to `ok: true` and
`environment_healthy` should flip with them.
