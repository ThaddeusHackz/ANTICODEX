# ANTICODEX UI 2.7 - a calmer, editorial chat surface

Honesty rules from AGENTS.md apply: seen = read from a served artifact this
session; inferred = a design pattern reasoned from public knowledge; unknown =
not exercised here.

## What REA can and cannot do here
REA is registered as the rea MCP connector (stdio, 207 tools). It reverse-
engineers binaries/packages, not a live website's rendered DOM. chatgpt.com and
claude.ai are server-rendered React shells behind auth; the build sandbox has no
authenticated session and restricted egress, so a live decompile of their UI is
unknown / not possible here - and this doc does not pretend otherwise. What was
done: fetch both public shells and read the served strings/markup.

## Seen (public shells, this session)
- chatgpt.com serves explicit retry UX strings: "Retry", "Retrying...",
  "Check service status Retry", "This may take a while...". ANTICODEX 2.7 gives
  every failed answer a Retry button and fixes the dead Regenerate action.
- claude.ai leads with an editorial serif headline ("Question what's next"),
  Artifacts, Projects, shared chats. The empty-chat hero now uses a serif
  display face; Projects/shared-spaces remain deferred (a fake deploy/share
  button would violate the honesty rule).

## Inferred (public design language) -> implemented
- Centered ~48rem conversation column; prose 1rem/1.75; user turns as a soft
  right-aligned pill; assistant turns flat and full-width.
- Composer as a floating rounded card (24px) with a quiet border + shadow.
- Hover-revealed message actions, visible on focus-within for keyboard users.
- Quieter rail: 0.85rem items, 8px radius, uppercase micro section labels.
- Consistent 10px button radius, subtle hover lift (no glow), themed scrollbars.
- All colour from the existing token set; light theme still a variable swap.

## Models
- Retry on every assistant turn and every error bubble (resends the prior user
  message - the old Regenerate called send() with an empty input and no-oped).
- Surprise me in the model picker: a random live model, weighted toward
  configured accounts and fast gateways (Groq, Cerebras, Fireworks, Together,
  DeepSeek...) because NVIDIA NIM and Numes can be slow. The speed dial and
  model-health hiding already cover the rest; no provider was removed.

## Deferred (not faked)
Sites (build+deploy), Projects, shared spaces, Monaco-in-Codex, /mcp/:id detail
route. Each needs real wiring + tests; stubs would lie.
