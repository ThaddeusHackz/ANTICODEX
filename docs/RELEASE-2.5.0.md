# ANTICODEX 2.5.0

What changed, what was verified, and what is still limited. The honesty rules
from `AGENTS.md` apply: **seen** = proven by a test or command output in this
repo; **inferred** = reasoned from the code; **unknown** = not exercised here.

## Security and correctness (web + desktop, one bridge)

1. **`search_all` is account-scoped.** It used to call
   `find('threads', () => true, 500)` — every account's chat titles and message
   snippets were searchable by any caller, signed in or not. It now reuses the
   exact ownership rule from `handleThreads`; an anonymous caller on a hosted
   deployment gets `chats_note: "sign in to search your chats"` and no chat
   results. **Seen:** `tests/test-api.mjs` — two accounts, a marker word, cross
   account and anonymous searches asserted empty of the other's rows.
2. **Compound commands cannot ride an allow glob.** `decide()` treated
   `ls; curl … | sh` as matching `ls*: allow`. Any command containing
   `;`, `&`, `|`, a backtick, `>`, `<`, `$(` or a newline now falls back to the
   `*` rule (ask for the built-in agents). An explicit `*: allow` is still
   honoured; a deny is never widened. **Seen:** `tests/test-agent.mjs` —
   chains, pipes, redirects, substitution, newline smuggling, remembered
   grants, explicit wide allow.
3. **Every tool call gets a tool response.** The loop used `calls.slice(0, 8)`
   and silently dropped the rest — the next request then carried `tool_call`
   ids with no matching tool message, which the OpenAI wire rejects. Overflow
   calls now get an explicit "max 8 per round" tool error. **Seen:**
   `tests/test-agent.mjs` — ten calls, ten answers, wire asserted valid.
4. **The JSON store writes atomically.** `db.json` was written in place; a
   crash mid-write truncated every account, thread and session. Writes now go
   to `db.json.tmp` + `rename`. `remove()` also re-reads the local db after its
   REST awaits instead of overwriting concurrent inserts with a stale snapshot.
   **Seen:** code in `lib/store.js`; existing auth/api suites stay green.

## The agent: real subagents

5. **`task` — Build delegates to Explore.** The header comment claimed
   "subagents that run in their own context"; there was no mechanism. Now
   `task(description, prompt)` runs the Explore agent with fresh messages, a
   fresh session, a 6-round budget, no public-API tool and no MCP tools, on the
   same machine. It is read-only by construction (Explore denies write/bash/
   web) and cannot recurse: Explore denies `task`, and a depth cap refuses
   delegation from any run already at depth 1. Child tool events stream to the
   UI as `explore › <tool>` parts; the parent receives the summary as the tool
   result. **Seen:** `tests/test-agent.mjs` — delegation, separate context,
   offered-tool list, depth cap. **Unknown:** behaviour with a live model
   (no provider key in the build sandbox); the loop is driven by an injected
   model, exactly like the existing agent tests.

## Web + desktop performance

6. **Route-level code splitting.** All 21 pages were statically imported into
   one 595 KB bundle (181 KB gzip). Every page except Chat and Auth is now
   `React.lazy` behind one `Suspense` boundary. **Seen:** `npm run build`
   emits per-page chunks; `tests/test-web.mjs` and `tests/test-web-mount.mjs`
   stay green.

## Version

7. `package.json`, `web/package.json`, `desktop/package.json` and the three
   lockfiles report **2.5.0**. The desktop updater only offers an update when
   the release tag is higher than the installed version, so shipping this to
   the `.exe` means tagging `v2.5.0` after merge.

## Still limited (unchanged, and honest about it)

- The `default` account bucket: signed-out library/workspace records on a
  hosted deployment still share one bucket. Demo mode is a feature; isolating
  it per session is future work, not silently changed here.
- `question` ends the turn with remaining tool calls unanswered (the turn is
  over, so no further model call happens — safe today, worth revisiting if
  sessions ever resume mid-round).
- The updater downloads over HTTPS from GitHub Releases but does not verify a
  checksum/signature of the asset.
