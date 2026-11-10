import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api.js';
import { StatusPill, Facts } from '../ui.jsx';

const GROUPS = [
  { id: 'chat', label: 'Chat', note: 'the conversation surface' },
  { id: 'agent', label: 'Agent', note: 'how work gets planned and carried out' },
  { id: 'workspace', label: 'Workspace', note: 'files, editor, tree' },
  { id: 'safety', label: 'Safety', note: 'sandboxing, approvals, policy' },
  { id: 'extend', label: 'Extend', note: 'skills, MCP, plugins, hooks' },
  { id: 'platform', label: 'Platform', note: 'config, auth, control plane, cloud' }
];

export default function ParityPage() {
  const [map, setMap] = useState(null);
  const [err, setErr] = useState(null);
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [crate, setCrate] = useState(null);
  const nav = useNavigate();

  useEffect(() => {
    api.codexMap.map().then(setMap).catch((e) => setErr(e.message));
  }, []);

  const rows = useMemo(() => {
    let list = map?.rows || [];
    if (group) list = list.filter((r) => r.group === group);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((r) => `${r.label} ${r.parity} ${r.gap || ''} ${r.crates.join(' ')} ${r.files.join(' ')}`.toLowerCase().includes(term));
    }
    return list;
  }, [map, group, q]);

  if (err) return <div className="page"><div className="card">Could not load the parity map: {err}</div></div>;
  if (!map) return <div className="page"><div className="empty">Reading the sweep…</div></div>;

  const tally = map.tally || {};

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Codex parity</h1>
          <p className="sub">
            The claim is “an exact clone of Codex”. This page is how that claim is checked: every surface this app ships, the upstream
            crates that implement the same job in <a href={map.source.url} target="_blank" rel="noreferrer">openai/codex</a> at{' '}
            <code className="code-inline">{String(map.source.commit).slice(0, 10)}</code>, the file here that reimplements it, and — in
            the same row — what is still different. If the file is missing, the row says so.
          </p>
        </div>
      </div>

      <Facts items={[
        { k: 'Surfaces', v: map.rows.length, d: 'traced to upstream' },
        { k: 'Implemented', v: tally.parity || 0, d: 'every file present' },
        { k: 'Partial', v: tally.partial || 0, d: 'limit named' },
        { k: 'Missing', v: tally.missing || 0, d: 'not built yet' },
        { k: 'Upstream crates', v: map.counts?.crates ?? 0, d: `${(map.source.counts?.source_bytes / 1024 / 1024).toFixed(1)} MB of Rust` },
        { k: 'Swept', v: new Date(map.source.generated_at).toLocaleDateString(), d: `${map.source.repo}@${map.source.ref}` }
      ]} />

      <div className="searchbar" style={{ marginTop: 18 }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by surface, crate, file or limit…" />
        <button className={`chip ${group === '' ? 'active' : ''}`} onClick={() => setGroup('')}>All</button>
        {GROUPS.map((g) => (
          <button key={g.id} className={`chip ${group === g.id ? 'active' : ''}`} onClick={() => setGroup(g.id)} title={g.note}>
            {g.label}
          </button>
        ))}
      </div>

      <table className="tbl">
        <thead>
          <tr><th style={{ width: '16%' }}>Surface</th><th style={{ width: '15%' }}>Status</th><th style={{ width: '24%' }}>Upstream crates</th><th>What “the same” means here</th><th style={{ width: '22%' }}>Still different</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.label}</b>
                <div className="tiny">{r.group}</div>
                {r.route && <button className="btn small ghost" style={{ marginTop: 4 }} onClick={() => nav(r.route)}>Open {r.route}</button>}
              </td>
              <td><StatusPill status={r.status} /><div className="tiny" style={{ marginTop: 3 }}>{r.present.length}/{r.files.length} files</div></td>
              <td>
                <div className="row wrap" style={{ gap: 3 }}>
                  {r.crates.map((c) => (
                    <button key={c} className="pill" style={{ cursor: 'pointer' }} onClick={() => api.codexMap.crate(c.replace(/::.*$/, '').split(' ')[0]).then((d) => d.ok && setCrate(d)).catch(() => {})}>{c}</button>
                  ))}
                </div>
              </td>
              <td style={{ fontSize: 12.5 }}>{r.parity}</td>
              <td className="tiny">{r.gap || <span style={{ color: 'var(--ok)' }}>none recorded</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && <div className="empty">Nothing matches that filter.</div>}

      <div className="section">
        <h2>Largest upstream crates</h2>
        <table className="tbl">
          <thead><tr><th>Crate</th><th>Kind</th><th className="num">Rust files</th><th className="num">Size</th><th>Modules declared</th></tr></thead>
          <tbody>
            {(map.biggest || []).map((c) => (
              <tr key={c.name}>
                <td><b>{c.name}</b></td>
                <td><span className="pill">{c.kind}</span></td>
                <td className="num">{c.source_files}</td>
                <td className="num">{c.kb.toLocaleString()} KB</td>
                <td className="tiny">{c.modules ? `${c.modules} modules` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Named, not quietly dropped</h2>
        <div className="card">
          <p className="tiny" style={{ marginTop: 0 }}>Upstream crates with no equivalent here. They are listed because a parity page that only lists wins is a brochure.</p>
          <div className="row wrap" style={{ gap: 5 }}>
            {(map.unported || []).map((u) => <span className="pill warn" key={u}>{u}</span>)}
          </div>
        </div>
      </div>

      {crate && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setCrate(null)}>
          <div className="modal" style={{ width: 'min(720px, 100%)' }}>
            <div className="modal-head">{crate.crate.name}</div>
            <div className="modal-body">
              <Facts cols={3} items={[
                { k: 'Kind', v: crate.crate.kind },
                { k: 'Rust files', v: crate.crate.source_files },
                { k: 'Size', v: `${Math.round(crate.crate.source_bytes / 1024)} KB` }
              ]} />
              {crate.crate.modules?.length ? (
                <>
                  <h3 style={{ fontSize: 13, marginTop: 14 }}>Modules ({crate.crate.modules.length})</h3>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {crate.crate.modules.map((m) => <span className="pill mono" key={m}>{m}</span>)}
                  </div>
                </>
              ) : null}
              <h3 style={{ fontSize: 13, marginTop: 14 }}>Surfaces here that claim it</h3>
              {crate.surfaces.length === 0 ? <div className="tiny">None — this crate has no equivalent in the map.</div> : (
                <table className="tbl">
                  <tbody>
                    {crate.surfaces.map((s) => (
                      <tr key={s.id}>
                        <td><b>{s.label}</b></td>
                        <td><StatusPill status={s.status} /></td>
                        <td className="mono tiny">{s.present.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="btn" style={{ marginTop: 14 }} onClick={() => setCrate(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
