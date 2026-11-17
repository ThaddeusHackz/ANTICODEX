# ANTICODEX 2.0.0

Release date: 2026-11-17

This is the first release that treats the website and the packaged desktop app as
one product: the same renderer, the same `api/bridge.js`, the same version number.

## What changed

### Providers

- **Numes AI is a first-class gateway** (`https://api.numes.ai/api/v1`,
  `NUMES_API_KEY`) with the six requested ids pinned:
  `dealignai/deepseek-v4.1-flash-uncensored-fp8`,
  `dealignai/glm-5.3-flash-uncensored-fp8`,
  `deepseek/deepseek-v4.1-flash`, `moonshotai/kimi-k3.1-pro`,
  `z-ai/glm-5.3-flash`, `z-ai/glm-5.3`.
- The provider directory is now 28 endpoints. Models resolve through the same
  OpenAI-compatible path as every other gateway, including streaming, tools and
  the reasoning panel.
- The model picker is portalled out of the topbar (to `#root`), so the bar's
  `backdrop-filter` can no longer clip the dialog. The close control is 38 px,
  labelled, and Escape works even when focus is outside the picker. On phones it
  becomes a bottom sheet.

### Sandbox / Daytona

- The form accepts the line Daytona actually gives you:
  `ssh <access-string>@ssh.app.daytona.io`. It fills host, port and username.
- Daytona access strings are bearer credentials, not usernames. They are stored
  in the per-account `remote.json` (mode 0600), **never** returned by the profile
  listing, and shown only as `At2W…ymJK`. Editing a profile with an empty
  username keeps the stored credential.
- The page states the truth: a Daytona access string lasts up to 1,440 minutes
  (24 h). The bridge is loopback/desktop-only, so a hosted deployment cannot use
  SSH on a visitor's behalf.

### Desktop

- Version 2.0.0 across `package.json`, `web/package.json` and
  `desktop/package.json`; `lib/keys.js` reports the same value.
- Desktop sign-in now falls back to the website when the local JSON account
  store rejects a login, then adopts the website session locally. Accounts made
  on anticodex.vercel.app work in the .exe without a separate sign-up.
- The desktop still ships the same bundle: anything in this release is in both.

### Libraries and studios

- **Image Studio** reports the credential it actually found and where it
  found it. A keyless request returns a labelled SVG preview (`provider:"demo"`,
  `mime:"image/svg+xml"`) instead of a fake PNG; a provider failure returns
  `{ok:false,error,fix}` and stays on screen. Batch 1/2/4, negative-prompt
  text, size/model/seed metadata, per-item save and download-all are real.
- **Video Studio** persists jobs in the browser, resumes polling after a reload,
  backs off 4s → 30s, shows an elapsed clock and a queued → rendering → ready
  timeline, and prints MiniMax's own failure sentence. A finished render is
  resolved to a playable download URL; a simulated job is labelled as simulated.
- **Library** reads the two record sets this browser writes (`acx_images`,
  `acx_videos`) with search, kind/time filters, sort, grid/list, preview, bulk
  delete and JSON export, and additionally lists the account's server artifacts
  (sandbox output, documents, exported skills, the server copy of each render)
  in a separate, labelled group. Every stat is derived from records; the Create
  menu links only to surfaces that can make something.
- **Computer Use** sends real coordinates/keys/commands instead of `{}`, gates
  launch/shell behind confirmation, and states that browser mode cannot drive a
  PC rather than printing a fake success.

### Connectors

- 43 official brand marks are vendored under `web/public/logos/` (Simple Icons,
  CC0) and used in Connectors and Settings. Brands with no published mark get a
  labelled monogram, never an invented logo.
- The catalogue is 27 servers. The fake `memory.mcp.anticodex.ai` /
  `fetch.mcp.anticodex.ai` hosts are gone. Memory, Playwright, Chrome DevTools,
  shadcn, context7 and sequential-thinking are real pinned stdio servers;
  `filesystem` states the folder it needs. Postgres was removed because its only
  official server package is archived and unmaintained.

### Agent surfaces

- **OpenCode-style Agent** (`/agent`): a real read/write/edit/bash loop over the
  workspace or a Daytona box, with approvals and a per-step tool log.
- **Public APIs** (`/apis`): 2,335 free endpoints the agent can search and call
  from a loopback/desktop process, never from a hosted open proxy.
- **Codex parity** (`/parity`) and **Evidence** (`/evidence`): the crate-by-crate
  map and the reverse-engineering record behind the claims.
- **Skill atlas**: 2,208 skills indexed for retrieval, grounded into chat turns
  with a hard budget, installable into `~/.qoder/skills`, `~/.codex/skills` or
  `~/.claude/skills`, with the 19-rule safety scanner.

### UI

- The rail is grouped (daily work / Workspace / Intelligence) with an icon-only
  collapse mode, a command palette, and one destination per page.
- Three new bundled skills: `numes-ai-routing`, `playwright-ui-verification`,
  `youtube-research`; Chat, Agent Studio and Codex read the same account set.
- `Install` page (PWA, macOS, Windows), iOS asset bundle and Capacitor project,
  and PWA metadata are part of the same build.
- A11y pass: real controls for clickable elements, focus-visible rings, reduced
  motion, safe-area insets and dialog semantics.

## Verification

- `npm run build` — the bundle that ships in the .exe and on Vercel.
- `npm test` — **24 suites, 2,066 assertions, 0 failures**, including
  `test-brands.mjs` (58), `test-studios.mjs` (75), `test-atlas.mjs` (139),
  `test-agent.mjs` (128) and `test-a11y.mjs` (46). The mount suite adds 16 checks
  that seed Images, Video, Library, Connectors and Settings and assert real
  logos, restored jobs and printed provider errors.
- `node tests/test-web-mount.mjs` — 173 passed: every page renders with the
  real bundle, and the model-picker dialog is observed through its portal.
- The Numes host was **not reachable from the build machine** on 2026-11-16:
  TLS to `api.numes.ai` was reset by its Cloudflare edge. The provider is
  implemented and unit-tested; a live call must be verified from a network that
  can reach the host. A failure is reported as an outage, not as a bad key.
- The Daytona connection was **not** verified from the build machine: outbound
  TCP 22 is blocked here. Parsing, storage, redaction and the command-line shape
  are unit-tested.
- The Windows portable zip could not be produced on this Linux build machine:
  `electron-packager` needs Wine for the icon/version metadata. The release
  workflow builds it on `windows-latest`; the macOS job builds the unsigned
  `.app` zip on `macos-latest`. Neither is claimed as signed.

## Known limits

- A hosted Vercel deployment cannot run SSH or the local sandbox; use the
  desktop app for those.
- Image Studio without Cloudflare credentials produces a labelled preview, not a
  generated image. Video Studio without a MiniMax key produces no render.
- No signed Windows/macOS installer is produced by this repository; the release
  workflow publishes unsigned zips, and the Install page says so.
