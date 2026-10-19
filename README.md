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
from env (Vercel), the admin runtime config, or Settings → API keys. Wired
features: **NVIDIA NIM** chat models · **Groq** LLM · **OpenAI** (GPT + Whisper
voice input) · **ElevenLabs** read-aloud · **Cloudflare Flux** image gen ·
**R2** media storage · **MiniMax H3** video · **Tavily** web search ·
**Unsplash** image search · **OpenWeather** + **Windy** weather/maps ·
**OpenSky** live flights · **YouTube** search. Paired desktops receive the
same keychain automatically after sign-in.

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

Set keys in **Settings → Providers** (per-device / desktop keychain) or **Admin → Keys** (global).
The **provider directory** covers 26 endpoints — OpenAI, Anthropic, Google Gemini, xAI, Mistral,
DeepSeek (`deepseek-flash` = V4.1-Flash-1017), Moonshot, Z.ai, Qwen, Doubao, MiniMax, Hunyuan, Meta,
NVIDIA NIM (Nemotron 3/3.5), Cohere, Perplexity, Thinking Machines, Atria ASI, OpenRouter, Groq,
Together, Fireworks, Cerebras, Azure OpenAI, Vertex AI, Bedrock — plus custom OpenAI-/Anthropic-compatible
gateways. Resolution order: desktop keychain → env vars → admin runtime config → hardcoded slots in `lib/keys.js`.

| Provider | Used for | Where |
|---|---|---|
| `NVIDIA_API_KEY` | Primary AI engine (Nemotron 3.5 + 100 hosted models, vision included) | Settings → Providers |
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
