# public-apis: the Glasser replacement

Glasser was a paid broker: "reach for this when a task needs external data",
per call, with a key. It is no longer part of this app. In its place:

* **[public-apis](https://github.com/public-apis/public-apis)** (MIT, 497k stars),
  pinned at commit `88706670ac0f` — **2,335 endpoints, 51 categories, 1,136 of them
  need no key at all**;
* a tool, `public_api`, that any connected model can use to search that catalogue
  and make one GET;
* a page (`/apis`) that shows the same catalogue, so a call can be watched before
  an agent is trusted with it.

## 1. What was removed, and what is left

| Removed | Replacement |
| --- | --- |
| the Glasser MCP server entry | nothing to configure — the catalogue ships with the app |
| `glasser login` and its key | no key: 1,136 endpoints are anonymous |
| the `glasser` skill | still installed under `~/.qoder/skills/glasser`; it describes a tool that is no longer registered, and `docs/QODER-SETUP.md` says how to delete it |

`tests/test-agent.mjs` fails if the word "Glasser" reappears outside a comment that
explains what replaced it.

## 2. The catalogue

`node scripts/build-public-apis.mjs` parses the upstream README table into
`lib/public-apis.json` (and a identical browser copy in `web/public/`). The
upstream file is pinned by commit and cached in `vendor/` (git-ignored); `--refresh`
re-fetches.

Entry shape:

```json
{
  "id": "cat-facts@catfact.ninja",
  "name": "Cat Facts",
  "description": "Random cat facts",
  "category": "Animals",
  "auth": "none",
  "https": true,
  "cors": true,
  "url": "https://catfact.ninja/",
  "host": "catfact.ninja"
}
```

Three parsing decisions worth knowing, because each one was a lie before:

* **an empty cell is `unknown`, not `no`.** 1,136 APIs have a blank auth column;
  reporting those as "no auth needed" told the agent something the catalogue never
  said. Only a literal `No` becomes `none`.
* **the advert blocks are excluded.** The APILayer/MCP promotion sections use the
  same table shape and parsed as "categories"; the index is the only source.
* **ids are unique per host.** Two different "Cat Facts" services exist; both are
  kept, disambiguated by host, so a lookup can never silently pick one.

## 3. The tool

```
public_api(op: "search" | "call" | "categories", q, id, path, headers, category, auth, limit)
```

* **search** ranks by name > name-prefix > whole-query-in-name > category >
  description > host, with a small bonus for endpoints that need no key (an answer
  the agent can actually use).
* **call** performs one `GET` (or `HEAD`) and returns
  `{ status, url, bytes, duration_ms, body }`, with JSON parsed when the content
  type says so.

### What it refuses, and why

A tool that will fetch an arbitrary URL a model names is an SSRF gadget. So:

| Refusal | Reason |
| --- | --- |
| loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6 `::1`/`fc00::/7`/`fe80::/10` | a model must not be able to read cloud metadata or this machine's own services |
| `file:`, `ftp:`, anything not http(s) | only one protocol exists here |
| `POST`, `PUT`, `DELETE` | this tool cannot write to a third party |
| an API whose catalogue row says `apiKey` or `oauth` | it names the key it wants, offers free alternatives in the same category, and never invents one |
| a `path` that is actually a full URL, or that changes host | the request stays on the entry's host |
| bodies over 400 KB, responses over 15 s | bounded, always |

It also reports `insecure: true` when a catalogue entry has no TLS — it does not
quietly upgrade, because some of those hosts have no TLS at all — and marks a
404/429/401 with what that usually means.

## 4. Honest limits

* **Egress.** This sandbox admits GitHub, npm and PyPI only. Every `call` here ends
  in `fetch failed`, which the tool reports with "check the host is reachable from
  this machine". Search, filters, refusals and the catalogue are verified; a live
  third-party response is not.
* **The catalogue is a snapshot.** It is pinned, dated and says so; `--refresh`
  re-pins it.
* **`auth: unknown` is not a promise.** The catalogue does not say; the endpoint
  will.
* **The upstream rows are documentation links, not always API roots.** A 404 on
  `call` usually means "add the documented path", which the tool's hint says.

## 5. Trying it

```bash
npm run apis                  # rebuild from the pinned copy
npm run apis -- --refresh     # re-fetch from GitHub
curl -s localhost:8787/api/bridge -H 'content-type: application/json' \
  -d '{"action":"publicapi","op":"search","q":"currency exchange","limit":5}'
```

Or open **/apis** and press GET on any entry with no key.
