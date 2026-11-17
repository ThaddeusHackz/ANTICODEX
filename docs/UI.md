# The interface, and why it looks the way it does

Two complaints drove this pass: **it looks AI-generated**, and **it has errors**.
They have the same root, which is that the app grew by addition — every new page
brought its own colours, its own button, its own idea of a card — and nothing was
checking. So the fix is not another coat of paint. It is one vocabulary, and a test
that fails when someone invents a second one.

## What made it look generated

These are the four tells, all of them mechanical:

| Tell | Where it was | Now |
| --- | --- | --- |
| Gradient-clipped text | hero headings, page titles | brand mark only — one place, by design |
| Glow shadows | decorative `box-shadow: 0 0 Npx` | depth only (`0 18px 50px rgba(0,0,0,.5)` on real overlays) |
| A private palette per page | `#9fe8b8`, `#fca5a5`, `#fcd34d`, `#6ee7a8`, `#8b93ab`, `#22d3ee`, `#2a1414`, `#07090f` | semantic tokens: `--ok --danger --warn --accent-2 --muted --danger-bg --bg-input` |
| Emoji as iconography | card headers | letter marks and text; the logo is a real asset |

The private palette is why the app could not survive light mode: `#fca5a5` on
`#fbfbfc` is invisible. Every colour that meant "error" is now `var(--danger)`,
and the light theme says what that is (`#b3261e`, 7.4:1 on white).

## What was actually broken

Not opinions — these rendered wrong:

- **Three tokens were used and never defined**: `--bg-soft`, `--border-soft`,
  `--text-3`. Every sandbox input, output pane and select was therefore
  transparent with no border — the "why does this look unfinished" bug, in one
  line each.
- **`var(--text-dim)` and `var(--text-3)`** in the agent page: undefined, so the
  diff lines fell back to inherited colour and `+`/`-` looked identical.
- **An invalid colour**, `'--danger'`, after a refactor: not `var(--danger)`, so
  the terminal log lost its colour entirely.
- **No `:focus-visible` anywhere.** The app could not be driven from a keyboard —
  tab moved focus invisibly. One global rule now, with `outline-offset`.
- **`background: var(--x)` unquoted inside a JSX style object**, which is a
  JavaScript syntax error, not CSS. Three pages had it; the bundle refused to
  build. The suite now catches it before the build does (see below).
- **`.table` and `.modal-backdrop`** were invented in JSX with no rule behind
  them, so the agent's step table and the settings dialog rendered unstyled.
- Dead duplicate definitions: a second `:root` overriding the first (that is the
  one that wins — worth knowing when a token "does not apply"), and selectors
  like `.btn` and `.msg-text` defined 7–15 times.

## The rules, enforced

`tests/test-web.mjs` grades the source now, not just the bundle. Twelve checks
run in about 40 ms:

```
✓ no gradient-clipped text outside the brand mark
✓ no decorative glow shadows in inline styles
✓ no raw hex colours in inline styles (use var(--…))
✓ var() in JSX is always a quoted string
✓ every static className has a CSS rule
✓ no var() pointing at an undefined token
✓ there is a global :focus-visible ring
✓ prefers-reduced-motion is honoured
✓ viewport height uses dvh
✓ safe-area insets are respected
✓ numeric surfaces use tabular figures
```

The class-name check is the one that pays for itself: it is why `.table` could
not stay invisible. The hex check is line-scoped on purpose — a regex over a whole
file matches a `#` two statements later and reports a colour that is not there.

## Layout rules

- **`100dvh`, not `100vh`.** A phone browser's chrome is inside `100vh`, so the
  composer sat under the address bar. `dvh` is the visible height.
- **`env(safe-area-inset-*)`** on the shell, sidebar and composer footer, so the
  installed PWA does not put the send button on the home indicator.
- **Flex sizing with `min-height: 0`** for every pane. `height: 100%` inside a
  flex column is `100vh`, which is how the codex terminal and its Run button were
  cut off by `.app { overflow: hidden }`.
- **`tabular-nums`** wherever numbers stack (counts, token countdowns, latency),
  or the digits jump as they update.
- **One focus ring**, `outline-offset: 2px`, so it does not sit on the border.

## Not migrated (and said out loud)

The chat surface keeps its ChatGPT-shaped composition — that is the product, not
drift. `web/ios/` is a Capacitor shell; it inherits these tokens or it does not
render, and that is a Mac-and-Xcode step. No page has been visually verified in a
real browser from this environment (see the egress note in `docs/DAYTONA.md`), so
the checks above are source-level. They are the ones that could be automated here;
a screenshot diff is the obvious next step and needs Playwright on a machine that
can fetch a browser.
