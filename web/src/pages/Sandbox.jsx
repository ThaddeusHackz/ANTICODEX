import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import * as api from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Facts, CopyField, StatusPill } from '../ui.jsx';

const LANGS = [
  { id: 'node', label: 'JavaScript', ext: 'mjs' },
  { id: 'python', label: 'Python', ext: 'py' },
  { id: 'bash', label: 'Shell', ext: 'sh' }
];

const SAMPLE = {
  node: `// node 22 — top-level await works
const rows = [3, 1, 4, 1, 5, 9, 2, 6];
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
console.log('sorted', [...rows].sort((a, b) => a - b).join(' '));
console.log('median', median(rows));
await new Promise((r) => setTimeout(r, 50));
console.log('async also works');`,
  python: `# python 3 — isolated mode, no site-packages surprises
import statistics, sys
rows = [3, 1, 4, 1, 5, 9, 2, 6]
print("python", sys.version.split()[0])
print("median", statistics.median(rows))
print("stdev", round(statistics.pstdev(rows), 3))`,
  bash: `# sh — runs in a disposable directory with a scrubbed environment
echo "whoami: $(whoami 2>/dev/null || echo sandbox)"
echo "files here:"; ls -la
printf 'made by the sandbox\\n' > out.txt
echo "wrote out.txt ($(wc -c < out.txt) bytes)"`
};

