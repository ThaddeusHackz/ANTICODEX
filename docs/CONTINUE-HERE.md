# ANTICODEX — continuation handoff (2026-10-20)

## STOP: draft, not a release

James requested an immediate handoff after reporting only **50 Tasklet credits remaining**. Stop additional development on the originating account. The earlier 475-credit figure is stale. This agent cannot read Tasklet's actual credit balance. No continuous workers or recurring development were configured.

Read this document and review the diff. **Do not merge yet:** the new pairing rules need matching desktop changes, and security blockers remain despite passing existing tests.

## Project/access

- Public repo: https://github.com/ThaddeusHackz/ANTICODEX, base `main`.
- Supabase: `anticodex`, ref `xmbkmdqaczlxkdarayyy`, us-east-1, reported healthy.
- Drive reference folder: https://drive.google.com/drive/folders/1ILynWHvqLaCACzMSo9nt23_KDKBi1-p7
- ChatGPT folder: https://drive.google.com/drive/folders/1U8EaCGic8J3BLuKCF9Buj-On7adG16YG
- Claude folder: https://drive.google.com/drive/folders/1TlnGmESxW4aZVrHM3ohii4AD6uarcwV9
- Original agent had GitHub (ThaddeusHackz), Google Drive (tthaddeus75@gmail.com), and Supabase connections. **Connections, credentials and Tasklet thread files do not transfer with a PR.** Add appropriate connections in the receiving Tasklet account. A different GitHub user needs write permission or a fork to contribute.
- **Vercel was not connected** to the originating agent. No deployment was performed.

## James's requested product

Continue the existing repository, not a fresh rewrite:

1. Original ANTICODEX web app and Windows `.exe` with ChatGPT-/Claude-style chat, history, model picker, files/vision, code workspace, agent studio, memory, artifacts and sandbox/browser workflows.
2. NVIDIA-first model catalog, per-user keys and arbitrary compatible API endpoints with real model/endpoint testing.
3. Tavily/Exa search, Cloudflare Flux images, MiniMax video. Verify model availability, capabilities, pricing and quotas. Do not promise unlimited video or ship reusable secrets.
4. Supabase database/backend, email/password and GitHub login, genuinely emailed password recovery, secure admin, linked website/desktop accounts.
5. Vercel deployment, Windows GitHub Release executable, user-accepted verified online updates.
6. User-approved desktop vision/screen capture, mouse/keyboard, app launch/install; explicit revocable permissions and safe execution boundaries.
7. MCP with browser authorization and editable permissions. Use vetted connectors/custom servers, not unrestricted installation of every server in a directory.
8. Clean original logo/design, no demonic imagery; focused PRs, tests before merges. James requested Claude Opus 5.5 help; one bounded independent Opus review was completed.
9. REA https://github.com/morluto/rea and leanrea https://github.com/aicodeking/leanrea; reference repos https://github.com/openai/codex and https://github.com/anthropics/claude-code; supplied desktop artifacts in Drive. Honor licenses and distinguish observation from inference. Do not claim proprietary service internals were recovered.

## Existing source

React/Vite `web/`, shared Node `api/bridge.js`, `lib/` providers/search/media/MCP, Electron `desktop/` local server/keychain/preload/computer controls/updater/packager, `supabase/schema.sql`, Windows release workflow and five test suites already existed.

REA/leanrea instruction packs already exist in `skills/`; **no reinstall or new binary analysis was performed in this pass**. Skill presence does not establish engine/MCP readiness. `docs/FORENSIC-REPORT.md` is a pre-existing report, read but not independently reproduced. This pass enumerated the parent Drive reference folders and did not download binaries or open credential files.

## Changes implemented in this draft

- Removed default admin/owner passwords and owner-email fallback from runtime configuration. Admin requires explicit credentials; bootstrap owner requires explicit email/password.
- Added `lib/admin-auth.js`: randomized, expiring HMAC admin capabilities, invalidated by credential rotation, replacing deterministic never-expiring admin tokens.
- Removed bootstrap-password bypass of the stored password hash, so the bootstrap password no longer overrides a reset password.
- Production never returns development verification/recovery codes, even without a mailer. Development tests configure code exposure explicitly.
- Password recovery binds to the provider-returned verified email. Numeric OTP verification includes email.
- Verification-purpose validation; confirmed-email gate for local login when verification is required.
- Several status-zero/network-failure responses no longer count as provider success. Audit remaining `<300` checks separately.
- Removed user-ID-as-session fallback; thread operations require valid sessions.
- Endpoint testing validates session authenticity rather than accepting any nonempty bearer string.
- Pairing claim authenticates the account and ignores caller-supplied identity. Polling requires a random 256-bit device secret, hashed into the existing `sessions.id`. Collection removes the pairing row and **exports no shared or personal API keys**.
- Existing tests now provide explicit test-only owner/admin credentials and cover the updated pairing flow.

### Pairing compatibility MUST be completed

