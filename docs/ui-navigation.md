# Checking the sidebar

From the repository root, with Node 24.15 or later:

```sh
npm ci --prefix web
(cd web && npx --no-install playwright-core install --only-shell chromium)
npm run build
npm run test:navigation
```

On a minimal Linux runner, add `--with-deps` to the browser installation. To use an already-installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead. Set `NAV_SCREENSHOTS` to a directory to save desktop and phone screenshots.

The test opens the built app on loopback at 1366×950 and 390×844. It clicks every sidebar destination and checks the URL, active link and actual page content. It also exercises chat search and history, repeated New chat, keyboard commands, the account menu, and the drawer with a saved desktop icon preference. The `UI navigation` workflow repeats these checks on pull requests that touch the UI.

Bridge responses are isolated fixtures or offline errors; the comparison and field-guide pages use the repository’s own local catalogues. Passing means the screens and navigation work under those conditions. It does not certify live model generation, OAuth, native computer control, or installation on a device. No provider keys, production credentials, or deployments are used.

Chat links to live workspace status on the corresponding pages rather than loading the full skill atlas, remote workspace status, connectors and parity report just to paint its welcome screen.
