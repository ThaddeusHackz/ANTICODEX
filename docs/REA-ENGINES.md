# REA's analysis engines

REA is an MCP server with 207 tools. Most of them are pure Node — parsing, static
analysis, evidence bookkeeping — and they work the moment the server is
registered. The tools that turn a *binary* back into *code* are not: a
decompiler is a large third-party program, and REA's own doctor is explicit that
it will not install one for you.

This page is the honest inventory: what each engine unlocks, the one variable
that turns it on, where the binary actually comes from, and what has and has not
been verified on this machine.

## What REA reports

```
$ npx -y rea-agents@6.7.0 doctor --format json
{"healthy":false,"environment_healthy":false,
 "scope_checks":[… "node" ok, "host" ok,
   "hopper"  missing_analysis_engine,
   "ghidra"  missing_analysis_engine  (GHIDRA_INSTALL_DIR is not set),
   "ida-registration" missing_analysis_engine,
   "jadx"    missing_analysis_engine  (REA_JADX_MCP_JAR),
   "kuna-installation" missing_analysis_engine] }
```

`healthy` and `environment_healthy` are different questions. `healthy` is "REA's
own wiring is intact"; `environment_healthy` is "this machine can actually
decompile something". The app shows both, because *"setup succeeded"* next to a
tool that refuses every native binary is the failure mode this page exists to
prevent.

## The engines

| Engine | Unlocks | Variable | Where the binary comes from |
| --- | --- | --- | --- |
| **Ghidra 12.1.x** | Native binaries — decompiler, xrefs, call graphs, data types. The general-purpose answer. | `GHIDRA_INSTALL_DIR` (extracted release dir) | `github.com/NationalSecurityAgency/ghidra/releases` (needs Java 21+) |
| **JADX** | Android — APK/DEX back to Java sources. | `REA_JADX_MCP_JAR` (the `jadx-headless-mcp` 0.7.1 JAR) | `github.com/Samael-Z/jadx-headless-mcp/releases` |
| **Wakaru 1.13+** | JavaScript — readable modules out of a minified bundle (`recover_javascript_sources`). | `REA_WAKARU_COMMAND` (absolute path, Linux x64 binary) | the Wakaru releases page — see REA's `docs/javascript-recovery.md#install-wakaru` |
| **IDA Pro** | Native, fastest decompiler, commercial licence. | `REA_IDA_MCP_CONFIG` (your IDA MCP registration JSON) | your IDA install + bridge |
| **Kuna** | Native, proprietary. | `REA_KUNA_COMMAND` | the vendor |
| **Hopper 5+** | Native, macOS only. | `HOPPER_LAUNCHER_PATH` | `hopperapp.com` |

Two of these are *not* doctor checks and are easy to miss: Wakaru is reported only
when a JavaScript-recovery tool is actually called, and it fails with
`capability_unavailable` / `unsupported_provider`. `lib/rea.js` knows that name
too, so the app's engine list is not limited to what doctor happens to print.

## State of this checkout

Applied and verified here:

* `npx rea-agents@6.7.0 setup` applied — `~/.codex/config.toml` carries
  `[mcp_servers.rea]`, skill v42 installed;
* registered **as the MCP server named `rea`** in the app (`stdio:rea`), real
  handshake: **207 tools**, protocol `2025-06-18`;
* Qoder's own MCP settings now carry the same server — `~/.qoder/settings.json`:

  ```json
  { "mcpServers": { "rea": { "command": "npx", "args": ["-y", "rea-agents@6.7.0", "mcp"] } } }
  ```

  That closed the one `config_drift` check doctor used to report
  (`registration:qoder`). Doctor now reports drift on nothing.

Engine state: **all five still missing**, and that is deliberate rather than
forgotten. Every one of them is a GitHub *release asset*, and this sandbox's
egress only allows package registries and GitHub *source*:

| Host | Result here |
| --- | --- |
| `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | 200 |
| `codeload.github.com` (source tarballs) | 200 |
| `objects.githubusercontent.com` (release assets: Ghidra zip, jadx jar, Wakaru, Kuna) | **blocked** |
| `deb.debian.org` (so not even `apt install jadx`) | **blocked** |

Building from source is not a way around it: Ghidra needs Gradle and a Maven
resolution, jadx needs the same, and neither can reach its dependency
repositories. Setting `GHIDRA_INSTALL_DIR` to a directory that does not contain
a working Ghidra would turn a red check green and every decompile into a stack
trace, so nothing was faked. The exact commands are in the app (REA → **Analysis
engines** → *Copy steps*) and below.

## Installing one, on a machine with normal internet

Ghidra is the best first choice: one install covers the common case.

```bash
# 1. Java 21+ (Ghidra refuses to start without it)
java -version           # macOS: brew install openjdk@21 ; Debian/Ubuntu: sudo apt install openjdk-21-jdk

# 2. Ghidra 12.1.x — download and unzip the PUBLIC release
mkdir -p ~/tools && cd ~/tools
unzip ~/Downloads/ghidra_12.1*_PUBLIC.zip
export GHIDRA_INSTALL_DIR="$HOME/tools/ghidra_12.1_PUBLIC"     # must be the extracted dir
"$GHIDRA_INSTALL_DIR/support/analyzeHeadless" -version          # proves it runs

# 3. confirm REA sees it
npx -y rea-agents@6.7.0 doctor --format json | grep -A2 ghidra
```

Then make the variable permanent **for the process that spawns REA**:

* **Windows** — `setx GHIDRA_INSTALL_DIR C:\tools\ghidra_12.1_PUBLIC`, then sign
  out and back in (a new shell inherits it; an app launched from the old one
  does not).
* **Linux** — put the `export` in `~/.profile` and log back in.
* **macOS GUI apps** (the packaged ANTICODEX) — they do **not** read your shell
  profile. Either `launchctl setenv GHIDRA_INSTALL_DIR /Users/you/tools/ghidra_12.1_PUBLIC`
  before launching, or start the app from a terminal with the variable set.

Because of that last bullet, the app never claims an engine is configured just
because a path is written somewhere on disk: the check is a real `rea doctor`
run by the same process that would spawn the server.

JADX, for Android work:

```bash
# jadx-headless-mcp 0.7.1 jar + a JDK; then
export REA_JADX_MCP_JAR=/absolute/path/to/jadx-headless-mcp-0.7.1.jar
```

Wakaru, for minified JavaScript:

```bash
# Linux x64 binary, 1.13+
export REA_WAKARU_COMMAND=/absolute/path/to/wakaru
```

## What works with zero engines

Verified here, on the same server, before any decompiler exists:

| Tool | Result |
| --- | --- |
| `analyze_javascript_application` | 7 Qoder repositories reconstructed; coverage recorded in [`QODER-REA-EVIDENCE.md`](QODER-REA-EVIDENCE.md) |
| `rea capabilities` | `rea-dotnet-static` 3/3 groups available, `rea-artifact-graph` 2/3 |
| `recover_javascript_sources` | fails honestly: `capability_unavailable` → set `REA_WAKARU_COMMAND` |

That is the shape of the promise: reading a JavaScript application is a static
analysis problem REA solves by itself; turning machine code into C, or an APK
into Java, needs an engine and says so.
