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
| **Auth** | Email + password, **GitHub OAuth**, forgot-password with **6-digit email codes** (single-use, 15-min expiry) |
| **Admin** | `Thaddeusadmin` console: users, global API keys, system status, activity |
| **Desktop** | Windows `ANTICODEX.exe`, opens with the `.exe`, account pairing with the website, **auto-update with user accept**, `anticodex://` deep links, computer-use bridge |

## API keys

Set keys in **Admin → Keys** (global) or **Settings** (per-device). Resolution order:
env vars → admin runtime config (`data/config.json`) → hardcoded slots in `lib/keys.js`.

| Provider | Used for | Where |
|---|---|---|
| `NVIDIA_API_KEY` | Primary AI engine (all NVIDIA NIM models, vision included) | Settings → Providers |
| `TAVILY_API_KEY` / `EXA_API_KEY` | Web search (owner-approved to hardcode in `lib/keys.js`) | Admin → Keys |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` | Flux image generation (Workers AI) | Settings → Media |
| `MINIMAX_API_KEY` | Hailuo H3 video | Settings → Media |
| `GITHUB_CLIENT_ID/SECRET` | GitHub login | Admin → Keys |

> Everything works keyless in **demo mode** (simulated generations + Demo Core model) so the product is fully explorable before keys exist.

## Supabase

Project `anticodex` (`xmbkmdqaczlxkdarayyy`). Schema: [`supabase/schema.sql`](supabase/schema.sql)
(users, threads, reset_codes, mcp_connections, generations, sessions, audit, outbox, api_keys + RLS).
Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the server env to use Postgres persistence
(JSON file store in `data/` is the automatic fallback).

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
