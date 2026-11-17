# MCP catalogue: what is in it, and what it costs

`lib/mcp.js` ships a curated catalogue. Two kinds of entry:

- **Remote** (`https://…`) — the provider's own endpoint, OAuth in the browser.
- **Local** (`stdio:<id>`) — a launch spec for `npx`, run by the desktop app. A
  `stdio:` URL resolves through `stdioSpec()`, which is the *only* place a child
  process spec can come from. A URL in a request can never name a command.

## Added for UI work

Pulled in because "make the interface good" is not a prompt, it is a loop: read
the design, build it from real components, then look at it in a browser.

| Server | Transport | Why it earns its tool budget |
| --- | --- | --- |
| `figma` | remote, OAuth | design tokens and Code Connect — build from the file, not a screenshot |
| `shadcn` | `npx shadcn@latest mcp` | real component source from the registry instead of a model's memory of one |
| `playwright` | `npx @playwright/mcp@latest` | drive the page, read the accessibility tree, screenshot the result |
| `chrome-devtools` | `npx chrome-devtools-mcp@latest` | computed CSS, console errors, network — catches the override a unit test cannot |
| `neon` | remote, OAuth | copy-on-write branches, so a migration is rehearsed, not gambled |
| `prisma` | remote, OAuth | schema modelling and introspection |
| `firecrawl` | remote, OAuth | search, JS-rendered scraping, structured extraction |
| `sequential-thinking` | `npx @modelcontextprotocol/server-sequential-thinking` | a revocable scratchpad for multi-cause bugs |

## Fixed endpoints

Six entries pointed at URLs that had moved or were wrong, which fails as "OAuth
did not work" with no other clue:

| Entry | Was | Is |
| --- | --- | --- |
| linear | `mcp.linear.app/sse` | `mcp.linear.app/mcp` |
| cloudflare | `mcp.cloudflare.com/sse` | `mcp.cloudflare.com/mcp` |
| sentry | `mcp.sentry.dev/sse` | `mcp.sentry.dev/mcp` |
| stripe | `mcp.stripe.com/sse` | `mcp.stripe.com` |
| vercel | `mcp.vercel.com/sse` | `mcp.vercel.com` |
| deepwiki | `mcp.deepwiki.com/sse` | `mcp.deepwiki.com/mcp` |

## Context cost

A server that advertises 300 tools costs 300 JSON Schemas on **every** turn. Three
mechanisms, in order of preference:

1. `suggested_tools` on the catalogue entry — the default subset (REA: 17 of 207).
2. `tool_allowlist` on the connection — the user's own choice.
3. `all_tools: true` — opts back in, deliberately.

`selectTools()` applies them; `max_tools` caps the result. Nothing here hides a
tool from the Connectors page, only from the model's turn.

## Honest limits

- Registry search (`shadcn`) returns component *source*, not a rendered preview.
- `playwright` needs a browser binary (`npx playwright install chromium`) — not
  fetched by `npm install`, and not fetched in this environment.
- Remote endpoints were corrected from their published MCP URLs; each still needs
  the user's own OAuth, which cannot be verified here.
