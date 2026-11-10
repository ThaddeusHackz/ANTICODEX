# ANTICODEX

<img src="web/public/anticodex-logo.png" alt="ANTICODEX logo" width="88" align="right" />

**The universal AI workspace.** Chat-class interface, Codex-class code agents, Claude-class agent studio,
MCP connectors, Flux image + Hailuo video generation, computer-use — powered by *your* model keys
(**26 provider endpoints**: NVIDIA NIM first, DeepSeek/OpenAI/Anthropic/Gemini/Grok/Kimi/Qwen… + any OpenAI-/Anthropic-compatible gateway).

```
┌──────────┐   ┌──────────────────────────────────────────────┐
│ Sidebar  │   │  Chat · Codex Workspace · Agent Studio        │
│ Threads  │   │  Images (Flux) · Video (Hailuo) · MCP         │
│ Nav      │   │  Computer Use · Settings · Admin              │
└──────────┘   └──────────────────────────────────────────────┘
     web/  →  React + Vite SPA  ⇄  api/bridge.js (Node)  ⇄  Supabase
     desktop/ → Electron .exe (auto-update, computer-use, pairing)
```

## Quick start

```bash
# 1. web + api (local)
cd web && npm install && npm run build && cd ..
npm start                 # http://localhost:8787

# 2. tests
npm test                  # API integration + bundle checks

# 3. Windows desktop app
cd desktop && npm install && npm run package:win
# → release/ANTICODEX-win32-x64/ANTICODEX.exe

# 4. macOS desktop app (any host builds an unsigned .app; sign on macOS)
node desktop/package-mac.mjs --arch arm64 --release
# → desktop/release/ANTICODEX-darwin-arm64/ANTICODEX.app (+ .zip / .dmg on macOS)

# 5. iPhone / iPad
node scripts/build-ios.mjs            # PWA assets + web/ios Capacitor project
# → dist/ios/install.html  ·  web/ios/  (open on a Mac with Xcode to sign an .ipa)

# 6. the skill atlas (2,208 skills) and the Codex sweep
node scripts/build-skill-atlas.mjs    # → web/public/skills-atlas/
node scripts/rea-codex-sweep.mjs      # → lib/codex-repos.js (evidence for /parity)
```

## Features