`desktop/main.mjs` must retain `device_secret` from `pair/create` in main-process memory and attach it to `pair/status`; clear it on success/timeout. Never put it into the sign-in browser URL or generic renderer state. **Current desktop code does not do this yet**, so desktop pairing is blocked until completed.

`localBridge` must send the per-install `x-anticodex-local` header; backend `pair/adopt` must require `isDesktopLocal(req)` rather than just loopback (still unfixed here). Plan an explicit reconnect/upgrade path for old desktops; never restore insecure polling for compatibility.

Collection currently uses existing store read/remove operations, not an atomic transaction. Add a race-safe transactional consume/RPC before claiming concurrency-safe one-time semantics.

## Live database change ALREADY applied

Metadata checks found **RLS disabled on public.user_keys**, with anon/authenticated grants. No stored key records were read. Supabase migration `protect_user_keys_server_only` was successfully applied:

```sql
begin;
alter table public.user_keys enable row level security;
revoke all privileges on table public.user_keys from anon, authenticated;
grant select, insert, update, delete on table public.user_keys to service_role;
commit;
```

The SQL is also committed under `supabase/migrations/`. Server persistence needs a protected service-role credential, not an anon key. Other public tables had RLS enabled. No post-migration advisory/validation was run before the emergency handoff.

**Repository schema still contains unrestricted policies named "service role full access" without a role restriction. Fix this before reapplying the schema.** Live policy/grant query did not return those policies, so do not conflate repository SQL with live policy state.

Rotate potentially exposed stored API keys and the previously public owner/admin password. Removal from code does not erase Git history. No actual unauthorized access was established.

## Remaining release blockers (Claude Opus review)

1. **MCP tenant isolation/token leaks:** `handleMcp` lacks request authentication and ownership checks; list can expose OAuth tokens; save/delete/call can cross accounts. Stamp/filter `user_id`, redact tokens/secrets, protect OAuth state ownership/expiry/replay, quarantine unowned legacy rows. Chat's automatic MCP collection also currently includes all users' connections.
2. **MCP SSRF:** arbitrary probe/connect URLs and OAuth discovery/token endpoints need resolved-IP and redirect checks. The existing string-based private-address helper is not complete protection against DNS rebinding/redirects.
3. **Markdown XSS:** `web/src/lib/markdown.js` uses insufficient regex sanitation and output reaches `dangerouslySetInnerHTML`. Use a maintained sanitizer or safely disable raw HTML. Test unquoted/single-quoted handlers, SVG, javascript URLs and iframes.
4. **Desktop consent/injection:** `acx:computer` trusts renderer `args.confirmed`. Use native main-process confirmation and revocable screen/input grants. Validate mouse/key args. Remove PowerShell interpolation injection paths in `computer-use.mjs`.
5. **Desktop renderer trust/key exfiltration:** arbitrary `acx:state` changes to `startUrl`/`apiBase` can load privileged untrusted pages/send keys elsewhere. Allowlist patches, pin privileged UI/API to in-process origin, validate IPC senders/frames, block untrusted navigation/redirects.
6. **Updater:** no asset signature/hash validation or strict asset URL/name checks. ZIP update only downloads and claims restart applies it without an application mechanism. Implement verified metadata, acceptance, safe staging/apply/rollback and Windows tests.
7. **Cost/permissions:** anonymous model/search/media/extras may spend shared server keys. Add authenticated quotas, durable rate limits and approval boundaries for model tool writes/computer actions.
8. **Negative tests missing:** production no-mailer recovery, admin tamper/expiry, email-binding, bootstrap rotation, verification gate, pairing concurrency and MCP cross-tenant access. Existing passing tests are not a security certification.

## Validation actually performed

Before changes: web dependency installation, production build and all tests passed. Install reported **4 dependency vulnerabilities (3 moderate, 1 high)**; avoid unreviewed force upgrades.

After changes, syntax checks passed for bridge/auth/admin-auth. `npm test` passed:

| Suite | Passed | Failed |
|---|---:|---:|
| API | 152 | 0 |
| Auth | 53 | 0 |
| Web static | 34 | 0 |
| Web mount | 64 | 0 |
| Desktop | 74 | 0 |
| **Total** | **377** | **0** |

Tests ran on Linux, mostly mocks/integration/static checks. No Windows execution/build/release, live paid-model call, real OAuth completion, email-delivery verification or Vercel deployment was performed. Existing tests do not catch the desktop pairing mismatch above. No merge performed; inspect GitHub CI separately.

## Recommended next order

1. Rotate credentials; validate live RLS/grants/advisors and correct repository schema.
2. Finish desktop pairing proof/local trust and tests; close markdown/desktop privilege flaws before installing on a real PC.
3. Close MCP tenant leaks, OAuth replay and SSRF; add cross-account tests.
4. Add security regressions, rerun tests, inspect CI/reviews, then merge a focused security milestone.
5. Connect Vercel and protected service keys; configure SMTP/GitHub OAuth; test durable backend and real sign-in/recovery.
6. Resume features in bounded PRs, then test/publish Windows releases with verified opt-in updates.

No background development remains running in the originating thread.
