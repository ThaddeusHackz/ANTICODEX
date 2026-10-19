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
```

## Features

| Surface | What it does |
|---|---|
| **Chat** | Multi-model conversations (NVIDIA NIM catalog + custom endpoints), vision attachments, Tavily/Exa web search with source chips, thread history, streaming UX |
| **Codex Workspace** | File tree, editor, sandbox terminal, agent thread, diff proposals, approval modes (suggest / auto-edit / auto-run) — modeled on the Codex desktop app architecture found in the forensic sweep |
| **Agent Studio** | Plans, persistent project memory (`ANTICODEX.md`), skills (REA + leanrea installed), live tool log — the Claude-Code/Claude-desktop agent pattern |
| **Images** | Cloudflare Workers AI **Flux** (schnell/dev) |
| **Video** | **MiniMax Hailuo (H3)** text-to-video, unlimited on your key |
| **MCP Connectors** | 18-server catalog (GitHub, Drive, Gmail, Slack, Notion, Linear, Postgres, Playwright, Supabase, Figma, Cloudflare…), OAuth-style authorize page, permission editor, tool playground, custom stdio/HTTP servers |
| **Computer Use** | Desktop pairing codes, screen capture → vision model, mouse/keyboard control, app launch/install (confirm-gated), AI command console |
| **Auth** | Email + password (signs straight in, no mailer required), **GitHub OAuth**, forgot-password with **6-digit email codes** (single-use, 15-min expiry, stored with their expiry), session tokens, optional email-verification gate |
| **Admin** | `Thaddeusadmin` console: users (with password reset), global API keys, system status, activity. Separately, the owner signs in to the **app** with `tthaddeus75@gmail.com` (`role: admin`) — the console login is its own thing |
| **Desktop** | Windows `ANTICODEX.exe`, opens with the `.exe`, account pairing with the website, **auto-update with user accept**, `anticodex://` deep links, computer-use bridge |

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
and were used to drive the forensic sweep documented in [`docs/FORENSIC-REPORT.md`](docs/FORENSIC-REPORT.md).

## License

Apache-2.0 (see `LICENSE`). Architecture study credits `openai/codex` (Apache-2.0) — see `NOTICE`.
All ANTICODEX branding, UI and code are original; no proprietary OpenAI/Anthropic assets are redistributed.