| Surface | What it does |
|---|---|
| **Chat** | Multi-model conversations (NVIDIA NIM catalog + custom endpoints), vision attachments, Tavily/Exa web search with source chips, thread history. Answers **stream over server-sent events**: a phase (contacting → connected → streaming), a heartbeat every few seconds while the model is quiet, a running clock, first-token latency, and a Stop button that aborts the real request. Any answer that takes longer than 12 s says so instead of spinning. **Reasoning is streamed too** (`reasoning_content`, OpenRouter `reasoning`, Claude `thinking_delta`) into a “Thought for 1.2 s” block you can open, and kept with the message. |
| **Speed dial** | Fast / Balanced / Max in the topbar (and on the Sandbox page) sets how much deliberation an answer is worth: 512 tokens · no reasoning, 1200 · low, or 4096 · high. The preset also drives `reasoning_effort` (only for wires that take it — a provider that refuses is retried once without it and remembered) and Claude's thinking budget. Explicit `max_tokens`/`temperature` still win. |
| **Sandbox** | `/sandbox` runs the code — JavaScript, Python or shell — in a fresh directory with a scrubbed environment, a hard timeout (≤15 s), capped output and the files it wrote. “Write with Max” asks the model for a snippet and drops it in the editor; ▶ Run shows what it *actually* printed. Local-only by design: the desktop app (or a server you run) executes it, a remote visitor is told why not. |
| **Codex Workspace** | File tree, editor, sandbox terminal, agent thread, diff proposals, approval modes (suggest / auto-edit / auto-run) — modeled on the Codex desktop app architecture found in the forensic sweep |
| **Model health** | Every model the app has actually called is recorded (`data/model-health.json`): latency, first-token time, and the verdict. A provider that answers *“there is nothing like this model”* gets that id **hidden from the picker** — on the website and in the desktop app — until a call succeeds, 12 hours pass, or you forget the verdict. Settings → Model health lists what is hidden, why, and can test any id in eight tokens. |
| **Qoder** | All 49 QoderAI repositories surveyed (`/qoder`); the seven with a machine-readable contract are implemented here — Cloud Agents (Forward/Managed) from the SDK repos, the ACP client that drives `qodercli --acp`, and the GitHub Action generator. The CLI is also pickable in **Chat** as a local agent, streaming its reasoning through the same SSE frames as a model. |
| **REA** | Reverse Engineer Anything as a first-class surface (`/rea`): Node 22.19 check → **REA's own plan, shown before anything runs** (`npx rea-agents setup --dry-run`) → apply (the plan is fingerprinted; a plan that changed is refused) → verify (config file **and** a real MCP handshake listing its tools) → register it as the `rea` MCP server so chat and Codex can call all 207 tools. |
| **Agent Studio** | Plans, persistent project memory (`ANTICODEX.md`), skills (REA + leanrea installed), live tool log — the Claude-Code/Claude-desktop agent pattern |
| **Images** | Cloudflare Workers AI **Flux** (schnell/dev) |
| **Video** | **MiniMax Hailuo (H3)** text-to-video, unlimited on your key |
| **MCP Connectors** | 21-server catalog (GitHub, Drive, Gmail, Slack, Notion, Linear, Postgres, Playwright, Supabase, Figma, Cloudflare… **plus REA**), OAuth-style authorize page, permission editor, tool playground, custom HTTP/SSE servers, and a **real stdio transport** so a local server runs as a supervised child process |
| **Computer Use** | Desktop pairing codes, screen capture → vision model, mouse/keyboard control, app launch/install (confirm-gated), AI command console |
| **Auth** | Email + password (signs straight in, no mailer required), **GitHub OAuth**, forgot-password with **6-digit email codes** (single-use, 15-min expiry, stored with their expiry), session tokens, optional email-verification gate |
| **Admin** | `Thaddeusadmin` console: users (with password reset), global API keys, system status, activity. Separately, the owner signs in to the **app** with `tthaddeus75@gmail.com` (`role: admin`) — the console login is its own thing |
| **Bring your setup** | Reads a Codex `~/.codex/config.toml` and a Claude `.claude/settings.json` + `policy-limits.json` → shows a diff-style plan → connects the MCP servers, applies the feature policy, and returns model providers / aliases / migrations for this device. Nothing is written before you approve it; a token in the env block is detected but never echoed back |
| **Desktop** | Windows `ANTICODEX.exe`, opens with the `.exe`, account pairing with the website, **auto-update with user accept**, `anticodex://` deep links, computer-use bridge |
| **Skills (2,208)** | `/skills` — a pinned corpus of agent skills from seven permissively licensed sources, **retrievable by meaning** (hybrid BM25 + name/tag boosts, deterministic), **grounded into every chat turn** with hard budgets, and installable into `~/.qoder/skills`, `~/.codex/skills` or `~/.claude/skills` in one click. Skills already on your machine — Qoder's included — join the same retrieval corpus. A 19-rule safety scanner with line numbers and fixes ships on the same page. `node scripts/build-skill-atlas.mjs` is the only way the corpus changes. |
| **Daytona** | `/sandbox` runs on **this machine or on a Daytona box over SSH** (`ssh.app.daytona.io:22`), with REST sandbox create/list when a `DAYTONA_API_KEY` exists. Every result carries the machine that ran it (`local` / `daytona:<user>`), the exit code and the wall clock. SSH keys come from `~/.ssh` or are generated at `~/.qoder/ssh/`; host keys are pinned on first use. |
| **Codex parity** | `/parity` pairs **every surface this app ships with the upstream crates that implement the same job**, read live from `openai/codex` (121 crates, 80.8 MB of Rust, pinned by commit), and resolves each claim against the filesystem — delete an implementation and the row says `missing`. The differences are in the same table, not in a footnote. |
| **Evidence** | `/evidence` — the reverse-engineering record, split into `[seen]` (read from an artifact) and `[inferred]` (hypothesis + its basis), with the three commands that regenerate every number on it. |
| **Library** | `/library` — every artifact the workspace produced: images, video, code, exported skills. Records are written by the generators themselves, so the page is never a mock grid. |
| **Agent Studio** | `/studio` — plans, project memory (`ANTICODEX.md`), a **searchable skill picker over all 2,208** (pin one, or let retrieval choose per message), and a live tool log. |
| **Install** | `/install` — macOS `.app`/`.dmg`, the iOS home-screen app (two taps, no App Store), and the Xcode path to a signed `.ipa`, each with the command that actually produces it and what is missing when it cannot. |

