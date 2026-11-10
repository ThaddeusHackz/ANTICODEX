import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Facts } from '../ui.jsx';

// The Library answers one question: "where did the thing I made go?".
// Records are written by the generators (images, video, sandbox output, exported
// skills, documents), so this page is a view over real entries — never a mock grid.

const TIME_FILTERS = [
  { id: '', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' }
];

function sinceFor(id) {
  if (!id) return undefined;
  const d = new Date();
  if (id === 'today') d.setHours(0, 0, 0, 0);
  if (id === 'week') d.setDate(d.getDate() - 7);
  if (id === 'month') d.setDate(d.getDate() - 30);
  return d.toISOString();
}

export default function LibraryPage() {
  const { notify } = useApp();
  const nav = useNavigate();
  const [summary, setSummary] = useState(null);
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    Promise.all([
      api.library.summary().catch(() => null),
      api.library.list({ kind: kind || undefined, q: q || undefined, since: sinceFor(when) }).catch((e) => ({ error: e.message, items: [] }))
    ]).then(([s, l]) => { setSummary(s); setData(l); }).finally(() => setBusy(false));
  }, [kind, q, when]);

  useEffect(() => { load(); }, [load]);

  const kinds = useMemo(() => (data?.kinds || []).filter((k) => k.count > 0 || k.id === kind), [data, kind]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="sub">
            Every artifact this workspace produced, with the surface that made it. Chat is where you ask; the Library is where the
            answer keeps existing after you close the tab.
          </p>
        </div>
        <div className="actions">
          <button className="btn small" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
          <button className="btn small primary" onClick={() => nav('/images')}>Create</button>
        </div>
      </div>

      <Facts items={[
        { k: 'Items', v: (summary?.total ?? 0).toLocaleString(), d: 'kept records' },
        { k: 'Kinds', v: Object.keys(summary?.by_kind || {}).length, d: 'image, video, code, skills…' },
        { k: 'Bytes', v: `${Math.round((summary?.bytes || 0) / 1024)} KB`, d: 'known sizes' },
        { k: 'Last write', v: summary?.updated_at ? new Date(summary.updated_at).toLocaleString() : '—', small: true }
      ]} />

      <div className="searchbar" style={{ marginTop: 18 }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, kinds and sources…" />
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Every kind</option>
          {(data?.kinds || []).map((k) => <option key={k.id} value={k.id}>{k.icon} {k.label}{k.count ? ` (${k.count})` : ''}</option>)}
        </select>
        <select className="select" value={when} onChange={(e) => setWhen(e.target.value)}>
          {TIME_FILTERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      <div className="row wrap" style={{ gap: 5, marginBottom: 12 }}>
        <button className={`chip ${kind === '' ? 'active' : ''}`} onClick={() => setKind('')}>All</button>
        {kinds.map((k) => (
          <button key={k.id} className={`chip ${kind === k.id ? 'active' : ''}`} onClick={() => setKind(k.id)}>
            {k.icon} {k.label} {k.count ? `· ${k.count}` : ''}
          </button>
        ))}
      </div>

      {data?.error && <div className="card" style={{ color: 'var(--danger)' }}>{data.error}</div>}

      {data && data.items?.length === 0 && !busy && (
        <div className="card empty" style={{ marginTop: 8 }}>
          Nothing here yet. Generate an image, render a video, run something in the Sandbox, or export a skill — each one writes a
          record that appears here.
          <div className="row" style={{ justifyContent: 'center', gap: 6, marginTop: 12 }}>
            <button className="btn small" onClick={() => nav('/images')}>Images</button>
            <button className="btn small" onClick={() => nav('/video')}>Video</button>
            <button className="btn small" onClick={() => nav('/sandbox')}>Sandbox</button>
            <button className="btn small" onClick={() => nav('/skills')}>Skills</button>
          </div>
        </div>
      )}

      <div className="grid cards" style={{ marginTop: 6 }}>
        {(data?.items || []).map((it) => (
          <div className="card tight" key={it.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="row" style={{ gap: 7 }}>
              <span className="pill">{it.kind}</span>
              <span className="tiny" style={{ marginLeft: 'auto' }}>{it.created_at ? new Date(it.created_at).toLocaleString() : ''}</span>
            </div>
            {it.thumb
              ? <img src={it.thumb} alt={it.title} style={{ width: '100%', borderRadius: 9, aspectRatio: '16/10', objectFit: 'cover' }} />
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 84, borderRadius: 9, background: 'var(--bg-input)', fontSize: 26 }}>
                  {(it.kind === 'video' ? '▶' : it.kind === 'image' ? '▦' : it.kind === 'audio' ? '♪' : it.kind === 'skill' ? '✦' : '▤')}
                </div>}
            <b style={{ fontSize: 13.5 }}>{it.title}</b>
            <div className="tiny" style={{ color: 'var(--muted)' }}>
              {it.source}{it.bytes ? ` · ${(it.bytes / 1024).toFixed(0)} KB` : ''}
            </div>
            <div className="row" style={{ gap: 5, marginTop: 'auto' }}>
              {it.url && <a className="btn small" href={it.url} target="_blank" rel="noreferrer">Open</a>}
              {it.path && !it.url && <span className="tiny mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.path}</span>}
              <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => {
                try { navigator.clipboard?.writeText(it.url || it.path || it.id); notify('Copied artifact reference'); } catch { /* ignore */ }
              }}>Copy ref</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
