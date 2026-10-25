# Desktop sign-in: how the website session reaches the app

The desktop app never asks for a password first. Clicking **Continue with GitHub**
opens the website, you sign in there (or are already signed in), and the app picks
the session up from a pairing code. This document is the contract, because the
first version of it broke in a way that looked like "the app opens the browser and
nothing happens".

## The chain

1. `acx:githubLogin` (main process) POSTs `pair:create` to the **website**
   (`ANTICODEX_SITE`, default `https://anticodex.vercel.app`) and gets a 6-digit
   code, valid for 10 minutes.
2. It then opens `https://…/login?desktop=<code>&provider=github` — or the
   `github_login` URL the site returns, with the code inside the signed OAuth
   `state`.
3. The website signs the user in and claims the code. There are three paths, and
   all three must claim:
   * **fresh GitHub sign-in** — `oauthExchange` links the code server-side
     (`state.pair`) and returns `pair_code` to the callback page;
   * **already signed in** — `DesktopLinkHandler` sees `?desktop=` plus a token in
     `localStorage` and claims immediately, no second sign-in required;
   * **email / password / magic link** — the sign-in screens claim with the code
     from the URL or `sessionStorage`.
4. `acx:pairWait` polls `pair:status` until `claimed` is true, saves the session,
   adopts it into the **local** bridge (`pair:adopt`, loopback only) so `/me` and
   `/threads` work on this machine, and mirrors the account's provider keys into
   the OS keychain.

## The bug this fixed

The code was minted by the website, but `acx:pairWait` and `acx:pair` polled the
**local** bridge (`127.0.0.1:8787`) first — a different ledger. A user already
signed in on the website claimed the code remotely, while the app watched a local
table that never saw the claim, and gave up after five minutes.

Now both calls go website-first, local-second (`pairStatus` / `pairClaim` in
`desktop/main.mjs`). Local remains the fallback so an unsigned-in machine whose
own server minted the code still works offline.

The second half of the same bug: the OAuth exchange marks the pairing row used
before the browser posts `claim`, so that write is refused with `400`. The code
must still *report* `claimed: true` afterwards — `claimDesktopPair` in
`web/src/pages/Auth.jsx` asks `pair:status` when the write is refused, instead of
treating a successful link as a failure. `tests/test-api.mjs` pins that.

## Deep links

`anticodex://pair?code=<code>` finishes the hand-off without polling: the app
claims the code and signs the renderer in (`DesktopDeepLinkHandler`).

Electron delivers that URL three ways, and all three are handled in
`desktop/main.mjs`: `second-instance` argv (Windows/Linux, app already running),
`open-url` (macOS), and the argv the process was **launched with** (cold start —
previously dropped, so clicking a link with the app closed opened it signed out).
Links arriving before the renderer is ready are queued and flushed on
`did-finish-load`.

## Diagnosing a stuck sign-in

| Symptom | Where to look |
| --- | --- |
| Browser opens, site shows you signed in, app stays signed out | the app is polling the wrong ledger, or the site never claimed — check `pair:status` for the code |
| `Invalid or expired pairing code` on the site | code older than 10 minutes, or already claimed (that is fine — check `status`) |
| App signed in but chats/files 404 | `pair:adopt` failed locally; restart the app so the local bridge adopts the session |
| Keys missing after linking | the website only sends non-secret provider keys; `ADMIN_*`/`*SECRET*` stay server-side by design |
