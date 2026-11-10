# The agent

An OpenCode-shaped coding agent — same loop, same permission model, same tool
surface — with one thing opencode does not have: the machine it works on is
chosen, and every step says which one it touched.

Read this next to `lib/agent.js`; the comments there cite the same decisions.

## 1. The loop

```
user message
   │
   ├─ resolve agent (build | plan | explore) and target (daytona | local | auto)
   ├─ offer only the tools that agent may use      ← a denied tool is never offered
   │
   ├─ LLM ──▶ assistant text + tool_calls?
   │            │                          │
   │           no                         yes
   │            │                          ├─ for each call: permission verdict
   │            ▼                          │     allow → execute
   │        done (text)                    │     ask   → yield a permission event, wait
   │                                       │     deny  → tool error back to the model
   │                                       ├─ execute on the target, cap the output
   │                                       └─ results appended, round++
   │
   └─ at the step cap: force a text-only answer (no tools offered) and finish
```

`runAgent` is an async generator: it yields events and never writes to a response.
The bridge turns that into SSE; the desktop app turns it into IPC; a test can
consume it directly with no HTTP at all.

Events: `session`, `skills`, `assistant_delta`, `tool_start`, `tool_end`,
`permission`, `todo`, `step_limit`, `done`, `error`.

## 2. Agents

| Agent | Steps | Can | Cannot |
| --- | --- | --- | --- |
| `build` | 12 | read, write, edit, patch, bash, grep, glob, list, skill, todos | — |
| `plan` | 10 | read, grep, glob, list, skill | write, edit, patch, bash, web |
| `explore` | 8 | read, grep, glob, list | everything else, including network |

"Plan cannot write" is not a warning label: `allowedTools()` filters the tool list
before the model sees it, so a plan agent is never given a write schema to call.

## 3. Permissions

Three decisions — `allow`, `ask`, `deny` — as a bare string or a glob map. The
**last matching pattern wins**, so a config can start broad and carve out the
dangerous commands:

```js
bash: { '*': 'ask', 'ls*': 'allow', 'cat *': 'allow', 'git status*': 'allow', 'npm test*': 'ask' }
```

Precedence, which is the part worth knowing:

1. a decision the user already made this session (`allow_always` / `deny_always`)
   for that exact pattern — **a remembered deny outranks an `allow` in the agent
   config**, because "never do that again" has to mean it;
2. otherwise the last matching pattern in the agent's own rules;
3. a tool the agent never mentions is allowed for `build` and denied for the
   restricted agents — an unlisted tool must never widen a restricted agent.

There is no fourth rule, and **no asker means no**: an `ask` with nobody to answer
it resolves to `deny`. A streamed run (SSE is one-way) can only auto-approve when
the user turned that switch on, and then the grant is recorded in the transcript.

## 4. Tools

| Tool | What it does | Notes |
| --- | --- | --- |
| `read` | file with line numbers, `offset`/`limit` | records the mtime, for `edit` |
| `write` | create or replace a whole file | 400 KB cap, creates parents |
| `edit` | exact-string replace, returns a diff | refuses an ambiguous match unless `replace_all` |
| `patch` | unified diff, several files | refuses on context mismatch, with the line |
| `bash` | one command, stdout/stderr/exit code | 20 s default, 120 s cap |
| `grep` | regex over the tree | skips `node_modules`, `.git`, >2 MB files |
| `glob` | filenames by pattern | same skips |
| `list` | one directory | |
| `skill` | full text of an atlas skill | 24 KB of it |
| `todo_write` | the session task list | |
| `question` | asks the user and ends the turn | |
| `public_api` | search + GET 2,335 free APIs | see docs/PUBLIC-APIS.md |

File-time guard: `read` records the mtime, and `edit` refuses if the file changed
since — opencode's `FileTime.assert`, same purpose.

## 5. Targets

`resolveTarget('auto')` prefers Daytona when a workspace is connected and says so
on the `session` event. The remote implementations are described in
docs/DAYTONA.md §5.

A hosted caller cannot run an agent against the server's own machine: the bridge
answers with `needsLocal` instead of executing. That is the difference between a
tool and a remote shell for anyone who finds the URL.

## 6. The step cap

`steps` is a hard cap on tool rounds. On the last round the loop appends

> You have reached the step limit for this turn. Answer now, in text…

and offers no tools, so the turn always ends with an answer rather than a dangling
tool call. Same idea as opencode's `MAX_STEPS`, and the reason a confused model
cannot spend an hour in a loop.

## 7. Where it is wired

| Surface | Entry point |
| --- | --- |
| bridge | `action: 'agent'` with `op: status \| tools \| run \| stream` |
| web | `/agent` (`web/src/pages/Agent.jsx`) — Build/Plan/Explore, tool parts, diffs, permissions panel |
| desktop | the same loop through `acx:api`; SSH lives in the main process |
| tests | `tests/test-agent.mjs` — a full multi-step run with approvals, driven by an injected model |

## 8. What is not built

* **Interactive approval inside a stream.** SSE cannot carry the answer back, so a
  streamed `ask` is a deny unless auto-approve is on. The `run` op accepts
  `permissions: [{ id, decision }]` for a caller that wants to answer, which is
  what the desktop app can do over IPC.
* **Subagents.** `explore` exists as a primary agent; delegating a child session
  from inside a run (opencode's `task` tool) is not implemented.
* **LSP diagnostics** after an edit. There is no language server in this app.
* **Session persistence.** The transcript lives on the page; threads are the Chat
  page's job, and the agent does not yet write into them.
