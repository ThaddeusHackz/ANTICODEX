# The Qoder ladder, mapped onto ANTICODEX

Source of truth: https://changelog.qoder.com/ (read 2026-11-23). Two corrections
to the premise this work started from, because the repo's honesty rule applies to
its own roadmap:

- The public changelog **starts at 0.1.0 (27 Aug 2026, "Hello, World!")**. There is
  no 0.0.1 entry. Qoder *IDE* is a separate, older product (launched Aug 2025).
- **0.5.14 is not the latest.** 0.5.14 (17 Nov) was a one-line model-validation
  fix. The latest is **0.5.17 (20 Nov 2026)**.

Status words: **present** = shipped here and pinned by a test; **partial** = a
real piece exists but not the whole capability; **missing** = not built;
**n/a** = a fix or commercial mechanic with no counterpart here.

| Qoder | Date | Headline | ANTICODEX |
|---|---|---|---|
| 0.1.0 | Aug 27 | Hello World: model routing, Harness loop, Browser/Computer Use, ecosystem, Act Proactive | **partial** - 28 providers + picker + Surprise me (no cost/quality auto-router); stepped loop + plan + compaction (no verify/rollback); Computer Use present, Browser Use partial; 33 MCP + 45,762 skills (no plugin marketplace); **Act Proactive now present** (lib/attention.js) |
| 0.1.1 | Aug 27 | Background bulk import, work-role editing | partial - config import exists; no background bulk session import |
| 0.1.2 | Aug 28 | Enterprise policy for extensions/MCP | partial - lib/policy.js capability flags, no org-level admin |
| 0.1.3 | Aug 31 | Streaming/persistence perf, file-tree preference | partial |
| 0.1.4 | Sep 1 | Windows update cleanup | partial - updater exists, no backup GC |
| 0.1.6 | Sep 3 | Batch archive, artifact window, terminal links | partial - Library + artifacts; no batch archive |
| 0.1.8 | Sep 5 | Custom BYOK base URLs; fix lost messages after compression | **present** - custom OpenAI/Anthropic gateways; **compaction now safe** (lib/compact.js) |
| 0.2.1 | Sep 8 | Mobile Remote Control | partial - desktop pairing codes, no mobile client |
| 0.2.2 | Sep 9 | Network proxy; Goal turn limit | partial - step cap present; no proxy config |
| 0.2.3 | Sep 10 | Computer Use accuracy | partial |
| 0.2.5 | Sep 12 | File-open prefs, voice stability, streaks | partial - voice input present |
| 0.3.3 | Sep 18 | **Sites**, PPTX editing, Computer Use 2.0, annotations | **missing** (Sites, PPTX, annotations); Computer Use partial |
| 0.3.4 | Sep 20 | Security fixes | n/a |
| 0.4.1 | Sep 23 | Projects/discussions, **Agent Teams**, cloud automations, **skill evolution** | **skill evolution present** (suggestion only, lib/attention.js); teams/projects/automations missing |
| 0.4.2 | Sep 24 | Side-chat context, suggestion non-blocking | n/a |
| 0.4.3 | Sep 26 | Enterprise hook analytics | n/a |
| 0.4.4 | Oct 10 | Fast models | **present** - Surprise me weights fast gateways; speed dial |
| 0.4.7 | Oct 14 | **Interactive visualizations**, Agent Teams (personal), phone use | **present** - UICore blocks (v2.6); teams/phone missing |
| 0.4.8 | Oct 15 | Queued-instruction fix | n/a |
| 0.4.9 | Oct 22 | WeCom, **video generation**, Linux ARM64, sidebar order | **present** - Hailuo video studio; WeCom/sidebar missing |
| 0.4.11 | Oct 23 | Model badges and update notices | **present** - live/unverified badges, model health |
| 0.5.1 | Oct 30 | Device connections, **Needs Me**, Codex import, Excel plugin | **Needs Me present** (lib/attention.js); pairing partial; Codex config import partial; Excel missing |
| 0.5.2 | Nov 2 | Task-record robustness | n/a |
| 0.5.3 | Nov 3 | List loading stability | n/a |
| 0.5.5 | Nov 5 | Word plugin, Sites canvas, enterprise approval controls | partial - approval modes exist; Word/Sites missing |
| 0.5.6 | Nov 6 | Credits confirmation, sign-in continuity | n/a - BYOK, no credits |
| 0.5.7 | Nov 9 | PPT templates | missing |
| 0.5.11 | Nov 13 | **Next-step suggestions**, custom UI plugins, issue collab | **next-step suggestions present** (lib/attention.js); UICore is the custom-UI analogue; issue collab missing |
| 0.5.12 | Nov 14 | Task titles, faster file-change previews | **present** - cumulative turn diff + change events (v2.8) |
| 0.5.13 | Nov 16 | **Compaction recovery**, context accounting | **present** - safe-boundary compaction (lib/compact.js) |
| 0.5.14 | Nov 17 | Model validation fix | **present** - verify-on-save probes keys and models |
| 0.5.16 | Nov 19 | Cross-network devices, message/file sharing, PAC proxy | missing |
| 0.5.17 | Nov 20 | Plugin pinning, marketplace fixes | missing - no plugin marketplace |

## What v2.9 actually closes

Four rungs, each a pure module with tests rather than a claim:

1. **Safe context compaction** (0.1.8 / 0.5.13) - `lib/compact.js`. Cuts only at a
   boundary that cannot orphan a tool response from its `tool_calls`; refuses to
   compact rather than emit a request the OpenAI wire would reject. The summary
   names files touched and unresolved failures, and tells the model to re-read.
2. **Needs Me / Act Proactive** (0.5.1 / 0.1.0) - `lib/attention.js`. Failed tools,
   changes without a test run, unfinished plan steps, open todos, pending
   questions and the step cap become items derived from events the turn already
   emitted. A clean turn raises nothing.
3. **Next-step suggestions** (0.5.11) - derived from those items, at most three,
   each a sendable prompt. Nothing is auto-sent.
4. **Skill evolution suggestions** (0.4.1) - a repeatable workflow is proposed for
   capture. `writes: false`: it is a suggestion, never a silent skill write.

All four are wired into `runAgent`: a `compact` event when context is condensed,
an `attention` event when something needs the user, and `attention`, `next_steps`,
`skill_suggestion`, `compactions` on `done`.

## Not claimed

Agent Teams, Sites, the Office plugins, a plugin marketplace, mobile remote
control, cross-network device connections, enterprise governance and cloud
automations are **not built**. Qoder's 0.1.0 -> 0.5.17 is roughly three months of a
large team's work across desktop, mobile, cloud and enterprise; this repo closes
the rungs it can prove and lists the rest above rather than implying parity.

## v3 draft scope (not released)

Teams now has bounded read-only Architect/Reviewer workers plus a lead synthesis. Sites generates escaped structured static pages, isolated previews and HTML export. Both remain **partial** relative to Qoder: no autonomous write-enabled teams, hosted sites deployment or Sites canvas editor is claimed. See `docs/RELEASE-3.0.0.md`.