## Service keychain (integrated 2026-10-19)

All service keys live in the same keychain as the provider keys — resolved
from env (Vercel), the admin runtime config, or your own saved key in
Settings (per account). Paired desktops mirror those keys into the local
keychain, which is what every provider call resolves first. Wired
features: **NVIDIA NIM** chat models · **Groq** LLM · **OpenAI** (GPT + Whisper
voice input) · **ElevenLabs** read-aloud · **Cloudflare Flux** image gen ·
**R2** media storage · **MiniMax H3** video · **Tavily** web search ·
**Unsplash** image search · **OpenWeather** + **Windy** weather/maps ·
**OpenSky** live flights · **YouTube** search.

## Sign-in (a plain email address just works)

Sign-up writes the account to the ANTICODEX ledger (`public.users`, or
`data/db.json` on the desktop/offline), salts+hashes the password with scrypt,
and returns a live session — so a normal `@gmail.com` address gets in even when
the project has no SMTP, is rate limited, or Supabase is unreachable.
Supabase Auth is mirrored **best-effort** through its *public* endpoints
(`POST /signup`, `POST /recover`, `POST /verify`), which need only the anon key;
`/admin/*` calls (used to sync a changed password) are authenticated with
`Authorization: Bearer <service key>` — putting the key only in `apikey` is what
used to fail sign-up with *“This endpoint requires a Bearer token”*.

Verification codes are always stored **with an expiry** (`reset_codes.expires_at`)
so a code can never be silently dropped, and provider error bodies are
translated before they reach the browser.

Want verification to be mandatory? Set `REQUIRE_EMAIL_VERIFICATION=true`; the
sign-up screen then asks for the emailed 6-digit code (or the emailed link)
before the account opens. To also show a **numeric code** inside the emails,
edit Supabase Dashboard → Authentication → Email Templates and add

```html
<p>Your code: <strong>{{ .Token }}</strong></p>
```

to both *Confirm signup* and *Reset password* — the app accepts either the code
or the link either way. When no mailer exists (desktop, offline, preview), the
code is printed on screen instead; `EXPOSE_RESET_CODES=false` forces that off in
production.

### The Codex workspace (and why it used to go blank after sign-in)

The signed-in shell had a latent crash: the sidebar called `loadThreads().then(...)`
on a **synchronous** helper, so the effect threw `loadThreads(...).then is not a
function` and React tore down the entire signed-in tree — a blank page that looked
like "the workspace is broken". `web/src/lib/state.jsx` now keeps those helpers
sync (documented, so the next caller does not "fix" it by adding `.then`), the rail
loads threads from the **account** (`/api/threads`) with the local copy painted
first and merged by id, and `Chat.jsx` writes locally *and* notifies the rail
(`acx:threads`) so a new chat appears immediately — offline included.