export default function SandboxPage() {
  const { notify } = useApp();
  const loc = useLocation();
  const [lang, setLang] = useState('node');
  const [code, setCode] = useState(SAMPLE.node);
  const [status, setStatus] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [daytona, setDaytona] = useState(null);
  const [target, setTarget] = useState(new URLSearchParams(loc.search).get('target') === 'daytona' ? 'daytona' : 'local');
  const [command, setCommand] = useState('uname -a && node -v && python3 -V && pwd');
  const [keyInfo, setKeyInfo] = useState(null);

  useEffect(() => {
    api.sandbox.status().then(setStatus).catch(() => {});
    api.daytona.status().then((d) => { setDaytona(d); if (d?.configured) setTarget(d.mode === 'local' ? 'local' : 'daytona'); }).catch(() => {});
  }, []);

  function pickLang(id) {
    setLang(id);
    setCode(SAMPLE[id]);
    setRun(null);
  }

  async function execute() {
    setBusy(true);
    setRun(null);
    try {
      if (target === 'daytona') {
        const r = await api.daytona.exec(lang === 'bash' ? code : code, { timeout_ms: 20000 });
        setRun({ ...r, launched: 'daytona', language: lang });
      } else {
        const r = await api.sandbox.run({ language: lang, code, timeout_ms: 12000 });
        setRun({ ...r, launched: 'local' });
      }
    } catch (e) {
      setRun({ ok: false, error: e.message, launched: target });
    } finally { setBusy(false); }
  }

  async function runCommand() {
    setBusy(true);
    setRun(null);
    try {
      const r = target === 'daytona'
        ? await api.daytona.exec(command, { timeout_ms: 20000 })
        : await api.workspaceFs.exec(command, { sandbox: 'read-only', approval: 'auto-run' });
      setRun({ ...r, launched: target, mode: 'command' });
    } catch (e) {
      setRun({ ok: false, error: e.message, launched: target });
    } finally { setBusy(false); }
  }

  async function probe() {
    setBusy(true);
    try {
      const r = await api.daytona.probe();
      setDaytona((d) => ({ ...d, probe: r }));
      notify(r.ok ? `Reached ${r.identity || 'the box'}` : (r.hint || r.error || 'Probe failed'));
    } catch (e) { notify(e.message); }
    finally { setBusy(false); }
  }

  async function makeKey() {
    try {
      const k = await api.daytona.key();
      setKeyInfo(k);
      if (!k.ok) notify(k.error);
    } catch (e) { notify(e.message); }
  }

  const d = daytona || {};
  const daConfigured = Boolean(d.configured);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sandbox</h1>
          <p className="sub">
            Run code where it belongs. Locally: a disposable directory, a scrubbed environment and a wall-clock kill. On Daytona: the
            same call over SSH to a real remote box. Every result says which machine ran it — <code className="code-inline">local</code>{' '}
            or <code className="code-inline">daytona:&lt;user&gt;</code>.
          </p>
        </div>
        <div className="actions">
          <div className="chips">
            <button className={`chip ${target === 'local' ? 'active' : ''}`} onClick={() => setTarget('local')}>This machine</button>
            <button className={`chip ${target === 'daytona' ? 'active' : ''}`} onClick={() => setTarget('daytona')} disabled={!daConfigured && !d.local}>Daytona</button>
          </div>
        </div>
      </div>

      <Facts items={[
        { k: 'Target', v: target === 'daytona' ? 'Daytona' : 'Local', d: daConfigured ? 'configured' : 'not configured' },
        { k: 'Runtimes', v: (status?.languages || []).filter((l) => l.available).length, d: (status?.languages || []).map((l) => l.id).join(', ') || '—' },
        { k: 'Timeout', v: `${(status?.limits?.max_timeout_ms || 15000) / 1000}s`, d: 'hard kill, not a suggestion' },
        { k: 'Output cap', v: `${Math.round((status?.limits?.max_output_bytes || 64000) / 1024)} KB` },
        { k: 'SSH key', v: d.ssh?.key ? 'found' : 'none yet', d: d.ssh?.key?.path || 'press “Make a key”' }
      ]} />

      <div className="section split">
        <div>
          <div className="card">
            <div className="card-head">
              <h3>{target === 'daytona' ? 'Remote command (SSH)' : `Code — ${LANGS.find((l) => l.id === lang)?.label}`}</h3>
              <div className="right">
                {target === 'local' && (
                  <div className="chips">
                    {LANGS.map((l) => <button key={l.id} className={`chip ${lang === l.id ? 'active' : ''}`} onClick={() => pickLang(l.id)}>{l.label}</button>)}
                  </div>
                )}
                <button className="btn small primary" onClick={execute} disabled={busy}>{busy ? 'Running…' : '▶ Run'}</button>
              </div>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={14}
              spellCheck={false}
              style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: 11, fontFamily: 'var(--mono)', fontSize: 12.8, lineHeight: 1.6, outline: 'none' }}
            />
            <div className="tiny" style={{ marginTop: 6 }}>
              {target === 'daytona'
                ? 'The snippet is written to a temp file on the remote box and executed there; the target and its exit code come back with the output.'
                : 'Runs with a scrubbed environment in a new directory under the data folder. This is not a container and not a kernel sandbox — it is a process boundary, and the runs are only for the person sitting at this machine. Daytona is the strong version.'}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head">
              <h3>Command</h3>
              <div className="right"><button className="btn small" onClick={runCommand} disabled={busy}>Run command</button></div>
            </div>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: '9px 11px', fontFamily: 'var(--mono)', fontSize: 12.8, outline: 'none' }}
            />
            <div className="tiny" style={{ marginTop: 6 }}>Same target switch. A remote command runs over SSH; a local one goes through the workspace policy gate.</div>
          </div>
        </div>

        <div>
          <div className="card" style={{ minHeight: 260 }}>
            <div className="card-head">
              <h3>Result</h3>
              <div className="right">
                {run?.target && <span className="pill info">{run.target}</span>}
                {run?.exit_code != null && <span className={`pill ${run.exit_code === 0 ? 'ok' : 'err'}`}>exit {run.exit_code}</span>}
                {run?.duration_ms != null && <span className="pill">{run.duration_ms} ms</span>}
                {run?.timed_out && <span className="pill warn">timed out</span>}
              </div>
            </div>
            {!run && <div className="empty">Run something. Output, exit code and duration appear here — for whichever machine ran it.</div>}
            {run?.error && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 13 }}>{run.error}</div>}
            {run?.hint && <div className="pill warn" style={{ marginBottom: 8 }}>{run.hint}</div>}
            {run?.stdout !== undefined && (
              <>
                <div className="tiny" style={{ marginBottom: 4 }}>stdout</div>
                <pre style={{ margin: 0, padding: 11, background: 'var(--bg-input)', borderRadius: 9, fontSize: 12.3, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{run.stdout || '(no output)'}</pre>
              </>
            )}
            {run?.stderr ? (
              <>
                <div className="tiny" style={{ marginTop: 8, marginBottom: 4 }}>stderr</div>
                <pre style={{ margin: 0, padding: 11, background: '#2a1414', borderRadius: 9, fontSize: 12.3, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#ffb4b4' }}>{run.stderr}</pre>
              </>
            ) : null}
            {run?.files?.length ? (
              <>
                <div className="tiny" style={{ marginTop: 8, marginBottom: 4 }}>files written</div>
                <div className="row wrap" style={{ gap: 4 }}>{run.files.map((f) => <span className="pill mono" key={f.name || f}>{f.name || f}</span>)}</div>
              </>
            ) : null}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head">
              <h3>Daytona</h3>
              <div className="right">
                <StatusPill status={daConfigured ? 'live' : 'partial'} />
                <button className="btn small" onClick={probe} disabled={busy || !d.ssh?.available}>Probe</button>
              </div>
            </div>
            <table className="tbl">
              <tbody>
                {Object.entries(d.fields || {}).map(([k, v]) => (
                  <tr key={k}><td className="tiny" style={{ width: 110 }}>{k}</td><td className="mono tiny">{v}</td></tr>
                ))}
              </tbody>
            </table>
            {d.note && <div className="tiny" style={{ marginTop: 8 }}>{d.note}</div>}
            {d.probe && (
              <div className="card tight" style={{ marginTop: 8, borderColor: d.probe.ok ? 'var(--ok)' : 'var(--danger)' }}>
                <div className="tiny">{d.probe.ok ? `Reached ${d.probe.identity || 'the box'}` : (d.probe.hint || d.probe.error || 'No answer')}</div>
                {d.probe.stdout && <pre style={{ margin: '6px 0 0', fontSize: 11.5 }}>{d.probe.stdout}</pre>}
              </div>
            )}
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="btn small" onClick={makeKey}>Make a key</button>
              <span className="tiny">Generates ~/.qoder/ssh/daytona_ed25519 and shows the public half to paste into Daytona.</span>
            </div>
            {keyInfo?.ok && (
              <div style={{ marginTop: 8 }}>
                <CopyField label="Public key — add this to the Daytona workspace" value={keyInfo.key} />
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <div className="tiny" style={{ marginBottom: 4 }}>Environment for a permanent target</div>
              <CopyField value={'export DAYTONA_SSH_USER="<workspace-user>"\nexport DAYTONA_SSH_HOST="ssh.app.daytona.io"\nexport ANTICODEX_SANDBOX=daytona'} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
