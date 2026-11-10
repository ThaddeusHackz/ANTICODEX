import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Facts, StatusPill } from '../ui.jsx';

// Public APIs — Glasser's replacement, and the page that makes the agent's
// `public_api` tool legible.
//
// Glasser sold "reach for this when a task needs external data" per call. This is
// the same job from public-apis (MIT): 2,335 free endpoints, 1,136 with no auth at
// all. The page is a browser for that catalogue plus a real "call it" button, so a
// result can be seen before an agent is trusted with it.
//
// Two honesty rules the page keeps:
//   * `auth: unknown` is shown as unknown, never as "free" — an empty cell in the
//     upstream table is not a promise that no key is needed;
//   * a call that needs a key is refused with the reason and the alternative free
//     endpoints in the same category, instead of an opaque 401.

const AUTH_LABEL = {
  none: { text: 'no key', pill: 'ok' },
  apiKey: { text: 'key', pill: 'warn' },
  oauth: { text: 'oauth', pill: 'warn' },
  'user-agent': { text: 'user-agent', pill: 'warn' },
  unknown: { text: 'unknown', pill: '' }
};

export default function ApisPage() {
  const { notify } = useApp();
  const nav = useNavigate();
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('');
  const [authFilter, setAuthFilter] = useState('');
  const [ssl, setSsl] = useState(false);
  const [cors, setCors] = useState(false);
  const [calling, setCalling] = useState(false);
  const [path, setPath] = useState('');
  const [callResult, setCallResult] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.publicApis.stats().then(setStats).catch((e) => notify(e.message));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (term) => {
    setBusy(true);
    try {
      const r = await api.publicApis.search(term || q, {
        limit: 30, category: category || undefined, auth: authFilter || undefined,
        https: ssl ? true : undefined, cors: cors ? true : undefined
      });
      setResult(r);
      if (!term) setSelected(r.entries?.[0] || null);
    } catch (e) { notify(e.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { search(''); }, []);  // first paint is a browse, not an empty page

  async function callIt(entry) {
    setCalling(true);
    setCallResult(null);
    try {
      const r = await api.publicApis.call(entry.id, { path: path || undefined });
      setCallResult(r);
    } catch (e) {
      setCallResult({ ok: false, error: e.message });
      notify(e.message);
    } finally { setCalling(false); }
  }

  const cats = useMemo(() => Object.entries(stats?.by_category || {}).sort((a, b) => b[1] - a[1]), [stats]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Public APIs</h1>
          <p className="sub">
            {stats?.count ? <><b>{stats.count.toLocaleString()}</b> free endpoints in {stats.categories} categories, from the{' '}
              <a href="https://github.com/public-apis/public-apis" target="_blank" rel="noreferrer">public-apis</a> catalogue (MIT).{' '}</> : 'Loading the catalogue… '}
            The agent reaches these with the <code className="code-inline">public_api</code> tool — search in words, then call an id. No broker, no per-call fee.
          </p>
        </div>
        <div className="actions">
          <button className="btn small primary" onClick={() => nav('/agent')}>Use it in the agent</button>
        </div>
      </div>

      <Facts items={[
        { k: 'Endpoints', v: stats?.count ?? '—', d: `${stats?.categories ?? '—'} categories` },
        { k: 'No key needed', v: stats?.no_auth ?? '—', d: 'callable right now' },
        { k: 'HTTPS', v: stats?.tls?.https ?? '—', d: `${stats?.tls?.plain_http ?? 0} are plain http` },
        { k: 'CORS', v: stats?.cors?.allows_browser ?? '—', d: 'usable from a browser' },
        { k: 'Source', v: stats?.source?.commit ? String(stats.source.commit).slice(0, 8) : 'pinned', d: stats?.generated_at ? new Date(stats.generated_at).toLocaleDateString() : '' }
      ]} />

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(q); }}
            placeholder="What data do you need? e.g. exchange rates, holidays, ip geolocation"
            style={{ flex: 1, minWidth: 260, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: '9px 11px', fontSize: 13 }}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '9px 11px', fontSize: 12.5 }}>
            <option value="">All categories</option>
            {cats.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
          </select>
          <select value={authFilter} onChange={(e) => setAuthFilter(e.target.value)} style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 10, padding: '9px 11px', fontSize: 12.5 }}>
            <option value="">Any auth</option>
            <option value="none">No key</option>
            <option value="apiKey">API key</option>
            <option value="oauth">OAuth</option>
          </select>
          <label className="tiny row" style={{ gap: 5, alignItems: 'center' }}><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> HTTPS only</label>
          <label className="tiny row" style={{ gap: 5, alignItems: 'center' }}><input type="checkbox" checked={cors} onChange={(e) => setCors(e.target.checked)} /> browser-safe</label>
          <button className="btn small" onClick={() => search(q)} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
        </div>
        {result && <div className="tiny" style={{ marginTop: 6 }}>{result.total ? `${result.total.toLocaleString()} match${result.total === 1 ? '' : 'es'}${result.query ? ` for “${result.query}”` : ' — browsing all'}` : (result.note || 'No match. Try fewer words.')}</div>}
      </div>

      <div className="section split" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
        <div>
          <div className="card">
            <div className="card-head"><h3>Catalogue</h3><div className="right"><span className="pill">{result?.entries?.length || 0} shown</span></div></div>
            {(result?.entries || []).map((e) => {
              const a = AUTH_LABEL[e.auth] || { text: e.auth, pill: '' };
              return (
                <button
                  key={e.id}
                  onClick={() => { setSelected(e); setCallResult(null); setPath(''); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid var(--border)', background: selected?.id === e.id ? 'var(--bg-input)' : 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer' }}
                >
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b style={{ fontSize: 12.8 }}>{e.name}</b>
                    <span className={`pill ${a.pill}`}>{a.text}</span>
                    {e.https === false && <span className="pill err">http</span>}
                    {e.cors === true && <span className="pill tiny">cors</span>}
                    <div className="between" />
                    <span className="tiny">{e.category}</span>
                  </div>
                  <div className="tiny" style={{ marginTop: 2, opacity: .85 }}>{e.description}</div>
                </button>
              );
            })}
            {!result?.entries?.length && <div className="empty">{busy ? 'Searching…' : 'Nothing matched. Try a broader word, or clear the filters.'}</div>}
          </div>
        </div>

        <div>
          {!selected && <div className="card"><div className="empty">Pick an endpoint to see its address and call it.</div></div>}
          {selected && (
            <div className="card">
              <div className="card-head"><h3>{selected.name}</h3><div className="right"><span className={`pill ${(AUTH_LABEL[selected.auth] || {}).pill || ''}`}>{(AUTH_LABEL[selected.auth] || {}).text || selected.auth}</span></div></div>
              <div className="tiny" style={{ marginBottom: 6 }}>{selected.description}</div>
              <div className="tiny" style={{ marginBottom: 2 }}>Base address</div>
              <code className="code-inline" style={{ display: 'block', wordBreak: 'break-all', fontSize: 11.5 }}>{selected.url}</code>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/optional/path?query=1"
                  style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', padding: '7px 9px', fontSize: 12, fontFamily: 'var(--mono)' }}
                />
                <button className="btn small primary" onClick={() => callIt(selected)} disabled={calling}>{calling ? 'Calling…' : 'GET'}</button>
              </div>
              <div className="tiny" style={{ marginTop: 4 }}>
                A GET only, 15 s timeout, 400 KB cap. Private, loopback and metadata addresses are refused by the bridge.
              </div>
              {callResult && (
                <div style={{ marginTop: 10 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                    <StatusPill status={callResult.ok ? 'live' : 'missing'} />
                    {callResult.status != null && <span className={`pill ${callResult.ok ? 'ok' : 'err'}`}>HTTP {callResult.status}</span>}
                    {callResult.duration_ms != null && <span className="pill">{callResult.duration_ms} ms</span>}
                    {callResult.bytes != null && <span className="pill">{callResult.bytes} B</span>}
                    {callResult.insecure && <span className="pill warn">plain http</span>}
                  </div>
                  {callResult.error && <div className="tiny" style={{ color: 'var(--danger)', marginTop: 6 }}>{callResult.error}</div>}
                  {callResult.hint && <div className="tiny" style={{ marginTop: 4 }}>{callResult.hint}</div>}
                  {callResult.alternative && <div className="tiny" style={{ marginTop: 4 }}>{callResult.alternative}</div>}
                  {callResult.body !== undefined && (
                    <pre style={{ margin: '8px 0 0', padding: 9, background: 'var(--bg-input)', borderRadius: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {typeof callResult.body === 'string' ? callResult.body.slice(0, 4000) : JSON.stringify(callResult.body, null, 2).slice(0, 4000)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="card" style={{ marginTop: 10 }}>
            <div className="card-head"><h3>How the agent uses it</h3></div>
            <div className="tiny" style={{ lineHeight: 1.7 }}>
              The model is given one tool, <code className="code-inline">public_api</code>, with three operations: search, call and
              categories. It searches in plain words, then calls the exact id it was given. If an endpoint needs a key it is told
              which one and offered free alternatives in the same category — it never invents a key. This replaced the Glasser MCP
              server: same job, no per-call cost, no vendor in the middle.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
