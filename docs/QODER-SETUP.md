# Qoder user-level setup — what was installed, and what could not be

> **Superseded in part (2026-11-10).** Glasser has been removed from this app: its
> MCP server entry, its login and its role are replaced by the public-apis
> catalogue (`docs/PUBLIC-APIS.md`). The sections below are kept because they record
> what was actually run on this machine — including the failures — and because the
> `glasser` *skill* is still in `~/.qoder/skills`. To finish the removal:
>
> ```bash
> rm -rf ~/.qoder/skills/glasser
> # then remove the "glasser" entry from ~/.qoder/settings.json → mcpServers
> ```


Record of the machine configuration this repository was built alongside
(2026-11-10). Every line is a command that was run or a check that was made, so it
can be repeated or audited.

## Environment

| | |
| --- | --- |
| OS | Linux x86_64 (Debian 12) — **not** macOS or Windows; the Windows `%USERPROFILE%` variants in the request were therefore not applicable |
| Home resolved to | `/home/user` (absolute — no literal `~` inside any JSON `command` path) |
| node | v22.22.3 · npm 10.9.8 · npx 10.9.8 |
| python3 | 3.11.2 |
| `qoder` / `qodercli` on PATH | **no** — so `qoder mcp list` could not confirm the file; `settings.json` was validated as JSON and read back instead |

Egress from this sandbox is allowlisted to GitHub, npm and PyPI. Consequences are
recorded per item below rather than glossed over.

## 1. Packages and runtime

| Step | Result |
| --- | --- |
| `python3 -m venv ~/.qoder/mcp-venvs/vibesec` | ✓ |
| `…/pip install --upgrade pip "vibesec[mcp]"` | PyPI ships **vibesec 0.7.0**, whose `mcp` extra does not include `vibesec/mcp_server.py` (it landed in 0.8.0). Installing 0.7.0 leaves the configured `python -m vibesec.mcp_server` failing. Fixed by installing 0.8.0 from source: `pip install "/tmp/vibesec-main[mcp]"` → **vibesec 0.8.0**, `import vibesec.mcp_server` OK. |
| `npm install -g skillui` | ✓ **1.3.4** — `skillui --version` answers |
| `npm install -g @glasser-ai/cli@latest` | ✓ **glasser v0.1.127** (there is no `glasser` package on npm; the CLI is `@glasser-ai/cli`) |
| `npx playwright install chromium` | ✗ **blocked** — `cdn.playwright.dev` is not reachable (`ECONNRESET`). Playwright MCP and SkillUI ultra mode need this browser; run `npx playwright install chromium` on your machine (one command, no config change). |

## 2. `~/.qoder/settings.json`

No file existed, so nothing was overwritten; a backup is written as
`settings.json.bak-*` before any merge on future runs. Existing top-level keys are
preserved (`mcpServers` is the only key merged).

```json
{
  "mcpServers": {
    "supabase":   { "type": "http", "url": "https://mcp.supabase.com/mcp" },
    "context7":   { "command": "npx", "args": ["-y", "@upstash/context7-mcp@latest"] },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "vibesec":    { "command": "/home/user/.qoder/mcp-venvs/vibesec/bin/python", "args": ["-m", "vibesec.mcp_server"] },
    "glasser":    { "type": "http", "url": "https://api.glasser.ai/mcp" }
  }
}
```

`glasser` is registered as the HTTP server **because this sandbox cannot reach
`api.glasser.ai`** (see §3). On a machine with normal egress, delete that entry and
use the CLI instead — it is the richer path.

## 3. Glasser

| Check | Result |
| --- | --- |
| `glasser balance --json` | exits **0** with `{"error":{"code":"usage_error","message":"No Key configured…"}}` — the CLI reports JSON errors with a zero exit code, so an exit code alone is not proof of a balance |
| `glasser login` | ✗ **`Error: Cannot reach https://api.glasser.ai.`** — egress blocked, so the device-code URL and verification code could not be produced from here |
| Therefore | balance: **unknown** (no key); authentication: **not done**. Nothing was pasted into chat and no key was invented. |

To finish on your machine:

```bash
glasser login          # follow the printed URL + code
glasser balance --json # then this answers with your balance
```

## 4. Skills — `~/.qoder/skills/`

| Skill | Source | Name | Description | Body |
| --- | --- | --- | --- | --- |
| `vibesec-skill` | `BehiSecc/VibeSec-Skill@main:SKILL.md` via the GitHub API | `vibesec-skill` (lowercased as required) | 187 chars | 24,514 chars, verbatim |
| `skillui` | `Roentek/Claude_Code_Boilerplate_Framework@main:.claude/skills/skillui/SKILL.md` | `skillui` | 594 chars | 2,591 chars, verbatim |
| `glasser` | `glasser skill install` → `~/.claude/skills/glasser/SKILL.md`, copied to `~/.qoder/skills/glasser/` | `glasser` | 929 chars (trimmed from 1,124 to fit Qoder's 1,024 limit; body untouched) | 21,640 chars, verbatim |

All three names match `^[a-z0-9-]{1,64}$`, all three descriptions are ≤ 1,024, and
each is a single line (the glasser description was a folded `>` block and was
flattened rather than left multi-line, because Qoder's loader reads one line).

`raw.githubusercontent.com` is blocked here, so the two GitHub files were fetched
through `api.github.com/repos/:owner/:repo/contents/:path` with
`Accept: application/vnd.github.raw` — same bytes, allowed host.

## 5. What ANTICODEX does with all of this

- `skillkit op:"installed"` reads those three roots live, so the skills above are
  immediately resolvable by the retrieval engine — nothing had to be re-imported.
- `skillkit op:"export"` writes a skill back into `~/.qoder/skills` with normalised
  frontmatter, which is why the 2,208-skill atlas can be installed into Qoder one
  click at a time.
- The Connectors page manages the same `mcpServers` object (read, merge, preserve
  other keys), and `daytona` speaks SSH to `ssh.app.daytona.io:22`.

## 6. Reloading Qoder

After a change to `settings.json` or `skills/`, restart the app (the MCP servers are
spawned at session start). With the CLI:

```bash
qoder mcp list      # should now show supabase, context7, playwright, vibesec, glasser
```

Inside a Qoder session, the skills are read per turn, so a new `SKILL.md` needs no
restart — only a new turn.
