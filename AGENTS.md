# AGENTS.md

Instructions for coding agents working in this repository. Read this before you change anything.

## What this is

ANTICODEX — a universal AI workspace. React + Vite SPA (`web/`), one Node bridge
(`api/bridge.js`) that also runs inside Electron (`desktop/`), JSON/Supabase storage
(`lib/store.js`), and a provider layer covering 26 endpoints (`lib/catalog.js`).

## Rules

- **One bridge.** Every feature goes through `api/bridge.js` as an `action`. The website and
  the packaged `.exe` run the same file, so a fix that only lands in `web/` is a fix the
  desktop app never got. If you add an action, test it from both.
- **Never invent a value.** A model id, a tool name, a version or a "saved" state must come
  from the thing itself. If a provider, MCP server or filesystem cannot answer, return
  `{ok:false, error, fix}` and let the UI print it. A green badge that lies is worse than an
  error.
- **Keys.** `lib/keys.js` hardcoded slots stay empty in source. Resolution order is
  desktop keychain → account keys → env → admin config. Never commit a token, never echo one
  back, never log one. If a config file contains one, report `has_token: true` only.
- **Local process spawning** is registry-only (`lib/mcp.js` `stdioSpec`) or imported-config
  only, and in both cases gated by loopback + a process-capable host + the
  `allow_local_mcp` policy. Do not add a path where a request names a command.
- **Tests are the contract.** `npm test` must stay green. Add a case to the suite that owns
  the behaviour you changed; a bug that has no assertion comes back.
- **Honesty in docs.** Mark claims **seen** (with file:line or command output) / **inferred** /
  **unknown**. "Not found" is not "absent".

## Layout

```
api/bridge.js     every action; also the desktop backend
lib/              providers, catalog, keys, store, mcp (+ mcp-stdio), policy, workspace,
                  configimport, extras, search, flux, minimax, authx
web/src/          App, pages/, lib/, ui.jsx, styles.css
desktop/          Electron main, keychain, updater, packaging
tests/            test-api, test-auth, test-web, test-web-mount, test-mcp-stdio,
                  test-import-config, test-workspace, test-desktop
skills/           REA + leanrea skill packs
docs/             FORENSIC-REPORT, REA-EVIDENCE, REA-SETUP-PLAN
```

## Before you finish

```bash
npm run build && npm test        # web bundle + every suite
```

Keep `web/dist` current — `tests/test-web.mjs` fails a stale bundle on purpose.
