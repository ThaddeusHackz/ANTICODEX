# `/imp` — import a Figma file

The Codex composer takes `/imp <figma link or key> [write]`. It reads the file
through Figma's REST API, turns the document tree into design tokens, and writes
three artifacts plus a brief.

This is deliberately **not** the Dev Mode MCP server. `figma` in
`lib/mcp.js` (`https://mcp.figma.com/mcp`) answers questions about a file; `/imp`
is the host-side read that produces committed files.

## What it writes

| File | What it is |
| --- | --- |
| `.figma/design-brief.md` | the file's name, version, pages, frames, token tables, build notes, and every section that could not be read |
| `.figma/tokens.json` | colour / typography / space / radius / shadow / component tokens with usage counts |
| `.figma/tokens.css` | the same values as `:root` custom properties |
| `.figma/source.json` | file key, node id, version — so a re-run can say whether the file moved |

`write` is opt-in. Without it the artifacts are returned to the page and nothing
touches the workspace. With it, the write goes through the same
`sandboxAllowed()` + `decideApproval()` gate as every other workspace write, so
`suggest` asks first and `read-only` refuses.

## What is read, and what is not

| Read | Source | Notes |
| --- | --- | --- |
| colours | SOLID fills/strokes/backgrounds | bound style names are kept; gradients and image fills are **not** flattened into a token |
| type ramp | text node styles | family, weight, size, line height, letter spacing, published style name, uses |
| spacing | auto-layout padding + item spacing | the values actually used, not a 4/8/12 guess |
| radii, shadows | corner radius, drop/inner shadows | shadows emitted as CSS |
| components | COMPONENT / COMPONENT_SET / INSTANCE | instances counted per name |
| comments | `/v1/files/:key/comments` | needs `file_comments:read`; a 403 is reported, not hidden |
| library | `/v1/files/:key/components` | needs `library_content:read` |
| Code Connect | — | **not read.** It lives behind the Dev Mode MCP; claiming it here would be an invented value |
| layout intent (fill/hug) | — | not exported; derive grid rules from tokens + the frames list |

## Token

`FIGMA_TOKEN` — a Figma personal access token with `file_content:read`.

- Per account: Settings → Your API keys → `FIGMA_TOKEN` (takes precedence).
- Shared: `FIGMA_TOKEN` env var or Admin → Keys.
- Never echoed back. `figma status` returns `configured` / `token_valid` / `handle`
  and nothing else.

## Honest limits, seen in this repo's session

- **seen** — the connector authorised for this workspace is a personal access
  token without team/folder scopes: `get_team_projects` came back
  `Figma denied access to team '…' (API error: Invalid scope)` while
  `validate_credential` succeeded. So `/imp` cannot browse folders; it is handed a
  file key.
- **seen** — `figma status` with no `FIGMA_TOKEN` answers `configured:false` and a
  fix, and `/imp <key>` answers `needs_token:true`. Both are asserted in
  `tests/test-figma.mjs`.
- **inferred** — the per-section scopes (`file_comments:read`,
  `library_content:read`). A token missing one fails only that section.
- **unknown** — the exact node budget a very large file needs. The walk stops at
  20 000 nodes and says so (`truncated.walk`, `truncated.horizon`); a thin result
  from a big file is therefore labelled, not silently returned.

## Tests

`npm run test:figma` — 71 assertions: ref parsing (design/file/team/community/
non-figma/bare key), token extraction from a fixture document, cap reporting,
artifact shapes, and `readFigmaFile` request shape + 403/404/429 handling with an
injected `fetch`. The bridge action is exercised against a real server with no
token, because "refuse with a fix" is the behaviour that matters most.
