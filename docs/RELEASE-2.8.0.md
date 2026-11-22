# ANTICODEX 2.8.0 - Codex parity, tier 1

The goal is the /parity table, not a slogan: a row moves because the filesystem
resolver finds an implementation and a test pins its behaviour.

## Landed
- **apply_patch in the Codex envelope** (lib/apply-patch.js + the agent tool):
  Add / Update / Delete / Move to, @@ context hints, exact-once context matching.
  Ambiguous or missing context is refused naming the line, and every section is
  validated against current content BEFORE anything is written - a refused patch
  never leaves half the files changed. Local and Daytona.
- **update_plan**: ordered steps, pending/in_progress/completed, at most one
  in_progress, honest errors; emits a plan event.
- **Cumulative turn diff**: every write/edit/patch/apply_patch in a turn is
  collected into changes on the done event, plus a change event per edit.
- **Session rollouts + resume** (lib/rollout.js): append-only JSONL per session;
  anticodex resume lists them, anticodex resume <id> "next" replays messages,
  grants and todos. A missing id is an error, never an invented session.
- **anticodex exec --json**: one JSON event per line, order preserved.
- **Slash commands + @file mentions** in the Codex composer (lib/slash.js is a
  pure parser the UI cannot drift from): /new /status /diff /approvals /model
  /help. Unknown commands say so instead of reaching the model as prose.
- The /parity patches row now records both formats and rollout persistence.

## Verification
The new tests/test-codex-parity.mjs suite (64 assertions) passed locally, and the
Vite build succeeded, before this PR was opened. The full matrix is gated by CI.

## Still not claimed (honest limits)
- Sandbox modes remain **policy, not OS isolation**: no Seatbelt/Landlock
  equivalent in pure JS. The execpolicy rule language is not implemented.
- MCP: ANTICODEX is a client; Codex also runs as an MCP **server**. Not yet.
- Context compaction (/compact) and literal crate-for-crate equivalence with
  upstream Rust are not claimed.
