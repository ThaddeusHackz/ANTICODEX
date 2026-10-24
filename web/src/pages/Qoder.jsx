import React, { useEffect, useMemo, useState } from 'react';
import { qoder as qoderApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Pill } from '../ui.jsx';

// Qoder — what of 49 public repositories this app can actually do.
//
// Three panels, in the order that answers the question:
//
//   1. the atlas — every repository, what it is, and what came out of it here
//      (a survey, so "not integrated" is said out loud instead of implied);
//   2. the local agent — `qodercli --acp`, driven over stdio JSON-RPC, only on
//      a machine that can spawn processes;
//   3. Cloud Agents — the Forward API, with the token kept on the server.
//
// The atlas is data (lib/qoder-repos.js); nothing on this page invents a
// capability that the code does not have.

const KIND_LABEL = {
  sdk: 'SDK', demo: 'Demo', action: 'GitHub Action', app: 'Application', tool: 'Tool',
  cli: 'CLI', eval: 'Eval set', bench: 'Benchmark', docs: 'Docs', changelog: 'Release notes',
  empty: 'Empty', unknown: 'Other'
};

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));

export default function QoderPage() {
  const { notify } = useApp();
  const [status, setStatus] = useState(null);
  const [atlas, setAtlas] = useState(null);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState('');

  const [probe, setProbe] = useState(null);
  const [acpText, setAcpText] = useState('Summarise this repository in one sentence.');
  const [acpRun, setAcpRun] = useState(null);

  const [cloud, setCloud] = useState({ probe: null, identities: null, templates: null, session: null, events: null });
  const [sessionTitle, setSessionTitle] = useState('ANTICODEX session');
  const [message, setMessage] = useState('');

  const [wf, setWf] = useState({ prompt: 'Review this pull request for bugs, security issues and missing tests.', version: '0.1.18', mcp: true, trigger: 'pull_request' });
  const [yaml, setYaml] = useState(null);

  useEffect(() => {
    let alive = true;
    qoderApi.status().then((r) => { if (alive) setStatus(r); }).catch((e) => setStatus({ ok: false, error: e.message }));
    qoderApi.repos().then((r) => { if (alive) setAtlas(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const repos = atlas?.repos || [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return repos
      .filter((r) => kind === 'all' || r.kind === kind)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.summary || '').toLowerCase().includes(q) || (r.tags || []).join(' ').toLowerCase().includes(q));
  }, [repos, filter, kind]);

  async function runAcpProbe() {
    setBusy('probe');
    try { setProbe(await qoderApi.acpProbe()); } catch (e) { setProbe({ ok: false, error: e.message }); }
    finally { setBusy(''); }
  }

  async function runAcpPrompt() {
    setBusy('acp');
    setAcpRun(null);
    try { setAcpRun(await qoderApi.acpPrompt(acpText, { allow_tools: false })); }
    catch (e) { setAcpRun({ ok: false, error: e.message }); }
    finally { setBusy(''); }
  }

  async function cloudProbe() {
    setBusy('cloud');
    try {
      const r = await qoderApi.whoami();
      setCloud((c) => ({ ...c, probe: r }));
    } catch (e) { notify(e.message, 'warn'); }
    finally { setBusy(''); }
  }

  async function loadCloudLists() {
    setBusy('cloud');
    try {
      const [identities, templates] = await Promise.all([
        qoderApi.identities({ limit: 10 }).catch((e) => ({ ok: false, error: e.message })),
        qoderApi.templates({ limit: 10 }).catch((e) => ({ ok: false, error: e.message }))
      ]);
      setCloud((c) => ({ ...c, identities, templates }));
    } finally { setBusy(''); }
  }

  async function createSession() {
    const identityId = cloud.identities?.items?.[0]?.id;
    const templateId = cloud.templates?.items?.[0]?.id;
    if (!identityId || !templateId) return notify('Run "Load identities and templates" first — a session needs both.', 'warn');
    setBusy('cloud');
    try {
      const r = await qoderApi.sessions({ method: 'create', identity_id: identityId, template_id: templateId, title: sessionTitle });
      if (r.ok) notify('Session created'); else notify(r.error || 'Could not create the session', 'warn');
      setCloud((c) => ({ ...c, session: r.session || null }));
    } finally { setBusy(''); }
  }

  async function sendMessage() {
    if (!cloud.session?.id) return notify('Create a session first', 'warn');
    setBusy('cloud');
    try {
      const r = await qoderApi.send(cloud.session.id, message);
      if (!r.ok) notify(r.error || 'Send failed', 'warn');
      const events = await qoderApi.events(cloud.session.id);
      setCloud((c) => ({ ...c, events }));
    } finally { setBusy(''); }
  }

  async function pollStream() {
    if (!cloud.session?.id) return;
    setBusy('cloud');
    try {
      const r = await qoderApi.stream(cloud.session.id, 6000);
      setCloud((c) => ({ ...c, events: { ok: r.ok, items: r.events || [], note: r.note || r.error } }));
    } finally { setBusy(''); }
  }

  async function makeWorkflow() {
    setBusy('wf');
    try { setYaml(await qoderApi.workflow(wf)); } catch (e) { notify(e.message, 'warn'); }
    finally { setBusy(''); }
  }

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); notify('Copied'); }
    catch { notify('Clipboard is blocked here — select the text instead', 'warn'); }
  };

  const tally = atlas?.tally;

  return (
    <div className="page">
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Qoder</h1>
          <p className="muted" style={{ margin: '4px 0 0', maxWidth: '74ch' }}>
            All 49 public QoderAI repositories surveyed, with the seven that define a machine-readable
            contract wired into this app: the Cloud Agents SDKs, the ACP demos, the GitHub Action and the
            Forward quickstart. The rest are release notes and empty placeholders, and say so.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Pill kind={status?.configured ? 'ok' : 'warn'}>{status?.configured ? `Cloud key: ${status.source}` : 'no Cloud key'}</Pill>
          <Pill kind={status?.cli?.found ? 'ok' : 'warn'}>{status?.cli?.found ? `qodercli ${status.cli.version || ''}` : 'qodercli not found'}</Pill>
          <Pill kind={status?.local ? 'ok' : 'warn'}>{status?.local ? 'local' : 'hosted'}</Pill>
        </div>
      </div>

      {status && !status.configured && (
        <div className="card" style={{ marginTop: 16 }}>
          <b>Cloud Agents needs a Qoder personal access token.</b>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
            Add <span className="kbd">QODER_PAT</span> in Settings → Keys (or put it in the environment). It stays on the
            server: this page calls the bridge, and the bridge calls Qoder. Without it, the local agent panel and the
            atlas still work.
          </div>
        </div>
      )}

      {/* 1 — the local agent */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="rea-card-head">
          <b>Local agent — qodercli over ACP</b>
          <div className="row" style={{ gap: 6 }}>
            <Pill kind={status?.cli?.found ? 'ok' : 'warn'}>{status?.cli?.found ? 'installed' : 'missing'}</Pill>
            <button className="btn small" onClick={runAcpProbe} disabled={Boolean(busy) || !status?.local}>
              {busy === 'probe' ? 'Handshaking…' : 'ACP handshake'}
            </button>
          </div>
        </div>
        <div className="tiny" style={{ marginTop: 6, lineHeight: 1.7 }}>
          Starts <span className="kbd">qodercli --acp</span> and speaks newline-delimited JSON-RPC to it: initialize,
          session/new, session/prompt. Permission requests come back as JSON-RPC requests, and this host refuses them —
          the agent cannot run a tool behind your back.
          {!status?.cli?.found && status?.cli?.install ? <> Install with <span className="kbd">{status.cli.install}</span>.</> : null}
        </div>

        {probe && (
          <div style={{ marginTop: 10 }}>
            {probe.ok ? (
              <div className="tiny" style={{ lineHeight: 1.7 }}>
                ✓ {probe.agent?.title || probe.agent?.name || 'qodercli'} {probe.agent?.version || ''} · ACP {String(probe.protocol)} · {probe.ms} ms
                {probe.auth_methods?.length
                  ? <div style={{ color: '#fcd34d', marginTop: 4 }}>Not signed in — run <span className="kbd">{probe.auth_methods[0].name}</span> on this machine first.</div>
                  : <div style={{ color: '#6ee7a8', marginTop: 4 }}>Signed in — a session can be created.</div>}
              </div>
            ) : (
              <div className="tiny" style={{ color: '#fca5a5', lineHeight: 1.6 }}>{probe.error}</div>
            )}
            {probe.capabilities && (
              <div className="tiny" style={{ marginTop: 6, opacity: 0.7 }}>
                Capabilities: {Object.keys(probe.capabilities).join(', ')}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <textarea
            value={acpText}
            onChange={(e) => setAcpText(e.target.value)}
            spellCheck={false}
            rows={3}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
          />
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button className="btn primary small" onClick={runAcpPrompt} disabled={Boolean(busy) || !status?.local}>
              {busy === 'acp' ? 'Running…' : 'Ask qodercli'}
            </button>
            <span className="tiny">Runs in a temporary directory; no tools are allowed.</span>
          </div>
        </div>

        {acpRun && (
          <div style={{ marginTop: 10 }}>
            {acpRun.ok ? (
              <>
                <div className="tiny" style={{ marginBottom: 4 }}>
                  {(acpRun.ms / 1000).toFixed(1)} s · {acpRun.chunks} chunk(s) · stop: {acpRun.stop_reason || 'n/a'}
                  {acpRun.tools_requested ? ` · ${acpRun.tools_requested} tool request(s) refused` : ''}
                </div>
                <pre className="rea-log">{acpRun.text || '(no text — see the raw updates)'}</pre>
                {acpRun.updates?.length ? (
                  <details style={{ marginTop: 8 }}>
                    <summary className="tiny">Streamed updates</summary>
                    <pre className="rea-log">{JSON.stringify(acpRun.updates.slice(0, 40), null, 1)}</pre>
                  </details>
                ) : null}
              </>
            ) : (
              <div className="tiny" style={{ color: '#fca5a5', lineHeight: 1.6 }}>{acpRun.error}</div>
            )}
          </div>
        )}
      </div>

      {/* 2 — Cloud Agents */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="rea-card-head">
          <b>Qoder Cloud Agents — Forward API</b>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" onClick={cloudProbe} disabled={Boolean(busy) || !status?.configured}>Test key</button>
            <button className="btn small" onClick={loadCloudLists} disabled={Boolean(busy) || !status?.configured}>Load identities and templates</button>
          </div>
        </div>
        <div className="tiny" style={{ marginTop: 6, lineHeight: 1.7 }}>
          The order is the one <span className="kbd">forward-quickstart</span> uses: an end-user identity, a template,
          then a session — and messages travel as <span className="kbd">user.message</span> events. Base URL{' '}
          <span className="kbd">{status?.cloud?.base || 'https://api.qoder.com'}</span>.
        </div>

        {cloud.probe && (
          <div className="tiny" style={{ marginTop: 8, color: cloud.probe.ok ? '#6ee7a8' : '#fca5a5' }}>
            {cloud.probe.ok ? `✓ key works — ${cloud.probe.items?.length ?? 0} template(s) visible` : cloud.probe.error}
          </div>
        )}

        {cloud.identities && (
          <div className="tiny" style={{ marginTop: 8, lineHeight: 1.7 }}>
            Identities: <b>{(cloud.identities.items || []).length}</b>
            {(cloud.identities.items || []).slice(0, 3).map((i) => <div key={i.id} style={{ opacity: 0.75 }}>· {i.external_id || i.name || i.id}</div>)}
            {cloud.identities.ok === false ? <div style={{ color: '#fca5a5' }}>{cloud.identities.error}</div> : null}
            Templates: <b>{(cloud.templates?.items || []).length}</b>
            {(cloud.templates?.items || []).slice(0, 3).map((t) => <div key={t.id} style={{ opacity: 0.75 }}>· {t.name || t.id}</div>)}
          </div>
        )}

        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <input value={sessionTitle} onChange={(e) => setSessionTitle(e.target.value)} style={{ minWidth: 220 }} aria-label="Session title" />
          <button className="btn small" onClick={createSession} disabled={Boolean(busy) || !status?.configured}>Create session</button>
          {cloud.session?.id && <span className="tiny">session <span className="kbd">{cloud.session.id}</span></span>}
        </div>

        {cloud.session?.id && (
          <div style={{ marginTop: 12 }}>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Message the agent…" style={{ width: '100%', fontSize: 12 }} />
            <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary small" onClick={sendMessage} disabled={Boolean(busy) || !message.trim()}>Send event</button>
              <button className="btn small" onClick={() => qoderApi.events(cloud.session.id).then((r) => setCloud((c) => ({ ...c, events: r })))} disabled={Boolean(busy)}>List events</button>
              <button className="btn small" onClick={pollStream} disabled={Boolean(busy)}>Read stream (6 s)</button>
            </div>
            {cloud.events && (
              <div style={{ marginTop: 8 }}>
                {cloud.events.ok === false && <div className="tiny" style={{ color: '#fca5a5' }}>{cloud.events.error}</div>}
                <pre className="rea-log">{JSON.stringify((cloud.events.items || cloud.events.events || []).slice(0, 20), null, 1)}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3 — GitHub Action */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="rea-card-head">
          <b>GitHub Action — from qoderAI/qoder-action</b>
          <button className="btn small" onClick={makeWorkflow} disabled={Boolean(busy)}>{busy === 'wf' ? 'Generating…' : 'Generate workflow'}</button>
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
          <select value={wf.trigger} onChange={(e) => setWf({ ...wf, trigger: e.target.value })} aria-label="Trigger">
            <option value="pull_request">pull_request</option>
            <option value="issue_comment">issue_comment (@qoder)</option>
            <option value="workflow_dispatch">workflow_dispatch</option>
          </select>
          <input value={wf.version} onChange={(e) => setWf({ ...wf, version: e.target.value })} style={{ width: 90 }} aria-label="qodercli version" />
          <label className="tiny" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={wf.mcp} onChange={(e) => setWf({ ...wf, mcp: e.target.checked })} /> qoder-github MCP
          </label>
        </div>
        <textarea
          value={wf.prompt}
          onChange={(e) => setWf({ ...wf, prompt: e.target.value })}
          rows={2}
          style={{ width: '100%', marginTop: 8, fontSize: 12 }}
          aria-label="Action prompt"
        />
        {yaml && (
          <>
            <div className="row between" style={{ marginTop: 8 }}>
              <span className="tiny">Write this to <span className="kbd">{yaml.path}</span> and add the secret <span className="kbd">QODER_PERSONAL_ACCESS_TOKEN</span>.</span>
              <button className="btn small ghost" onClick={() => copy(yaml.yaml)}>Copy YAML</button>
            </div>
            <pre className="rea-log">{yaml.yaml}</pre>
          </>
        )}
      </div>

      {/* 4 — the atlas */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="rea-card-head">
          <b>The 49 repositories</b>
          <div className="row" style={{ gap: 6 }}>
            {tally && <Pill kind="ok">{tally.integrated} integrated</Pill>}
            {tally && <Pill>{tally.empty} empty</Pill>}
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" style={{ minWidth: 180 }} />
          </div>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {['all', ...Object.keys(tally?.byKind || {})].map((k) => (
            <button key={k} className={`btn small ${kind === k ? 'primary' : 'ghost'}`} onClick={() => setKind(k)}>
              {k === 'all' ? `all (${tally?.total ?? 0})` : `${KIND_LABEL[k] || k} (${tally?.byKind?.[k] ?? 0})`}
            </button>
          ))}
        </div>

        <div className="grid-2" style={{ marginTop: 14 }}>
          {shown.map((r) => (
            <div key={r.name} className="card" style={{ padding: 12 }}>
              <div className="row between" style={{ gap: 8 }}>
                <a href={r.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</a>
                <span className="tiny" style={{ opacity: 0.7 }}>★ {fmt(r.stars)}</span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <Pill kind={r.integrated ? 'ok' : undefined}>{r.integrated ? 'integrated' : (KIND_LABEL[r.kind] || r.kind)}</Pill>
                {r.language && <span className="tiny" style={{ opacity: 0.6 }}>{r.language}</span>}
                {r.size_kb ? <span className="tiny" style={{ opacity: 0.45 }}>{fmt(r.size_kb)} KB</span> : null}
              </div>
              <div className="tiny" style={{ marginTop: 8, lineHeight: 1.6 }}>{r.summary}</div>
              <div className="tiny" style={{ marginTop: 6, lineHeight: 1.6, opacity: 0.75 }}><b>In ANTICODEX:</b> {r.use}</div>
            </div>
          ))}
        </div>
        {!shown.length && <div className="tiny" style={{ marginTop: 12 }}>Nothing matches that filter.</div>}
      </div>

      <div className="tiny" style={{ marginTop: 18, lineHeight: 1.7, opacity: 0.75 }}>
        Surveyed from the GitHub API on 2026-10-24: 49 repositories, 7 integrated, 6 empty, 25 release-note
        repositories. The ACP client and the Cloud Agents client are implemented here rather than imported, so both
        stay dependency-free and auditable.
      </div>
    </div>
  );
}
