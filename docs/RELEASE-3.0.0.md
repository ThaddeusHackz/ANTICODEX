# ANTICODEX 3.0.0 — draft, not released

## Implemented scope

- **Agent Teams**: two independent Explore workers (Architect and Reviewer), then a lead synthesis. Per-worker progress, failures, findings and partial outcomes are visible. Fresh sessions, no grants, no MCP/public-API tools, no shell or write permissions, no nested delegation. Three tool rounds per agent; a 90-second run deadline. This is **read-only collaboration**, not autonomous write-enabled team parity.
- **Sites**: generate validated plain-text content using the selected model, choose Editorial/Product/Studio, edit essential copy, switch desktop/mobile preview, save up to eight drafts **on this device**, and export HTML. Model-authored HTML and scripts are never rendered. Escaping, a restrictive CSP and an opaque-origin iframe with an empty sandbox protect the preview. No remote assets, scripts, trackers, hosting, deployment, cloud sync or interactive application generation is claimed.
- **UI**: original editorial workspace design, responsive split layouts, theme-token colors, accessible labels/focus states, visible loading/error/stop/retry states, reduced-motion support, and shared navigation. The same React routes and bridge serve web and Electron. Native IPC keeps keychain credentials out of the renderer.
- **MCP boundary**: request-scoped account ownership in the datastore covers chat, agents, REA, imports and connector CRUD. Anonymous and legacy ownerless MCP rows are hidden. New IDs are account-namespaced. Credentials and headers are redacted from connector responses; redacted edits preserve server-side secrets. The app session token is not used as a remote MCP bearer credential. OAuth states are owner-bound, expire after ten minutes and are claimed before code exchange. Remote claims use a conditional database PATCH and fail closed.

## Deployment/review gates

1. Review and separately apply `supabase/migrations/20261123_v3_mcp_ownership.sql` if Supabase is configured. **No live migration was executed.** Reconnect legacy ownerless connectors. No automatic credential reassignment.
2. Run build and the complete regression suite. The UI harness uses jsdom on Node 22, consistent with the existing mount harness; backend tests run on Node 20 and 22.
3. Review existing security-hardening drafts #7/#11 separately. This work is not a complete audit or a claim that all their outstanding desktop/SSRF/security issues are resolved. Local JSON OAuth claims are single-process; multi-process deployments must use the conditional database path.
4. Perform real-provider, live OAuth, Vercel and native desktop acceptance checks before production. Injected-model tests are not evidence of live-provider or native-runtime verification.
5. Merge/tag/publish only after separate approval. No v3 release or production deployment is implied by a version bump or this draft PR.

## Evidence

`tests/test-v3.mjs` exercises validation/escaping, request isolation, real JSON-store CRUD, OAuth single-use claims, bounded team coordination, failure/cancellation behavior, and browser/native transport contracts. `tests/test-v3-ui.mjs` mounts both new pages and exercises preview, style/device switching, save/export, errors and account changes. The existing CI matrix includes both suites.
