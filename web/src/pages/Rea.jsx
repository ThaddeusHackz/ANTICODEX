import React, { useEffect, useMemo, useState } from 'react';
import { rea as reaApi, mcp as mcpApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Pill } from '../ui.jsx';

// REA — Reverse Engineer Anything.
//
// REA is a local MCP server (207 tools) plus a setup command that registers
// itself with the agent CLIs it can find. This page is the flow the user asked
// for, in the order that makes it safe:
//
//   1. check Node (REA needs 22.19+)
//   2. ask REA for its own plan — `npx rea-agents@latest setup --dry-run`
//   3. show every action, the exact file each one touches, and what it will run
//   4. only then apply (the plan is fingerprinted, and a plan that changed in the
//      meantime is refused rather than silently applied)
//   5. verify: REA's config file AND a real MCP handshake listing its tools
//   6. register the connection this app uses, so chat/Codex can call those tools
//
// Everything here is local-only by design: each step spawns a process on the
// machine running the app. A hosted deployment shows why instead of failing
// mysteriously.

const CLIENT_LABELS = [
  { id: 'codex', label: 'Codex (~/.codex/config.toml)' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'claude_desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'gemini_cli', label: 'Gemini CLI' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'vscode', label: 'VS Code' }
];

const STEPS = [
  { id: 'node', label: 'Node 22.19+' },
  { id: 'plan', label: 'Review the plan' },
  { id: 'apply', label: 'Apply' },
  { id: 'verify', label: 'Verify' },
  { id: 'connect', label: 'Register with ANTICODEX' }
];

const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default function ReaPage() {
  const { notify } = useApp();
  const [status, setStatus] = useState(null);
  const [client, setClient] = useState('codex');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [applied, setApplied] = useState(null);
  const [verify, setVerify] = useState(null);
  const [tools, setTools] = useState(null);
  const [engines, setEngines] = useState(null);
  const [filter, setFilter] = useState('');
  const [run, setRun] = useState({ tool: '', args: '{}', result: null, ms: null, error: null });

  const loadStatus = async (c = client) => {
    try { setStatus(await reaApi.status(c)); } catch (e) { setStatus({ ok: false, error: e.message }); }
  };
  useEffect(() => { loadStatus(client); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  // REA answers questions about any file without a decompiler, but it can only
  // *take apart* a native or Android binary through one. The plan never mentions
  // engines, so this asks `rea doctor` directly — otherwise "setup succeeded,
  // healthy: true" reads as "everything works" when nothing can decompile.
  async function loadEngines() {
    setBusy('engines');
    try { setEngines(await reaApi.engines()); } catch (e) { setEngines({ ok: false, error: e.message }); }
    finally { setBusy(''); }
  }

  const copySteps = async (e) => {
    const text = [`# ${e.engine}${e.what ? ` — ${e.what}` : ''}`, ...(e.steps || []), e.env ? `${e.env}=<path from above>` : '']
      .filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(text); notify('Steps copied'); }
    catch { notify('Clipboard is blocked here — select the text instead', 'warn'); }
  };

  async function makePlan() {
    setBusy('plan'); setApplied(null); setVerify(null);
    try {
      const r = await reaApi.plan({ client });
      setPlan(r);
      if (!r.ok) notify(r.error || 'REA could not produce a plan');
      else if (r.nothing_to_do) notify('Nothing to change — REA is already set up for that client.');
    } catch (e) { notify('Plan failed: ' + e.message); }
    finally { setBusy(''); }
  }

  async function applyPlan() {
    if (!plan?.plan_id) return;
    setBusy('apply');
    try {
      const r = await reaApi.apply(plan.plan_id, { client });
      setApplied(r);
      if (r.ok) { notify('REA setup applied.'); await loadStatus(); }
      else if (r.changed) { setPlan({ ...plan, plan_id: r.plan_id, actions: r.actions }); notify(r.error); }
      else notify(r.error || 'Setup failed');
    } catch (e) { notify('Apply failed: ' + e.message); }
    finally { setBusy(''); }
  }

  async function runVerify() {
    setBusy('verify');
    try { setVerify(await reaApi.verify({ client })); } catch (e) { setVerify({ ok: false, error: e.message }); }
    finally { setBusy(''); }
  }

  async function register() {
    setBusy('connect');
    try {
      const r = await reaApi.register();
      if (r.ok) { notify(`REA registered as an MCP server — ${r.tools} tools available to chat and Codex.`); await loadStatus(); }
      else notify(r.error || 'Registration failed');
    } catch (e) { notify('Registration failed: ' + e.message); }
    finally { setBusy(''); }
  }

  async function loadTools() {
    setBusy('tools');
    try {
      const r = await reaApi.tools();
      setTools(r);
      if (!r.ok) notify(r.error || 'Could not list tools');
    } catch (e) { notify('Tool list failed: ' + e.message); }
    finally { setBusy(''); }
  }

  async function runTool() {
    if (!run.tool) return;
    let args = {};
    try { args = JSON.parse(run.args || '{}'); } catch { notify('Arguments must be JSON'); return; }
    setBusy('run');
    setRun((r) => ({ ...r, result: null, error: null }));
    try {
      const r = await reaApi.run(run.tool, args);
      setRun((x) => ({ ...x, result: r.result, error: r.ok ? null : r.error, ms: r.ms }));
    } catch (e) { setRun((x) => ({ ...x, error: e.message })); }
    finally { setBusy(''); }
  }

  const nodeOk = status?.node?.ok;

  useEffect(() => {
    if (status?.local && nodeOk && !engines) loadEngines();
  }, [status?.local, nodeOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownTools = useMemo(() => {
    const list = tools?.tools || status?.connection ? (tools?.tools || []) : [];
    const q = filter.trim().toLowerCase();
    return (list || []).filter((t) => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  }, [tools, filter, status]);

  const stepState = {
    node: nodeOk ? 'done' : status ? 'blocked' : 'idle',
    plan: plan?.actions?.length ? 'ready' : plan?.nothing_to_do ? 'done' : 'idle',
    apply: applied?.ok ? 'done' : plan?.actions?.length ? 'ready' : 'idle',
    verify: verify?.ok ? 'done' : applied?.ok ? 'ready' : 'idle',
    connect: status?.registered ? 'done' : verify?.handshake?.ok ? 'ready' : 'idle'
  };

  return (
    <div className="page">
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>REA — Reverse Engineer Anything</h1>
          <p className="muted" style={{ margin: '4px 0 0', maxWidth: '72ch' }}>
            A local MCP server with 207 tools for taking shipped software apart: Electron/asar
            reconstruction, PE/Mach-O/ELF layout, SQLite, plists, APKs, firmware, evidence bundles.
            Setup is a real change to files on this machine, so it is shown before it runs.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Pill kind={nodeOk ? 'ok' : 'warn'}>{status?.node ? `Node ${String(status.node.version).replace(/^v/, '')}` : 'checking Node'}</Pill>
          <Pill kind={status?.local ? 'ok' : 'warn'}>{status?.local ? 'local' : 'hosted'}</Pill>
        </div>
      </div>

      {status && !status.local && (
        <div className="card" style={{ marginTop: 16 }}>
          <b>This deployment cannot run REA.</b>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
            {status.note || 'REA setup spawns `npx` and its MCP server is a local process.'} Open the desktop app, or run
            <span className="kbd"> npm start </span> on your own machine to use this page.
          </div>
        </div>
      )}

      {/* step rail */}
      <div className="rea-steps" style={{ marginTop: 18 }}>
        {STEPS.map((s, i) => (
          <div key={s.id} className={`rea-step ${stepState[s.id]}`}>
            <span className="rea-step-n">{stepState[s.id] === 'done' ? '✓' : i + 1}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <select value={client} onChange={(e) => { setClient(e.target.value); setPlan(null); setApplied(null); setVerify(null); }} aria-label="Which agent CLI should REA register with">
          {CLIENT_LABELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <button className="btn" onClick={() => loadStatus()} disabled={busy === 'status'}>↻ Refresh</button>
        <button className="btn primary" onClick={makePlan} disabled={Boolean(busy) || !status?.local || !nodeOk}>
          {busy === 'plan' ? 'Asking REA for a plan…' : '1 · Show the setup plan'}
        </button>
      </div>

      {/* node + environment */}
      {status?.node && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>Environment</b>
            <Pill kind={nodeOk ? 'ok' : 'warn'}>{nodeOk ? 'Node OK' : 'Node too old'}</Pill>
          </div>
          <div className="tiny" style={{ lineHeight: 1.7, marginTop: 6 }}>{status.node.message}</div>
          <div className="tiny" style={{ lineHeight: 1.7 }}>
            Registration file: <span className="kbd">{status.registration?.file || 'n/a'}</span>
            {status.registration?.present === false ? ' — not written yet' : status.registration?.present ? ' — REA entry present' : ''}
          </div>
        </div>
      )}

      {/* analysis engines */}
      {status?.local && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>Analysis engines</b>
            <div className="row" style={{ gap: 6 }}>
              {engines?.missing
                ? <Pill kind={engines.missing.length ? 'warn' : 'ok'}>{engines.missing.length ? `${engines.missing.length} missing` : 'all configured'}</Pill>
                : null}
              <button className="btn small" onClick={loadEngines} disabled={Boolean(busy)}>
                {busy === 'engines' ? 'Asking REA…' : 'Check engines'}
              </button>
            </div>
          </div>
          <div className="tiny" style={{ lineHeight: 1.7, marginTop: 6 }}>
            REA inspects files with its own parsers, but decompiling a native or Android binary needs a
            third-party engine. REA never downloads one — each is a large binary and a licence of its own —
            so this is the list of what is missing on this machine and the exact line that fixes it.
          </div>
          {engines?.error && <div className="tiny" style={{ color: '#fca5a5', marginTop: 8 }}>{engines.error}</div>}
          {engines && !engines.error && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>
                <span className="kbd">{engines.command}</span> · {fmtMs(engines.ms)} · ready for decompiling:{' '}
                <b>{engines.missing?.length ? 'no' : 'yes'}</b>
              </div>
              {(engines.missing || []).map((e) => (
                <div key={e.name} style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <b>{e.engine}</b>
                    <Pill kind="warn">not configured</Pill>
                    <button className="btn small ghost" onClick={() => copySteps(e)}>Copy steps</button>
                  </div>
                  {e.what && <div className="tiny" style={{ marginTop: 4 }}>{e.what}</div>}
                  {e.needs && <div className="tiny" style={{ marginTop: 2 }}>Needs: {e.needs}</div>}
                  <ol className="tiny" style={{ margin: '6px 0 0 18px', lineHeight: 1.75 }}>
                    {(e.steps || []).map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {e.env && (
                    <div className="tiny" style={{ marginTop: 6 }}>
                      Variable: <span className="kbd">{e.env}</span>
                    </div>
                  )}
                  {e.remediation && <div className="tiny" style={{ marginTop: 4, opacity: 0.75 }}>REA says: {e.remediation}</div>}
                </div>
              ))}
              {(engines.optional || []).map((e) => (
                <div key={`opt-${e.name}`} style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <b>{e.engine}</b>
                    <Pill kind={e.configured ? 'ok' : ''}>{e.configured ? 'configured' : 'optional'}</Pill>
                    <button className="btn small ghost" onClick={() => copySteps(e)}>Copy steps</button>
                  </div>
                  <div className="tiny" style={{ marginTop: 4 }}>
                    {e.what}{e.when ? <> — only needed for <span className="kbd">{e.when}</span></> : null}
                  </div>
                  {!e.configured && (
                    <ol className="tiny" style={{ margin: '6px 0 0 18px', lineHeight: 1.75 }}>
                      {(e.steps || []).map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  )}
                  {!e.configured && e.env && (
                    <div className="tiny" style={{ marginTop: 6 }}>Variable: <span className="kbd">{e.env}</span></div>
                  )}
                </div>
              ))}
              {engines.note && <div className="tiny" style={{ marginTop: 10, lineHeight: 1.6 }}>{engines.note}</div>}
            </>
          )}
        </div>
      )}

      {/* plan */}
      {plan && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>{plan.nothing_to_do ? 'Nothing to change' : `The plan — ${plan.actions.length} action(s)`}</b>
            <span className="tiny">{plan.command}</span>
          </div>
          {plan.parse_error && <div className="tiny" style={{ color: '#fca5a5', marginTop: 6 }}>{plan.parse_error}</div>}
          {plan.nothing_to_do ? (
            <div className="tiny" style={{ marginTop: 8 }}>
              REA is already registered for {client} and its skill is current. Nothing will be written.
            </div>
          ) : (
            <>
              <ol className="rea-actions">
                {plan.actions.map((a) => (
                  <li key={a.id}>
                    <div className="rea-action-summary">{a.summary}</div>
                    <div className="tiny rea-action-meta">
                      <span className="kbd">{a.kind}</span> · {a.operation} · <span className="kbd">{a.target}</span>
                      {String(a.external) === 'true' ? ' · touches something outside this app' : ''}
                    </div>
                    {a.detail ? <div className="tiny rea-action-detail">{a.detail}</div> : null}
                  </li>
                ))}
              </ol>
              <div className="tiny" style={{ marginTop: 10, lineHeight: 1.6 }}>
                Plan <span className="kbd">{plan.plan_id}</span> · generated in {fmtMs(plan.ms)}.
                Applying re-asks REA for the plan first: if it changed, nothing is written and you see the new one.
                A copy of each file REA edits is kept by REA itself (it names the backup path in its output).
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <button className="btn primary" onClick={applyPlan} disabled={Boolean(busy)}>
                  {busy === 'apply' ? 'Applying…' : `2 · Approve and apply`}
                </button>
                <button className="btn ghost" onClick={() => setPlan(null)} disabled={Boolean(busy)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* applied */}
      {applied && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>{applied.ok ? 'Applied' : 'Not applied'}</b>
            <span className="tiny">{fmtMs(applied.ms)}</span>
          </div>
          {!applied.ok && <div className="tiny" style={{ color: '#fca5a5', marginTop: 6 }}>{applied.error}</div>}
          {(applied.applied || []).map((a, i) => (
            <div key={i} className="tiny" style={{ marginTop: 6 }}>✓ {a.summary || a.id}</div>
          ))}
          {applied.stdout_tail ? (
            <details style={{ marginTop: 10 }}>
              <summary className="tiny">REA's own output</summary>
              <pre className="rea-log">{applied.stdout_tail}</pre>
            </details>
          ) : null}
          {applied.ok && (
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button className="btn primary" onClick={runVerify} disabled={Boolean(busy)}>
                {busy === 'verify' ? 'Verifying…' : '3 · Verify the installation'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* verify */}
      {verify && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>{verify.ok ? 'Verified' : 'Not verified yet'}</b>
            <Pill kind={verify.ok ? 'ok' : 'warn'}>{verify.ok ? 'ready' : 'incomplete'}</Pill>
          </div>
          <div className="rea-checks">
            <div className={`rea-check ${verify.registration?.present ? 'ok' : 'warn'}`}>
              {verify.registration?.present ? '✓' : '✗'} registration in <span className="kbd">{verify.registration?.file || 'config'}</span>
              {verify.registration?.reason ? <span className="tiny"> — {verify.registration.reason}</span> : null}
            </div>
            <div className={`rea-check ${verify.handshake?.ok ? 'ok' : 'warn'}`}>
              {verify.handshake?.ok ? '✓' : '✗'} MCP handshake
              {verify.handshake?.ok
                ? ` — ${verify.handshake.tools} tools, protocol ${verify.handshake.protocol || '?'}`
                : verify.handshake?.error ? ` — ${verify.handshake.error}` : ''}
            </div>
          </div>
          {verify.handshake?.ok && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>
                A few of what it can do: {(verify.handshake.sample_tools || []).slice(0, 8).join(', ')}…
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <button className="btn primary" onClick={register} disabled={Boolean(busy) || status?.registered}>
                  {status?.registered ? '4 · Already registered' : busy === 'connect' ? 'Registering…' : '4 · Register REA as an MCP server'}
                </button>
                <button className="btn" onClick={loadTools} disabled={Boolean(busy)}>
                  {busy === 'tools' ? 'Listing…' : 'Browse all tools'}
                </button>
              </div>
            </>
          )}
          {!verify.handshake?.ok && verify.handshake?.error ? (
            <div className="tiny" style={{ marginTop: 8, lineHeight: 1.6 }}>
              The handshake is the part that matters: it starts <span className="kbd">npx -y rea-agents@latest mcp</span> and asks for its tool list.
              If it fails right after apply, REA may still be downloading its package — try Verify again in a minute.
            </div>
          ) : null}
        </div>
      )}

      {/* connection + tools */}
      {status?.registered && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>Connected to ANTICODEX</b>
            <Pill kind="ok">mcp: rea</Pill>
          </div>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.7 }}>
            Chat and Codex can now call these tools. They are offered to the model as
            <span className="kbd"> mcp__rea__&lt;tool&gt;</span>, and — like every local MCP — only while the app runs on this machine.
          </div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn small" onClick={loadTools} disabled={Boolean(busy)}>Browse {status.probe?.tools || ''} tools</button>
          </div>
        </div>
      )}

      {tools?.ok && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="rea-card-head">
            <b>{tools.count} tools</b>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools" style={{ minWidth: 220 }} />
          </div>
          <div className="rea-tools">
            {shownTools.slice(0, 80).map((t) => (
              <button
                key={t.name}
                className={`rea-tool ${run.tool === t.name ? 'active' : ''}`}
                onClick={() => setRun({ tool: t.name, args: '{}', result: null, error: null, ms: null })}
                title={t.description || ''}
              >
                <span className="rea-tool-name">{t.name}</span>
                <span className="tiny rea-tool-desc">{(t.description || '').slice(0, 90)}</span>
              </button>
            ))}
          </div>
          {run.tool && (
            <div style={{ marginTop: 14 }}>
              <div className="tiny" style={{ marginBottom: 6 }}>
                Calling <span className="kbd">{run.tool}</span> with JSON arguments — this really runs, on this machine.
              </div>
              <textarea
                className="rea-args"
                value={run.args}
                spellCheck={false}
                onChange={(e) => setRun((r) => ({ ...r, args: e.target.value }))}
              />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn primary small" onClick={runTool} disabled={Boolean(busy)}>{busy === 'run' ? 'Running…' : 'Run tool'}</button>
                {run.ms != null && <span className="tiny">{fmtMs(run.ms)}</span>}
              </div>
              {run.error && <div className="tiny" style={{ color: '#fca5a5', marginTop: 8 }}>{run.error}</div>}
              {run.result && <pre className="rea-log">{JSON.stringify(run.result, null, 2).slice(0, 8000)}</pre>}
            </div>
          )}
        </div>
      )}

      {/* honest footnote */}
      <div className="tiny" style={{ marginTop: 20, lineHeight: 1.7, opacity: 0.75 }}>
        What this page will never do: run setup silently, run it without the plan you saw, or claim success
        without a handshake. If the plan changes between review and apply, the apply is refused and you see why.
      </div>
    </div>
  );
}
