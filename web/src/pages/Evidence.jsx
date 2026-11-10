import React, { useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { Facts, CopyField } from '../ui.jsx';

// The evidence record. Two kinds of rows, deliberately separated:
//   [seen]     read from an artifact — a package manifest, a crate's source, a
//              live API response, this machine's own filesystem.
//   [inferred] reasoned from what was seen, or from how the product behaves.
// Anything in the second column is a hypothesis and is labelled as one, because a
// forensic page that mixes the two is worse than no page.

const SEEN = [
  {
    what: 'Codex desktop package (Windows MSIX)',
    where: 'AppxManifest.xml — OpenAI.Codex 26.1013.4894.0',
    detail: 'ChatGPT.exe shell + bundled codex.exe, codex-command-runner.exe, a localSystem sandbox service, Chrome native-messaging host, codex:// protocol, .skill file association, screen-capture capabilities.'
  },
  {
    what: 'Codex runtime state',
    where: '~/.codex — 65 entries',
    detail: 'thread_history_1.sqlite (WAL), session_index.jsonl, memories/, goals_1.sqlite, queue_1.sqlite, mcp-oauth-locks/, app-server-daemon/, browser/, computer-use/, skills/, plugins/.'
  },
  {
    what: 'Claude desktop package',
    where: 'AppxManifest.xml — AnthropicPBC.Claude 2.42304.0.0',
    detail: 'CoworkVMServiceStore named-pipe VM service, browser-bridge native messaging across 9 browsers, Office add-in catalog, claude:// protocol.'
  },
  {
    what: 'openai/codex source',
    where: 'github.com/openai/codex (Apache-2.0), swept live',
    detail: '121 crates, 80.8 MB of Rust, 5,949 .rs files: app-server*, execpolicy, sandboxing, bwrap, windows-sandbox-*, apply-patch, code-mode*, skills, hooks, memories, cloud-tasks, agent-*, otel-trace-websocket.'
  },
  {
    what: 'Qoder repositories',
    where: 'github.com/qoderAI — all 49 surveyed',
    detail: 'Seven carry a machine-readable contract (cloud-agents SDKs ×4, acp-demos, qoder-action, forward-quickstart); the rest are release notes or placeholders and are labelled as such.'
  },
  {
    what: 'Qoder user config',
    where: '~/.qoder/settings.json, ~/.qoder/skills',
    detail: 'mcpServers is the only top-level key this app writes; existing keys are preserved and a backup is taken before any merge. Skills are read from the same root Qoder uses.'
  },
  {
    what: 'Skill corpus',
    where: '7 GitHub repositories, pinned by commit',
    detail: '2,208 SKILL.md files, deduplicated by slug with all sources recorded; frontmatter parsed with the same rules lib/skills.js enforces at runtime.'
  },
  {
    what: 'This machine',
    where: 'node 22.22.3, npm 10.9.8, python 3.11.2, Linux x86_64',
    detail: 'Playwright browser download and raw.githubusercontent.com are blocked by this sandbox\'s egress policy; GitHub API, npm and PyPI are reachable. Every install in this build was done over those.'
  }
];

const INFERRED = [
  { what: 'Codex shell is a custom Chromium wrapper', why: 'chrome.dll ≈ 330 MB, v8_context_snapshot.bin and owl-shell-runtime.json next to a 4.8 MB launcher — Electron-like but not Electron.' },
  { what: 'Sandboxing is a kernel boundary upstream', why: 'bwrap on Linux, windows-sandbox-rs + a localSystem service on Windows; this app\'s local runner is a process boundary, which is why Daytona exists here.' },
  { what: 'Qoder\'s skill catalog is not published', why: 'No repository lists it; ~/.qoder/skills is the only inspectable surface, so this app indexes what is installed rather than claiming a copy.' },
  { what: 'Artifact templates come from a picker MCP server', why: 'Template directories carry artifact-template.json + assets/reference.* validated the way the picker would have to validate them.' }
];

export default function EvidencePage() {
  const [map, setMap] = useState(null);
  const [kit, setKit] = useState(null);

  useEffect(() => {
    api.codexMap.map().then(setMap).catch(() => {});
    api.fieldKit().then(setKit).catch(() => {});
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Evidence</h1>
          <p className="sub">
            Reverse-engineering is only worth anything if you can check it. This is the record: what was read, from where, and which
            claims rest on it. Half the columns below are things [seen] in an artifact; the other half are hypotheses with the evidence
            they rest on spelled out.
          </p>
        </div>
      </div>

      {map && (
        <Facts items={[
          { k: 'Codex crates swept', v: map.counts.crates, d: `${(map.source.counts.source_bytes / 1024 / 1024).toFixed(1)} MB of Rust` },
          { k: 'Commit', v: String(map.source.commit).slice(0, 10), d: map.source.repo },
          { k: 'Surfaces traced', v: map.rows.length, d: `${map.tally.parity} implemented` },
          { k: 'Docs read', v: map.counts.docs, d: 'upstream docs/' }
        ]} />
      )}

      <div className="section">
        <h2>[seen] — read from an artifact</h2>
        <table className="tbl">
          <thead><tr><th style={{ width: '24%' }}>What</th><th style={{ width: '26%' }}>Where</th><th>What it showed</th></tr></thead>
          <tbody>
            {SEEN.map((r) => (
              <tr key={r.what}>
                <td><b>{r.what}</b></td>
                <td className="mono tiny">{r.where}</td>
                <td style={{ fontSize: 12.5 }}>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>[inferred] — hypothesis, with its basis</h2>
        <table className="tbl">
          <thead><tr><th style={{ width: '34%' }}>Claim</th><th>Basis</th></tr></thead>
          <tbody>
            {INFERRED.map((r) => (
              <tr key={r.what}><td><b>{r.what}</b></td><td style={{ fontSize: 12.5 }}>{r.why}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {kit && (
        <div className="section">
          <h2>Qoder, surface by surface</h2>
          <table className="tbl">
            <thead><tr><th style={{ width: '18%' }}>Surface</th><th style={{ width: '12%' }}>Status</th><th style={{ width: '24%' }}>Evidence</th><th>Here</th><th style={{ width: '20%' }}>Limit</th></tr></thead>
            <tbody>
              {kit.surfaces.map((s) => (
                <tr key={s.id}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 400 }}><b>{s.label}</b><div className="tiny">{s.what}</div></th>
                  <td><span className={`pill ${s.status === 'live' ? 'ok' : s.status === 'partial' ? 'warn' : s.status === 'needs-cli' ? 'info' : s.status === 'external' ? 'info' : 'err'}`}>{s.status}</span></td>
                  <td className="tiny">{s.evidence}</td>
                  <td style={{ fontSize: 12.5 }}>{s.here}</td>
                  <td className="tiny">{s.limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section">
        <h2>Reproduce it</h2>
        <div className="card col" style={{ gap: 10 }}>
          <div className="tiny">Every number on this page comes from a script in the repository, not from notes. Run these and diff the output.</div>
          <CopyField label="Sweep openai/codex into lib/codex-repos.js" value="node scripts/rea-codex-sweep.mjs" />
          <CopyField label="Rebuild the skill atlas (2,208 skills, pinned)" value="node scripts/build-skill-atlas.mjs" />
          <CopyField label="The parity table resolves against the filesystem — delete a file and it reports missing" value={`node -e "import('./lib/codex-map.js').then(m=>console.log(m.codexParity().tally))"`} />
        </div>
      </div>

      <div className="section">
        <h2>Documents in the repository</h2>
        <table className="tbl">
          <thead><tr><th scope="col" style={{ width: '32%' }}>Document</th><th scope="col">What it records</th></tr></thead>
          <tbody>
            {[
              ['docs/FORENSIC-REPORT.md', 'The original sweep: both desktop packages, runtime directories, the OSS workspace.'],
              ['docs/QODER.md', 'What was taken from each of the 49 Qoder repositories, and what was not.'],
              ['docs/QODER-REA-EVIDENCE.md', 'The command-by-command evidence trail.'],
              ['docs/REA-ENGINES.md', 'Which analysis engines REA needs, and which are present.'],
              ['docs/SPEED-AND-SANDBOX.md', 'How effort presets and the sandbox actually behave.'],
              ['docs/CLOUD-BASELINE.md', 'What the hosted deployment can and cannot do.']
            ].map(([f, d]) => (
              <tr key={f}>
                <td className="mono" style={{ width: 280 }}>{f}</td>
                <td style={{ fontSize: 12.5 }}>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
