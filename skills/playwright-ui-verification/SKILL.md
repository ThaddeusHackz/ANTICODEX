---
name: playwright-ui-verification
description: Verify a web UI change with a real browser instead of guessing. Use when asked to check layout, a broken button, a modal that will not close, a regression after CSS work, or "does this page work?".
---

# Playwright UI verification

A screenshot is evidence. A description of a screenshot is not.

## Preconditions

- The Playwright MCP server must be connected (`@playwright/mcp`). If it is not,
  use the local Playwright CLI in the project; do not claim a browser result.
- Serve the built app, not a stale `dist`: `npm run build && npm start`.
- Sign in with a test account, never the owner account, when testing writes.

## Loop

1. Navigate to the exact route. Record the URL and viewport.
2. Assert the element exists by role/name, not by a CSS class alone.
3. Click it. Read the resulting DOM and console. A toast that says "done" is not
   proof; find the persisted state.
4. For a modal: open it, press Escape, click the backdrop, and click the visible
   close control. All three must close it. Check that focus returns to the
   trigger.
5. Screenshot the final state. Save it under the project's evidence folder and
   cite the path.
6. Check the console and network log for errors introduced by the change.

## Reporting

Mark each claim **seen** (with URL + selector or screenshot path) or
**inferred**. If a selector could not be found, write "not found at
<url>", not "does not exist". Never describe a page you did not load.
