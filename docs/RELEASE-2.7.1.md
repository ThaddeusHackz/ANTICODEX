# ANTICODEX 2.7.1 - the atlas grows to 45,762 skills

2,208 core skills (with bodies) + 43,554 pinned Qoder catalog entries (MIT,
commit ee2951cfe1 of ThaddeusHackz/The-Open-Agent-Skills-Ecosystem).

- Retrieval/grounding cover all 45,762. Qoder bodies are sha256-verified ZIPs
  fetched on demand (skillkit get -> skillBodyRemote); sync callers get an honest
  catalog preview, never a fake body.
- Every entry carries source label + commit; repo/license/tier hydrated from
  index.sources at load.
- Greeting/noise guard: a greeting retrieves nothing.
- Numbers on screen are read, never written (live count); mount test polls (settleUntil).
- vercel.json includes the atlas in the bridge bundle.
- Rebuild: build-skill-atlas.mjs then merge-qoder-atlas.mjs (idempotent, pinned).

Honest limits: tens of MB of metadata (parsed once, cached); Qoder body fetches
need egress to the package host. No skill content was invented.
