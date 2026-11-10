# The Daytona workspace

The agent runs on a real machine, not in a tab. This is how that machine is
connected, how its token is kept honest, and what happens when it is not.

Recorded 2026-11-10 against the workspace the user supplied.

## 1. The connection

| Field | Value |
| --- | --- |
| Host address | `ssh.app.daytona.io` |
| Port | `22` |
| Username | `ssh nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL` (the `ssh ` prefix is part of what Daytona shows; both forms are accepted) |
| Authentication | SSH key — `~/.ssh/id_ed25519\|id_rsa\|id_ecdsa`, or a key generated at `~/.qoder/ssh/daytona_ed25519` |
| Name | `Daytona` |

Only those four rows are saved, in `~/.qoder/daytona.json` (mode `600`):

```json
{
  "user": "nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL",
  "host": "ssh.app.daytona.io",
  "port": 22,
  "token": { "set_at": 1794324957897, "ttl_minutes": 1440, "expires_at": 1794411357897, "suffix": "SOTL" }
}
```

The file holds a username, a host, a port and a *countdown*. It never holds a key
or a secret: `suffix` is the last four characters of the workspace user, kept so
two tokens can be told apart in the rotation log.

Environment variables still win over the file, so a one-off
`DAYTONA_SSH_USER=… npm start` behaves. `ANTICODEX_DAYTONA_CONFIG` redirects the
whole file, which is how the tests avoid touching a real home.

## 2. The 1,440-minute token

A Daytona workspace user is issued for **1,440 minutes (24 h)**. The app records
when a token was saved and counts down from there:

* `valid` — more than 60 minutes left;
* `soon` — 60 minutes or less (finish the run you are in);
* `expiring` — 10 minutes or less (do not start a long one);
* `expired` — the countdown is over.

The countdown is a *hint*, and the code says so: only the server can actually
reject an expired token. `daytona op=probe` is the test that matters — it opens a
real SSH connection, and the answer it gives is the truth.

### Rotating

Paste a new token on **Sandbox → Daytona connection** and press Save (or Enter).
`lib/daytona.js` then:

1. writes the new user/host/port;
2. resets `token.expires_at` to now + 1,440 minutes;
3. appends a rotation entry — `{ replaced_suffix, replaced_at, set_suffix }` — and
   keeps the last ten.

"Confirm you replaced the right thing" is answered by four characters, not by
storing a second credential. **Forget token** clears it from this machine; to
invalidate it for real, rotate or delete the workspace user in Daytona's console.

## 3. Installing the sandbox

**Sandbox → Install / repair the sandbox**, or
`daytona op=provision`, runs this checklist over SSH. Every step is idempotent, its
output is read, and a step that prints `x=missing` is a failure even when ssh
exited 0 — the command succeeded at reporting a missing tool, which is not the
same as installing it.

| Step | Installs | Required |
| --- | --- | --- |
| `probe` | nothing; verifies the box answers (`uname`, `id`, `df`) | yes |
| `base` | git, curl, jq, ripgrep, fd (apt or apk) | yes |
| `node` | Node 22 + npm (via NodeSource when absent) | yes |
| `python` | reports python3 + pip (present on every Daytona image seen) | yes |
| `qodercli` | `npm i -g @qoder-ai/qodercli` | no |
| `skillui` | `npm i -g skillui` | no |
| `vibesec` | `pip install --user vibesec` | no |
| `workspace` | `~/.anticodex/workspace` (git-initialised), `~/.qoder/skills`, `~/.codex/skills` | yes |
| `report` | one summary block the page shows as the finished state | yes |

A required step that fails stops the run — the remaining steps would be noise. An
optional one is reported and skipped, because the agent works without them.

Provisioning refuses before it wastes a round trip: with no workspace it says so,
and with an expired token it says how long ago it went and what to do.

## 4. What actually happened here

This sandbox's egress allowlist admits GitHub, npm and PyPI only — **port 22 is
filtered**. Every connection attempt dies at the TCP/kex boundary:

```
kex_exchange_identification: Connection closed by remote host
```

So the honest state of the Daytona path from *this* machine is:

| Verified here | Not verified here |
| --- | --- |
| the token saves, counts down and rotates | that the workspace accepts the key |
| every pasted shape normalises to one target | that the box has git/node/python |
| the SSH argv (port, key, timeouts, known-hosts) is right | that provisioning completes |
| the failure is reported with the exact reason and the command to run | a real remote tool call |
| the agent loop, permissions and tools against a local target | — |

Run one command from a network that allows outbound SSH:

```bash
ssh -p 22 nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL@ssh.app.daytona.io 'uname -a; node -v; python3 -V'
```

If it asks for a key, add the public half:

```bash
cat ~/.qoder/ssh/daytona_ed25519.pub   # printed by "Make a key" on the Sandbox page
```

then run **Install / repair the sandbox** and the same checklist runs for real.

## 5. How the agent uses it

`lib/agent.js` resolves a target once per run (`auto` prefers Daytona when a
workspace is connected) and every tool result carries `target` / `ran_on`, so the
transcript is unambiguous. `bash`, `read`, `write`, `edit`, `patch`, `list`,
`grep` and `glob` each have a remote implementation:

* commands run through the system `ssh` binary with `BatchMode=yes`, a pinned
  `known_hosts`, a connect timeout and no local `~/.ssh/config` interference;
* file writes go base64 through stdin — `backit`-safe against `$`, backticks and
  NUL in source code;
* each session gets its own directory, `~/.anticodex/workspace/<session>`;
* a failed command is a tool *result*, never an exception.

The web app cannot open a socket to port 22, so in the browser the agent page
works against this machine and the honest answer is to say so. The desktop app
runs the same loop in the main process (`acx:daytona`, `acx:api`), where SSH is
available.