The workspace page itself (`/codex`) also had no layout: `.workspace` was
`height: 100%` inside a flex column (100vh, so the bottom of every pane was clipped
by the topbar), and `.file-tree`, `.file-item`, `.editor-pane textarea`,
`.messages`, `.msg-body`, `.prompt`, `.nav-section`, the admin `.auth-card` and
`ui.jsx`'s `.switch` had **no rules at all** — unstyled buttons in a collapsed
column. They are styled now, panes flex to fit, and below 1000px (the desktop
window's minimum width) they stack.

Chats and workspace files are stored **per account** (`acx_threads:<userId>`,
`acx_fs:<userId>`, with a one-time move of the old unkeyed data), because
localStorage belongs to the machine and one desktop install can be paired to
several sign-ins.

`tests/test-web-mount.mjs` mounts the real app in jsdom against the real bridge and
asserts the signed-in shell and the workspace stay on screen — it fails loudly on
exactly the class of bug above. `desktop/package-win.mjs` now always rebuilds
`web/dist` (a stale bundle was how a UI fix could never reach the .exe);
pass `--skip-build` to reuse it deliberately.

### Owner account

`OWNER_EMAIL` / `OWNER_PASSWORD` / `OWNER_NAME` (defaults
`tthaddeus75@gmail.com` / `Thaddeusk12` / `Thaddeus`) are the *second* admin:
they sign in to the website and the desktop app like anyone else, but the row
carries `role: admin`. They are materialised on demand, so a wiped database
never locks the owner out. The **admin console** (`/admin`) keeps its own
`ADMIN_USERNAME` / `ADMIN_PASSWORD` pair — unchanged.

## GitHub sign-in (2-minute setup)

Users click **Continue with GitHub** — no tokens or passwords for them. You only
need one free GitHub **OAuth App** (its Client ID + Secret are the app's
credentials, not a personal access token):

1. Open <https://github.com/settings/developers> → **New OAuth App**.
2. Fill in: **Application name** `ANTICODEX`, **Homepage** `https://anticodex.vercel.app`,
   **Authorization callback URL** `https://anticodex.vercel.app/auth/callback` → **Register application**.
3. Copy the **Client ID**. Click **Generate a new client secret** and copy it.
4. In ANTICODEX → **Admin → Keys** (or the website Admin page) set
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, then **Save**.
5. Done — "Continue with GitHub" now signs users in and creates their account.
   For localhost dev, register a second OAuth app with callback
   `http://localhost:8787/auth/callback` and set the keys in your dev instance.

**Desktop app:** the "Continue with GitHub" button opens the website in the
system browser with a 6-digit pairing code; after signing in (GitHub or email)
the account links to the desktop app automatically.

## API keys

Set keys in **Settings → Providers** — they are stored against *your account* (plus the desktop
keychain on the packaged app), so your key replaces the built-in default for you alone and nobody
else's traffic. **Admin → Keys** is the global/server-wide override.
The **provider directory** covers 26 endpoints — OpenAI, Anthropic, Google Gemini, xAI, Mistral,
DeepSeek (`deepseek-flash` = V4.1-Flash-1017), Moonshot, Z.ai, Qwen, Doubao, MiniMax, Hunyuan, Meta,
NVIDIA NIM (Nemotron 3/3.5), Cohere, Perplexity, Thinking Machines, Atria ASI, OpenRouter, Groq,
Together, Fireworks, Cerebras, Azure OpenAI, Vertex AI, Bedrock — plus custom OpenAI-/Anthropic-compatible
gateways. Resolution order: desktop keychain → this request's account keys → env vars → admin runtime
config → hardcoded slots in `lib/keys.js`. Unknown-but-real env names are rejected, and a read-only
filesystem (Vercel) is reported honestly instead of a fake "saved".

### Bring your own model (the picker)

The model menu in the top bar — and in the Codex agent pane — is a searchable index of **every model of
every provider** (249 curated ids, 700+ with OpenRouter's feed), grouped by provider with vision /
reasoning / tool badges. Per provider you can hit **Sync models** to pull that endpoint's live `/models`
list, and **Any model id** takes whatever you type, so a model released after this build still routes.

| Action | What it does |
|---|---|
| `models` → `picker` | `{providers:[{id,name,configured,key_env,models:[{id,label,vision,reasoning,tools}]}]}` resolved with *your* keys |
| `sync_models` | Live `/models` from the provider (10-min cache per provider+key), merged with curated labels. A key is not required for a gateway on the calling machine — Ollama and LM Studio have none |
| `save_provider_key` | Global slot write — **admin only**, allowlisted env names, `persisted:false` when the disk is read-only |
| `test_endpoint` | Reachability + wire-format probe — requires a signed-in session **or** this machine's own desktop instance (it is an SSR-shaped relay), and will not open a connection to a private/LAN address for a browser |
| `provider_defs` | Gateways a *device* knows about (Ollama, LM Studio, a LAN vLLM box), sent with the request: endpoint + wire type + `key_env` only. A key inside the payload is ignored; the value resolves from the account or the local keychain |
| `chat` | `provider` + `model`; a `provider::default` ref is resolved to a real id before it is sent, and provider failures come back as `{ok:false, error, fix, verdict, settings_link}` so the UI can show the fix instead of an empty bubble |

### Proof, not promises

A key that is stored is not a key that works, and a catalog that lists a model is not
an endpoint that serves it. So:

* **Saving a key probes it.** The provider card calls `/models` (and a 4-token test
  completion) right after storing and reports one of four things: *key works — N
  models listed and "x" answered*, *rejected this key*, *no model listed here — press
  Sync*, or *this server could not reach the provider (network limit, not your key)*.
  A gateway that answers **HTTP 200 with an error body** counts as a failure — that
  specific trap is how a dead key kept looking "configured".
* **Live ids outrank guesses.** After a Test or Sync, the endpoint's own `/models`
  list becomes the source of truth for that provider: those ids are marked `live` (✓ in
  the picker), catalog-only ids are flagged `unverified` (?) but stay selectable, and
  the provider row says *"ids confirmed by the endpoint"* vs *"ids from the built-in
  catalog"*.
* **A wrong model id is recovered, not reported.** If the provider says it has no
  model called X, ANTICODEX pulls (or reuses) that endpoint's live list, retries once
  with the closest real id, and says so — `note`, `retried_with`, `asked_for`. When
  there is nothing better to try, the reply carries `fallback` ids as one-click buttons
  in the chat.
* **The desktop app is held to the same rules.** It runs this same bridge
  in-process (`desktop/main.mjs` imports `api/bridge.js`), so verify-on-save, live
  ids and the retry are not web-only. What the .exe adds: keys are encrypted with
  the OS keyring when there is one, gateways on your own network are allowed, and
  everything above still works with no website reachable. `node
  tests/test-desktop.mjs` pins all of it.

```
chat(provider, "default") → nvidia has no model "nvidia/nemotron-3.5-super-vl-120b-a12b"
                          → sync /models → retry "deepseek-ai/deepseek-r1" → answer
                          → note: '… answered with "deepseek-ai/deepseek-r1" from its live list instead.'
```

| Provider | Used for | Where |
|---|---|---|
| `NVIDIA_API_KEY` | Primary AI engine (Nemotron 3.5 + 100 hosted models, vision included) | Settings → Providers → NVIDIA NIM |
| `DEEPSEEK_API_KEY` + 24 more | All directory providers (`lib/catalog.js`) | Settings → Providers |
| `TAVILY_API_KEY` / `EXA_API_KEY` | Web search (owner-approved to hardcode in `lib/keys.js`) | Admin → Keys |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` | Flux image generation (Workers AI) | Settings → Media |
| `MINIMAX_API_KEY` | Hailuo H3 video | Settings → Media |
| `GITHUB_CLIENT_ID/SECRET` | GitHub login | Admin → Keys |

> Everything works keyless in **demo mode** (simulated generations + Demo Core model) so the product is fully explorable before keys exist.

## Supabase

Project `anticodex` (`xmbkmdqaczlxkdarayyy`). Schema: [`supabase/schema.sql`](supabase/schema.sql)
(users, threads, reset_codes, mcp_connections, generations, sessions, audit, outbox, api_keys + RLS).
Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the server env to use Postgres persistence
(JSON file store in `data/` is the automatic fallback, and an in-memory store is
used when the disk is read-only — Vercel, packaged `.exe`). PostgREST auth handles
both legacy JWT keys (`apikey` + `Authorization: Bearer`) and the new
`sb_publishable_…` / `sb_secret_…` keys (`apikey` only).

Migrations live in `supabase/schema.sql` and are applied to the project; the
account tables must exist for sign-in to survive across serverless invocations.

## Desktop parity

The .exe is a second product, and a fix that only lands in the web path is a fix it never got. So the
packaged app is checked, not assumed:

| Concern | How it works now |
|---|---|
| Same AI rules | `startLocalServer()` imports the repo's `api/bridge.js`, so live model ids, verdicts and the `model_not_found` retry run locally; `acx:api` injects the machine's keys into **every** action |
| Keys at rest | `desktop/keychain.mjs` → Electron `safeStorage` (Windows DPAPI / macOS Keychain / libsecret). No OS keyring? The file stays plaintext **and the app says so** (Settings → Desktop shows `plaintext`, not a lock icon). An older plaintext state file is read, then cleared |
| Offline verification | The main process mints a per-install secret (`ANTICODEX_LOCAL_TOKEN`, memory only) and sends it with requests to its own loopback server, so testing a key and syncing models work signed-out and unreachable-from-the-site. A deployment that never sets that env var keeps every gate; a proxied request cannot claim to be the machine (any `x-forwarded-for` fails closed) |
| Your own gateway | Ollama / LM Studio / a LAN vLLM box are kept by the app and sent as `provider_defs`. A public server refuses to dial private addresses on a browser's behalf — it answers *"that address is private; the desktop app can"* instead of pretending, and it will never swap in Demo Core for a gateway it dropped |
| Speed, thinking, sandbox | The renderer is the same bundle and the same `api/bridge.js` runs in-process, so the speed dial, the reasoning panel and `/sandbox` work in the `.exe` without a second implementation. The sandbox is gated on loopback, which is exactly what the packaged app's server is. |
| Shipping the fix | `desktop/package.json` **version** is the single source: `main.mjs`, the preload, `package-win.mjs` (`--app-version`, zip name) and `lib/keys.js` (`CATALOG.version`) all read it. The updater only offers an update when a GitHub Release tag is *higher*, so a fix reaches installed apps only via `git tag v<new>` + `git push --tags`; the workflow fails the release if the tag and `desktop/package.json` disagree, which is how an "update available" with no installable asset happens |
| The bundle it ships | `package-win.mjs` rebuilds `web/dist` by default and passes `api/` + `lib/` as `--extra-resource`, so the .exe carries the current renderer and the current provider layer |

Build it: `node desktop/package-win.mjs` (add `--skip-build` to reuse `web/dist`). Verify it: `node tests/test-desktop.mjs`
— 74 assertions over the sources, the keychain, the local trust gate and a live mock gateway.

## Desktop auto-update

`desktop/updater.mjs` polls `github.com/ThaddeusHackz/ANTICODEX/releases/latest`. When a newer version is
published, the app notifies the user; only after **Accept** is the asset downloaded and the installer launched.
Publishing a `v*` tag triggers `.github/workflows/release.yml` (Windows runner builds the app and attaches it
to the GitHub Release).

## REA / leanrea

The REA skill pack (morluto/rea) and leanrea (aicodeking/leanrea) are installed under [`skills/`](skills/)
and were used to drive the forensic sweeps documented in [`docs/FORENSIC-REPORT.md`](docs/FORENSIC-REPORT.md)
and [`docs/REA-EVIDENCE.md`](docs/REA-EVIDENCE.md).

### Analysis engines (what REA cannot decompile without)

REA will not install a decompiler for you — each is a large third-party binary with its own
licence — so the app reports the gap instead of hiding it: `rea op:"engines"` runs
`rea doctor`, parses `scope_checks[]`, and the REA page lists every missing engine with the exact
variable and steps that fix it, plus the ones doctor never mentions (Wakaru, which REA only reports
the first time `recover_javascript_sources` runs). Ghidra needs `GHIDRA_INSTALL_DIR` and Java 21+,
JADX needs `REA_JADX_MCP_JAR`, and so on — see [`docs/REA-ENGINES.md`](docs/REA-ENGINES.md), which
also records exactly which of them can and cannot be installed in a sandbox with no release-asset
egress, and why nothing was faked to turn the check green.

### REA as a connector (local stdio MCP)

REA ships as an MCP server (`npx -y rea-agents mcp`) with **207 tools / 6 prompts**. Until now the
bridge could only speak HTTP/SSE, so a local server could be *listed* but never *connected* — `Connect`
POSTed to the literal string `stdio:rea`. `lib/mcp-stdio.js` adds the missing transport:

* spawn → `initialize` → `tools/list` → `tools/call` → reap, over newline-delimited JSON **or**
  LSP-style `Content-Length` frames (older servers still ship that);
* the child is killed as a **process group** (`npx` + the node it launches), so a leaked server can
  never keep a Node host alive;
* commands come from a **server-side registry**, never from a request — a browser can ask for `rea`,
  it cannot ask for `rm -rf`. Imported `[mcp_servers.*]` commands (see *Bring your setup*) are only
  run for a **loopback caller on a process-capable host**, and only while the `allow_local_mcp` policy
  flag is on.

```bash
npx -y rea-agents@latest mcp doctor --json     # healthy, 207/207 tools
REA_E2E=1 node tests/test-mcp-stdio.mjs        # 31 assertions incl. the real server
```

A hosted (Vercel) deployment answers honestly instead of pretending: *"this MCP server runs on your
machine, so it needs the desktop app or a local `npm start`"*.

### Codex parity: AGENTS.md, sandbox and approval

`openai/codex` is Apache-2.0 (verified via the GitHub API before cloning), so its
**contract** is reused rather than guessed at — not its code:

* **AGENTS.md** — `~/.codex/AGENTS.md` first, then one document per directory from
  the project root down to the cwd, then nested documents as the agent touches
  subdirectories; merged under `project_doc_max_bytes` (32 KiB) and wrapped in the
  exact `# AGENTS.md instructions for <project>` / `<INSTRUCTIONS>` block Codex
  sends. The workspace page shows which files were loaded and what the model gets.
* **Sandbox** — `read-only`, `workspace-write`, `external-sandbox`,
  `danger-full-access`, with writable roots and `network_access`. An unrecognised
  mode coerces to `workspace-write` and says so; it never silently escalates.
* **Approval** — `untrusted`, `on-request` (the old `on-failure` spelling is
  accepted), `granular` with the same five categories, and `never`. One matrix
  answers `auto` / `prompt` / `deny` for each of read, write, exec and network.
* **Export** — the same `config.toml` shape can be written back out, so adopting
  ANTICODEX is not a one-way door.

`node tests/test-workspace.mjs` pins 59 of those behaviours.

### Bring your setup

`lib/configimport.js` parses the config schemas recovered from the two shipped desktop apps — the whole
`[model_providers.*]`, `[mcp_servers.*]`, `[marketplaces.*]`, `[plugins."name@marketplace"]`,
`[windows] sandbox`, `[desktop] followUpQueueMode`, `[notice.model_migrations]` surface, plus the
`.claude` `env` block and `policy-limits.json` restrictions. Settings → **Bring your setup** shows the
plan before anything is written; `node tests/test-import-config.mjs` pins it (53 assertions).

`lib/policy.js` is the same idea for gates: every capability is a named flag with an explicit default,
and `Settings → Policy` writes it per account (`public.policy`).

See [`docs/REA-EVIDENCE.md`](docs/REA-EVIDENCE.md) for the evidence behind each of those, marked
**seen** / **inferred** / **unknown**, and for the two things this sandbox could not do (live
`chatgpt.com` / `claude.ai`, and the 582 MB ASAR that exceeds the transfer cap).

## License

Apache-2.0 (see `LICENSE`). Architecture study credits `openai/codex` (Apache-2.0) — see `NOTICE`.
All ANTICODEX branding, UI and code are original; no proprietary OpenAI/Anthropic assets are redistributed.

## The interface (2026-11)

The UI pass is documented rather than described: `docs/UI.md` lists what made it
look generated (gradient text, glow shadows, a private palette per page), what was
actually broken (three undefined CSS tokens, no focus ring, `var()` written inside a
JSX object where it is a syntax error), and the twelve checks in `tests/test-web.mjs`
that now fail when any of it comes back. `docs/MCP-CATALOGUE.md` covers the MCP
additions — Figma, shadcn, Playwright, Chrome DevTools, Neon, Prisma, Firecrawl,
sequential-thinking — plus six endpoints that were simply wrong.

## The agent, and the machine it runs on (2026-11)

ANTICODEX now has a coding agent with hands, built to the shape
[sst/opencode](https://github.com/sst/opencode) uses: three agents (Build, Plan,
Explore), a permission set of `allow` / `ask` / `deny` with glob patterns instead of
a boolean per tool, a stepped loop that forces a text answer at its cap, and tools
that are thin — read, write, edit, patch, bash, grep, glob, list, skill, todos.

What it adds is the part opencode does not have: **the machine is chosen**. Every
tool runs on this host or inside the Daytona sandbox over SSH, and every result says
which one. Plan mode is read-only by construction — the write tools are never
offered to the model, so they cannot be talked into being used.

| | |
| --- | --- |
| Page | `/agent` — Build/Plan/Explore, a visible part per tool call, diffs, a task list, a permissions panel |
| Bridge | `action: "agent"` → `op: status \| tools \| run \| stream` (SSE) |
| Docs | `docs/AGENT.md` |

The Daytona connection is a saved token with a **1,440-minute countdown** and a
rotation log (`~/.qoder/daytona.json`, mode 600, never a key). **Install / repair
the sandbox** provisions the box in nine idempotent steps — git, ripgrep, Node,
Python, qodercli, skillui, vibesec, the agent workspace — and reports each one by
reading its output. Details: `docs/DAYTONA.md`.

### Glasser is gone

The paid broker is replaced by a catalogue of **2,335 free APIs** from
[public-apis](https://github.com/public-apis/public-apis) (MIT), pinned by commit,
searchable by the agent and callable with one GET. 1,136 need no key. The tool
refuses loopback, private ranges, the cloud metadata address, non-GET methods and
any API whose key it does not have — and says what to do instead. Page: `/apis`.
Docs: `docs/PUBLIC-APIS.md`.

```bash
npm run apis                 # rebuild the catalogue from the pinned copy
npm run test:agent           # 106 assertions: the loop, permissions, diffs, refusals
```

## The workspace shell (2026-11)

The rail, the pages and the phone build were rebuilt around one rule: **a number on
screen is read, never written.** The empty-state tiles, the parity tally and the
skill count all come from a bridge call, so a missing runtime or an unbuilt atlas
shows up as a different number instead of a broken promise.

```
rail (264px, collapses to 64px of glyphs)
├── ＋ New chat · ⌕ Search chats · ▤ Library
├── ⌗ Chat · ⌘ Codex · ✳ Agent Studio
├── Workspace   ⌥ Sandbox · ▦ Images · ▶ Video · ▤ Library · ⇄ Connectors · ▣ Computer Use
├── Intelligence ✦ Skills · ⟲ REA · ◈ Qoder · ◎ Codex parity · ⌸ Evidence · ⇪ Bring your setup · ⤓ Install
└── account
```

- **⌘K / Ctrl-K** opens a command palette that searches the 19 destinations *and*
  the skill atlas — "find the skill that does X" is the action people reach for most.
- **Chat search** is real: titles first, then message bodies, local copy merged with
  the account copy, with a snippet of the match.
- **The rail is not a desktop-only idea.** Below 900px it becomes a drawer with a
  tap-to-close scrim, closes itself on navigation, and the composer respects the
  home-bar inset; inputs are 16px so iOS does not zoom on focus.
- **Skills travel with the turn.** `use_skills`, `skills:[…]` and `skills_mode` go
  out with every chat request; the bridge resolves them before the model is called,
  emits a `skills` frame, and the answer keeps its trail (`m.skills`), so a good
  reply can be traced back to the instructions that shaped it.
- **Light theme** is a variable swap (`[data-theme="light"]`), and `prefers-reduced-motion`
  turns animation off rather than down.

## Qoder, Daytona and the installed machine

Everything that touches *this* machine is loopback-only: reading `~/.qoder/skills`,
exporting a skill, running a command over SSH, creating a key. A hosted deployment
answers `needs_local` and says why, rather than quietly reading the server's disk.

| Bridge action | What it does |
| --- | --- |
| `skillkit op:"stats" / "list" / "get"` | The pinned atlas: counts, filtered pages, one skill's full text |
| `skillkit op:"resolve"` | Hybrid retrieval — scores, tiers and *why* each skill matched |
| `skillkit op:"ground"` | The exact prompt block, budgets applied, excerpt pointers included |
| `skillkit op:"installed"` | `~/.qoder`, `~/.codex`, `~/.claude`: accepted skills, refusals with reasons, duplicates |
| `skillkit op:"export"` | Write a skill into one of those roots with normalised frontmatter |
| `skillkit op:"scan"` | 19-rule static security scan: severity, line, fix |
| `daytona op:"status" / "key" / "probe" / "exec" / "list" / "read" / "write"` | The remote box over SSH; `api` adds REST create/list when a key exists |
| `codex_map op:"map" / "crate"` | The parity table, resolved against the filesystem |
| `qoder_fieldkit` | The nav spec and the Qoder surface guide (status + limit per row) |
| `library op:"list" / "summary" / "record"` | Artifacts the workspace produced |

The `/sandbox` target switch is the practical bit: pick **This machine** or
**Daytona**, run, and read the `target` field in the result. `execAnywhere()` is the
same choice for code — an agent that wrote a file to the wrong machine is worse than
one that says it could not.

**Egress note.** This build was produced in a sandbox that blocks `ssh.app.daytona.io`
and `raw.githubusercontent.com`, so the Daytona paths are exercised against a local
subshell and the SSH argument builder, not the live host (`tests/test-atlas.mjs`).
From your machine (desktop app or `npm start`) port 22 is all it needs.
