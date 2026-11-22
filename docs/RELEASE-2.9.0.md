# ANTICODEX 2.9.0 - the Qoder ladder, four rungs closed

Read the whole public changelog (0.1.0, 27 Aug 2026 -> 0.5.17, 20 Nov 2026) and
mapped every release against this repo: see docs/QODER-LADDER.md. Two premise
corrections are recorded there: the changelog starts at 0.1.0, not 0.0.1, and
0.5.14 is not the latest - 0.5.17 is.

## Landed
- lib/compact.js - safe context compaction (Qoder 0.1.8 / 0.5.13). Never orphans a
  tool response; refuses rather than breaking the wire; honest summary marker.
- lib/attention.js - Needs Me inbox + Act Proactive (0.5.1 / 0.1.0), next-step
  suggestions (0.5.11) and skill-evolution suggestions (0.4.1, writes: false).
- runAgent wiring: compact + attention events; attention, next_steps,
  skill_suggestion and compactions on done. AGENT_LIMITS publishes context_chars
  and keep_recent.
- tests/test-qoder-ladder.mjs registered in npm test and the CI matrix.

## Not claimed
Agent Teams, Sites, Office plugins, a plugin marketplace, mobile remote control,
cross-network devices, enterprise governance, cloud automations. The ladder doc
lists them as missing rather than implying parity.
