# Qoder in ANTICODEX

All 49 public repositories under [`github.com/qoderAI`](https://github.com/qoderAI)
were surveyed on 2026-10-24. Seven of them define a machine-readable contract, and
those are what this app builds on. The rest are release notes, empty placeholders
or reference material, and the Qoder page says so rather than padding a list.

The survey itself is data: `lib/qoder-repos.js` (regenerate the metadata with
`node scripts/sync-qoder-atlas.mjs`). The page is `/qoder`.

## What is actually integrated

| repository | what it defines | where it lives here |
| --- | --- | --- |
| `qoder-cloud-agents-sdk-ts` · `-python` · `-go` · `-java` | Cloud Agents HTTP APIs: base URLs, bearer auth, cursor pages, SSE | `lib/qoder.js` (`qcaRequest`, `qcaPage`, `qcaEvents`) |
| `qoder-acp-demos` | `qodercli --acp` over stdio NDJSON JSON-RPC | `lib/qoder.js` (`createAcpClient`) |
| `qoder-action` | the GitHub Action, its inputs and the qodercli version it is tested with | `qoderActionWorkflow()` |
| `forward-quickstart` | the order of operations: identity → template → session → events | `qoder op:"cloud.*"`, the page's Cloud Agents panel |

The clients are implemented here rather than imported: no runtime dependency, no
build step, and every request this app makes is readable in one file.

## Cloud Agents (Forward API)

Bases, exactly as the SDKs resolve them:

```
forward  https://api.qoder.com/api/v1/forward
managed  https://api.qoder.com/api/v1/cloud
```

Auth is `Authorization: Bearer <token>`, from `QODER_PAT` (or `QODER_ACCESS_TOKEN`).
The token is read **on the server** and never returned to the browser —
`qoder op:"status"` reports which variable is in use and nothing more.

Ops, all server-side:

| op | what it does |
| --- | --- |
| `cloud.whoami` | one cheap list call, so "is this key good?" has an answer |
| `cloud.identities` | list, or `{ method: "create", external_id, name }` |
| `cloud.templates` | list templates |
| `cloud.sessions` | list, or `{ method: "create", identity_id, template_id, title }` |
| `cloud.session` | retrieve one |
| `cloud.send` | `user.message` event with text |
| `cloud.events` | list events (`order: asc|desc`) |
| `cloud.stream` | read the SSE feed for a bounded window (≤ 20 s, ≤ 200 frames) |

`cloud.*` requires a signed-in user or a local install, and every id in a path is
validated against `^[A-Za-z0-9_.:-]{1,128}$` before it is encoded — a request
cannot address a host of its choosing.

### Getting a token

1. Sign in at [qoder.com](https://qoder.com) and create a personal access token
   (the SDKs read exactly this value from `QODER_PAT`).
2. Put it in Settings → Keys as `QODER_PAT`, or export it in the server's
   environment.
3. `qoder op:"cloud.whoami"` should answer `ok: true`.

## The local agent (ACP)

`qodercli --acp` speaks newline-delimited JSON-RPC: `initialize`,
`session/new`, `session/prompt`, with `session/update` notifications streaming
the answer and **permission requests arriving as JSON-RPC requests** for the host
to answer.

```bash
npm i -g @qoder-ai/qodercli     # or: brew install qoderAI/qoder/qodercli
qodercli login                 # once, on this machine
```

Then `qoder op:"acp.probe"` performs a real handshake and reports the agent, the
protocol version, the capabilities, and whether a session can be created. On the
machine this was written, that is:

```
qoder-cli 1.1.78 · ACP 1 · 2.7 s
capabilities: loadSession, sessionCapabilities{close,delete,fork,list,resume},
              promptCapabilities{image,embeddedContext}, mcpCapabilities{http,sse}
not signed in → "Use qodercli login"
```

`qoder op:"acp.prompt"` runs one prompt in a temporary directory. Decisions that
matter:

* **permissions are refused by default.** The host answers
  `session/request_permission` with `cancelled` unless the caller passes
  `allow_tools: true`, in which case it selects the agent's own "allow" option.
  An agent cannot run a tool behind your back because a web page asked it to.
* **no filesystem RPC.** `fs/read_text_file` and `fs/write_text_file` are
  answered with `-32601`, so the agent cannot read this machine through the host.
* **bounded output.** At most 500 update frames are kept for the preview.
* **loopback only.** `acp.*` spawns a process, so it is refused on a hosted
  deployment and from any non-loopback caller.

Signed out, the answer is a sentence rather than a stack trace:

```
qodercli is installed but not signed in. Run `qodercli login`
(or set QODER_PERSONAL_ACCESS_TOKEN) and try again.
```

## The agent in Chat

`qodercli` shows up in the model picker as **Qoder CLI (local agent)**
(`agent::qodercli`), and `chat_stream` routes that ref to the ACP adapter instead
of an HTTP model. The answer travels the same SSE frames as any other assistant
message, so:

| ACP frame | what Chat shows |
| --- | --- |
| `agent_thought_chunk` | the collapsible reasoning panel (`thinking`) |
| `agent_message_chunk` | streamed answer text (`delta`) |
| `tool_call` | a tool chip with its status — never executed by this app |
| `session/prompt` result | `done` with elapsed time, chars and `reasoning_chars` |

Rules that do not bend:

* **loopback only.** The ref is refused with an explanation on a hosted
  deployment: the agent is a process on *your* machine.
* **no silent tools.** Permission requests are answered `cancelled` unless the
  request carries `allow_tools: true`; the page does not send it, so the agent
  cannot edit files because you typed a question.
* **honest failures.** Not installed → the `npm i -g @qoder-ai/qodercli` line.
  Installed but signed out → *"run `qodercli login`"*. Both arrive as an `error`
  event with a `fix`, not as an empty answer.
* **one turn, one process.** Each message starts a fresh `qodercli`, sends the
  system prompt plus the latest user message, and closes the session. Prior
  turns are not replayed into the agent yet — that is the next step, and it is
  called out here rather than implied.

Verified end to end on this machine (`qodercli` 1.1.78, not signed in):

```
data: {"type":"phase","phase":"contacting","ref":"agent::qodercli"}
data: {"type":"phase","phase":"agent","detail":"Qoder CLI 1.1.78"}
data: {"type":"error","state":"auth","error":"qodercli is installed but not signed in…",
       "fix":"Run `qodercli login` on this machine, or set QODER_PERSONAL_ACCESS_TOKEN."}
```

## The GitHub Action

`qoder op:"action.workflow"` returns a workflow for `.github/workflows/qoder.yml`
built from the action's own inputs (`prompt`, `qoder_personal_access_token`,
`qodercli_version`, `enable_qoder_github_mcp`, `flags`), for `pull_request`,
`issue_comment` (`@qoder`) or `workflow_dispatch`. The prompt is emitted as a
JSON-quoted scalar so a quote in the text cannot break the YAML, and the token is
referenced through `${{ secrets.… }}` — never inline.

```yaml
- uses: qoderAI/qoder-action@v1
  with:
    prompt: "Review this pull request for bugs, security issues and missing tests."
    qoder_personal_access_token: ${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
    qodercli_version: '0.1.18'
    enable_qoder_github_mcp: 'true'
```

## What is deliberately *not* integrated

| repository | why |
| --- | --- |
| `better-harness` (2.4k★) | A platform in its own right. Its evidence-first loop is already the shape of REA's plan → apply → verify in this app; nothing was copied. |
| `Qoderian` | An Obsidian plugin. Its value here is the embedding pattern, which the ACP client generalises. |
| `qoder-cloud-agents-opc` (Operra) | A reference product on QCA. Patterns only. |
| `cloud-agents-cookbook` | Recipes for webhooks, schedules and batches — documented, not yet wired. |
| `qodercli-bench-qwen3.8` | An 868 MB benchmark corpus. Not cloned, not needed to run anything. |
| 25 × `changelog-*` | Release notes with screenshots. |
| 6 × empty | `skills`, `qoder-community`, `qoder-plugins-official`, `qoder-sdk-demos`, `cloud-agents-cli`, `cloud-agents-sdk-go`. |

## Tests

`node tests/test-qoder.mjs` — 61 assertions, no network: the atlas (49 entries,
unique, 7 integrated, empty ones labelled), the URL builder, token resolution
(never echoing a token), request errors (no token / HTTP / network / timeout),
the SSE parser across chunk boundaries, the workflow generator, ACP error
translation, and a full ACP conversation against a fake peer that asks for
permission mid-prompt — refused by default, selected only with `allow_tools`.

Verified live on this machine: `qoder op:"acp.probe"` → `qoder-cli 1.1.78`,
ACP 1, 2.7 s; `qoder op:"acp.prompt"` → the sign-in sentence above;
`qoder op:"cloud.whoami"` without a key → `401 no_token` with the fix.
