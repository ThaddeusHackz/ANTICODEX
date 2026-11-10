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
  const [conn, setConn] = useState('');
  const [saving, setSaving] = useState(false);
  const [steps, setSteps] = useState(null);
  const [provision, setProvision] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api.sandbox.status().then(setStatus).catch(() => {});
    api.daytona.status().then((d) => {
      setDaytona(d);
      if (d?.configured) setTarget(d.mode === 'local' ? 'local' : 'daytona');
      // Pre-fill with what is in force, so "Save" edits rather than replaces.
      const ssh = d?.ssh || {};
      if (ssh.target) setConn(ssh.target);
    }).catch(() => {});
  }, []);

  // The countdown has to move without a refetch, or "23h 59m left" is a screenshot
  // of a number rather than a clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);



  async function revoke() {
    if (!window.confirm('Forget the saved workspace token on this machine? You will need to paste a new one to reconnect.')) return;
    try {
      const r = await api.daytona.revoke();
      if (r?.ok) {
        notify('Token forgotten on this machine — rotate it in Daytona too if it may have leaked.');
        api.daytona.status().then((dd) => { setDaytona(dd); setConn(''); }).catch(() => {});
      } else notify(r?.error || 'Could not clear the token');
    } catch (e) { notify(e.message); }
  }

  async function runProvision(only) {
    setProvision({ running: true, steps: [] });
    try {
      const r = await api.daytona.provision(only ? { only } : {});
      setProvision({ running: false, ...r });
      notify(r?.ok ? (r.summary?.line || 'Sandbox ready') : (r?.error || r?.summary?.line || 'Provisioning failed'));
    } catch (e) {
      setProvision({ running: false, error: e.message });
      notify(e.message);
    }
  }

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

  // Save a typed connection. The shapes Daytona's console hands out are all
  // accepted (`ssh user`, `user@host`, `user@host:22`, `Daytona host`) and stored
  // in one canonical form on this machine, so it survives a restart and the SSH
  // argv, the status panel and the "copy these fields" table cannot disagree.
  async function saveConnection() {
    const value = conn.trim();
    if (!value) return;
    setSaving(true);
    try {
      const r = await api.daytona.configure({ target: value });
      if (r?.ok) {
        setDaytona((prev) => ({ ...(prev || {}), ...(r.status || {}), config: r.config }));
        const saved = r.status || {};
        notify(saved.configured
          ? `Saved — Daytona target ${saved.ssh?.target || value}`
          : 'Saved, but no workspace user was in that value');
        if (saved.configured) setTarget('daytona');
      } else {
        notify(r?.error || 'Could not save that connection');
      }
    } catch (e) { notify(e.message); }
    finally { setSaving(false); }
  }

  const d = daytona || {};
  const daConfigured = Boolean(d.configured);

  // Declared after `daConfigured` on purpose: a hook body runs in render order, so
  // reading it above its `const` is a temporal-dead-zone crash — which is exactly
  // what the mount suite caught ("Cannot access 'daConfigured' before initialization").
  useEffect(() => {
    if (!daConfigured) return;
    api.daytona.steps().then(setSteps).catch(() => {});
  }, [daConfigured]);

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

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-head">
          <h3>Daytona connection</h3>
          <div className="right">
            <span className={`pill ${daConfigured ? 'ok' : 'warn'}`}>{daConfigured ? 'configured' : 'not configured'}</span>
            {d.mode && <span className="pill">{d.mode}</span>}
          </div>
        </div>
        <div className="tiny" style={{ marginBottom: 8 }}>
          Paste the target Daytona shows you. All of these work and are stored the same way:{' '}
          <code className="code-inline">ssh {d.ssh?.user || '&lt;workspace-user&gt;'}</code>,{' '}
          <code className="code-inline">{d.ssh?.user || '&lt;workspace-user&gt;'}@{d.ssh?.host || 'ssh.app.daytona.io'}</code>,{' '}
          <code className="code-inline">{d.ssh?.user || '&lt;workspace-user&gt;'}@{d.ssh?.host || 'ssh.app.daytona.io'}:{d.ssh?.port || 22}</code>.
          It is written to <code className="code-inline">{d.ssh?.saved_file || '~/.qoder/daytona.json'}</code> as a username, a host and a port —
          never a key or a token. Environment variables still win, so a one-off <code className="code-inline">DAYTONA_SSH_USER=…</code> overrides this.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            value={conn}
            onChange={(e) => setConn(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveConnection(); }}
            placeholder="WtMs6F8XVkKfRX7TDUrzlAunuPS3pqJs@ssh.app.daytona.io:22"
            spellCheck={false}
            style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: '9px 11px', fontFamily: 'var(--mono)', fontSize: 12.8, outline: 'none' }}
          />
          <button className="btn small primary" onClick={saveConnection} disabled={saving || !conn.trim()}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="btn small" onClick={probe} disabled={busy || !daConfigured}>Probe</button>
          <button className="btn small ghost" onClick={makeKey} disabled={busy}>Make a key</button>
        </div>
        {d.session_token?.known && (
          <div style={{ marginTop: 8 }}>
            {/* The countdown. A Daytona workspace user is issued for 1,440 minutes;
                a long agent run that starts at 23h55m has five minutes to live, and
                the page has to say so before the run, not after it fails. */}
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <span className={`pill ${d.session_token.state === 'valid' ? 'ok' : d.session_token.state === 'soon' ? 'warn' : 'err'}`}>
                {d.session_token.state === 'expired'
                  ? `expired ${Math.abs(Math.round((d.session_token.expires_at - now) / 60000))} min ago`
                  : `${Math.floor(Math.max(0, d.session_token.expires_at - now) / 3600000)}h ${Math.floor((Math.max(0, d.session_token.expires_at - now) % 3600000) / 60000)}m left`}
              </span>
              <span className="tiny">…{d.session_token.suffix} · {d.session_token.ttl_minutes} min lifetime</span>
              <div style={{ flex: 1, minWidth: 80, height: 6, background: 'var(--bg-input)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, 100 * (1 - Math.max(0, d.session_token.expires_at - now) / (d.session_token.ttl_minutes * 60000))))}%`, height: '100%', background: d.session_token.state === 'valid' ? 'var(--ok, #2e7d32)' : 'var(--danger)' }} />
              </div>
              <button className="btn tiny ghost" onClick={revoke}>Forget token</button>
            </div>
            <div className="tiny" style={{ marginTop: 4 }}>{d.session_token.note}</div>
            {Array.isArray(d.rotation) && d.rotation.length > 0 && (
              <div className="tiny" style={{ marginTop: 4, opacity: .75 }}>
                Rotated {d.rotation.length}× this machine · last: …{d.rotation[d.rotation.length - 1].replaced_suffix} → …{d.rotation[d.rotation.length - 1].set_suffix} on {new Date(d.rotation[d.rotation.length - 1].replaced_at).toLocaleString()}
              </div>
            )}
          </div>
        )}
        {d.source && (
          <div className="tiny" style={{ marginTop: 6 }}>
            Source: user {d.source.user}, host {d.source.host}, port {d.source.port}, key {d.source.key}.
          </div>
        )}
        {d.note && <div className="tiny" style={{ marginTop: 4 }}>{d.note}</div>}

        {/* Install / repair: the checklist that makes the remote box usable by the
            agent (git, rg, node, python, qodercli…). Every row is a command whose
            output was read — no row says "done" because a script exited 0. */}
        {daConfigured && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <b style={{ fontSize: 13 }}>Install / repair the sandbox</b>
              <div className="between" />
              <button className="btn small primary" onClick={() => runProvision()} disabled={provision?.running}>
                {provision?.running ? 'Installing…' : 'Run all steps'}
              </button>
            </div>
            <div className="tiny" style={{ marginTop: 4 }}>
              Idempotent, sequential, and honest per step. A required step that fails stops the run; an optional one (qodercli,
              skillui, vibesec) is reported and skipped.
            </div>
            {(provision?.steps?.length > 0 || steps?.steps?.length > 0) && (
              <table className="table" style={{ fontSize: 12, marginTop: 8 }}>
                <tbody>
                  {(provision?.steps || []).map((st) => (
                    <tr key={st.id}>
                      <td style={{ width: 18 }}>{st.ok ? '✓' : st.optional ? '·' : '✗'}</td>
                      <td>{st.label}</td>
                      <td className="tiny" style={{ whiteSpace: 'pre-wrap', opacity: .8 }}>{st.detail || st.error}</td>
                      <td className="tiny" style={{ textAlign: 'right' }}>{st.seconds}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {provision?.summary?.line && <div className="tiny" style={{ marginTop: 6 }}>{provision.summary.line}</div>}
            {provision?.error && <div className="tiny" style={{ marginTop: 6, color: 'var(--danger)' }}>{provision.error}</div>}
            {!provision && (steps?.steps || []).length > 0 && (
              <div className="tiny" style={{ marginTop: 8 }}>
                Steps: {(steps.steps || []).map((x) => x.label).join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>

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
