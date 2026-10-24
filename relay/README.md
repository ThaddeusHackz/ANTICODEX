# relay

The agent's workspace may only reach npm, PyPI and GitHub. This directory holds a
GitHub Actions job that does the fetching instead: a runner has open egress, so it
can reach `chatgpt.com`, `claude.ai`, the vendors' CDNs and the Microsoft Store,
measure what it finds, and write **facts** into `relay/out/`.

What comes back is observation only — file inventories, counts, IPCs, imports,
sections, strings, hashes. No vendor binary, bundle or prompt is committed here.

Stages (`RELAY_ONLY`):

| Stage | What it does |
|---|---|
| `resolve` | finds installer URLs (winget manifests, Microsoft Store, vendor page) and records them |
| `web` | fetches chatgpt.com / claude.ai (live, then Wayback), pulls up to 24 script bundles, extracts IPC/hosts/routes/flags/shortcuts/storage keys |
| `assets` | given `relay/out/plan.json` (`[{label,url}]`), downloads an installer, unpacks MSIX/bundle/NSIS, unpacks any `app.asar`, runs the same fact pass, and reports PE structure of the bundled executables via `relay/pe.py` (pefile + capstone) |

Trigger a run by pushing a change to `relay/trigger.txt`, or dispatch the workflow
with `only` / `plan` inputs.
