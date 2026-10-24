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
| ChatGPT `app.asar` (582 072 504 B) | above the connector's 100 MB inline download cap | **not analysed** |
| `codex.exe` (341 312 816 B), `claude.exe` (245 756 240 B) | same cap; and no disassembler engine is installed | **not analysed** |
| Claude `.vite/build` semantic detail for 400+ chunks | REA's result budget: 855 resource-constraint limitations | static facts only |
| Claude's `$BROWSER` shim (`claude-browser-shim.js`, 6 770 B) | read, not yet implemented | backlog: a URL handed to the OS browser should open in an in-app pane |

The honest summary: the *desktop packages* were reverse-engineered from Drive; the *websites*
were not, and were never reachable from this environment.
