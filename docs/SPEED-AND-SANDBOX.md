# Speed, thinking, and the sandbox

Pass 6 — 2026-10-24. Three complaints, one of them repeated three times:

> "the models calling from the nvidia api and every other one response is very
> sloww … i want it to be soooo fast like chatgpt.com's own and also i want to see
> their thinking too … and also add a sandbox and the code gen and image gen"

This is what was actually slow, what was done about it, and what the sandbox is
and is not.

---

## 1. Where the seconds were going

Measured on this machine (Node 22.22.3, one MCP server registered — REA):

| path | before | after |
|---|---|---|
| `chat_stream`, `use_mcp:false` | 0.05 s | 0.05 s |
| `chat_stream`, `use_mcp:true` (cold) | **4.35 s** | 0.24 s |
| `chat_stream`, `use_mcp:true` (warm) | **4.35 s** | **0.025 s** |

The provider was never the problem in that number. `handleChatStream` called
`collectTools(conns)` before contacting the model, and that function **spawns every
connected MCP server, waits for its initialize handshake, asks for its tool list
and kills it again** — for REA that is `npx -y rea-agents mcp`, a Node process with
207 tools. It happened on every message, and again on the next one.

`lib/tool-cache.js` fixes it in three steps:

1. **Cache the schemas**, in memory and in `data/mcp-tools.json`, keyed by a
   fingerprint of the connection set (`id@updated_at:enabled`). A reinstall or a
   reconnect changes the key; sending a message never does.
2. **Never block on a cold cache.** `toolsFor(conns, { waitMs })` gives the
   handshake 200 ms and then sends the answer *without* tools while it finishes in
   the background — the UI shows `phase: tools-warming` so "the tool didn't run
   this time" has an answer. The next message is a tool turn.
3. **Invalidate on write**: saving, deleting or re-registering a connection
   (`rea register`) forgets the entry, so a new server is picked up immediately.

Nothing else in the path was worth changing: Node's fetch already keeps
connections alive, and the bridge does no per-request work beyond the account's
own key lookup.

## 2. Thinking, streamed

Providers disagree about the name and agree about the idea. All four shapes are
read:

| wire | where the reasoning is | mapped to |
|---|---|---|
| NVIDIA NIM / DeepSeek / OpenRouter | `choices[0].delta.reasoning_content` | `thinking` events |
| OpenRouter (some models) | `choices[0].delta.reasoning` | `thinking` events |
| Anthropic Messages | `content_block_delta` with `delta.type = "thinking_delta"` | `thinking` events |
| non-streaming (any) | `message.reasoning_content` / `thinking` blocks | `reasoning` on the result |

The stream emits `{type:'thinking', text}` and, on the first thought,
`{type:'phase', phase:'thinking'}`. `done` carries `thinking_ms` and
`reasoning_chars`. The chat UI shows the reasoning live while it happens (dim,
monospace, scrolls) and afterwards as a **“Thought for 1.2 s”** disclosure on the
message — collapsed by default, because the answer is what was asked for.

Thinking does **not** count as the first answer token: `first_token_ms` still means
"when the answer started", which is the number that makes a slow reply legible.

## 3. The speed dial

`Fast · Balanced · Max` in the topbar (`web/src/EffortPicker.jsx`), stored per
browser, sent as `effort` on every `chat` / `chat_stream` call.

| preset | `max_tokens` | `temperature` | deliberation |
|---|---|---|---|
| Fast | 512 | 0.3 | none — `reasoning_effort` omitted |
| Balanced (default) | 1200 | 0.6 | `reasoning_effort: "low"` |
| Max | 4096 | 0.7 | `reasoning_effort: "high"`, Claude thinking budget 4096 |

Rules, in order of who wins:

1. An explicit `max_tokens` / `temperature` from the caller beats the preset (so
   `probeModel`'s eight tokens, and any future caller, are unaffected).
2. `reasoning_effort` is only sent where it is likely to be understood: the
   OpenAI-compatible wires known to document it, a gateway that declares
   `effort: true`, or a model family that takes it (`o3/o4`, `gpt-5/6`,
   `deepseek-r1`, `qwen3`, `qwq`, `magistral`, `nemotron`, `glm-z1`,
   `kimi-k2-thinking`).
3. If a provider answers 400/422 naming the field anyway, the request is **retried
   once without it** and that provider id is remembered for the rest of the
   process — a speed knob must not be able to break a call.
4. Anthropic extended thinking requires temperature 1, so that request is sent at
   temperature 1 and dropped-and-retried if the endpoint refuses.

## 4. The sandbox

`lib/sandbox.js` + `POST {action:"sandbox"}` + `/sandbox`.

What one run is:

* a new directory under `data/sandbox/<run id>`, with the snippet as `main.mjs` /
  `main.py` / `main.sh` plus any extra files the caller names;
* one child process (`node --max-old-space-size=256`, `python3 -I -B`,
  `bash --noprofile --norc`), killed with **SIGKILL** at the limit;
* an environment of `PATH`, a private `HOME`/`TMPDIR`, `LANG`, `NO_COLOR` and
  nothing else — no API keys, no tokens, no inherited secrets (the test proves it
  by exporting one and failing to find it);
* stdout, stderr, exit code, wall time, and the list of files it wrote — readable
  back through `{op:"read"}`, each capped at 64 KB;
* limits: 200 KB of code, 15 s maximum (default 8 s), 20 extra files, the 25 most
  recent runs kept.

What it is **not**: a container. A program can still open sockets and read files
its own user can read. So it is not offered to remote callers at all —
`handleSandbox` refuses anything that is not loopback, with a sentence that names
the desktop app. `ANTICODEX_SANDBOX=remote` exists for someone deliberately
running a single-tenant server, and it is the only way to turn that off.

The "code gen" half is the same page: describe the task, the model writes one
fenced block (at the selected Fast/Balanced/Max effort), the snippet lands in the
editor, ▶ Run executes it. Image generation is next door on `/images`.

## 5. What is covered

`tests/test-fast.mjs` (34) — the presets, the value that reaches the provider, the
400-retry that remembers, `reasoning_content` and Claude `thinking_delta` parsing,
the tool cache fingerprint, the 200 ms budget and the on-disk entry.
`tests/test-sandbox.mjs` (38) — runs in all three languages, the scrubbed
environment, the SIGKILL timeout, the file list and read-back, traversal refusal,
input limits, cleanup, and the loopback gate.
`tests/test-web-mount.mjs` — the dialog renders, the choice is remembered and sent,
the “Thought for” block opens.
`tests/test-desktop.mjs` — the same three features exist in the packaged app.
