import React, { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Pill } from '../ui.jsx';

// Model health — "why is this model not in the list, and why is that one slow?"
//
// The picker hides two kinds of model, and both used to be invisible:
//
//   rejected    the provider answered "no such model" when it was called. That is
//               the exact sentence users reported ("there is nothing like this
//               model available"), so those ids stop being offered.
//   unverified  a catalog guess that a provider with a live model list did not
//               list. Offering those is how the rejected ones got picked at all.
//
// This page lists every id the app has actually used (with latency), shows what
// is hidden and why, can put an id back, and can spend eight tokens proving one
// works rather than guessing.

const fmtLatency = (ms) => {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

const STATE_COPY = {
  ok: { label: 'answered', kind: 'ok' },
  missing: { label: 'rejected', kind: 'warn' },
  key: { label: 'key rejected', kind: 'warn' },
  quota: { label: 'quota', kind: 'warn' },
  network: { label: 'unreachable', kind: 'warn' },
  retry: { label: 'server error', kind: 'warn' },
  error: { label: 'failed', kind: 'warn' }
};

export default function ModelHealthPanel({ notify }) {
  const { model } = useApp();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(null);
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState(null);
  const [q, setQ] = useState('');

  async function load() {
    setBusy('load');
    try {
      const [h, m] = await Promise.all([
        api.modelHealth.list(),
        api.models({ include_hidden: true })
      ]);
      setData(h);
      setHidden(m.picker?.hidden || null);
    } catch (e) { notify?.('Could not read model health: ' + e.message); }
    finally { setBusy(''); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const list = data?.models || [];
    const needle = q.trim().toLowerCase();
    return list.filter((r) => !needle || `${r.ref} ${r.state}`.toLowerCase().includes(needle));
  }, [data, q]);

  async function forget(ref) {
    try {
      const r = await api.modelHealth.clear(ref);
      setData((d) => ({ ...d, summary: r.summary, models: (d.models || []).filter((m) => m.ref !== ref) }));
      notify?.(`Forgot the verdict for ${ref} — it is offered again.`);
    } catch (e) { notify?.('Could not forget: ' + e.message); }
  }

  async function tryModel(ref) {
    const [provider, ...rest] = ref.split('::');
    setBusy(`probe:${ref}`);
    setProbe(null);
    try {
      const r = await api.modelHealth.probe([{ provider, model: rest.join('::') || provider }]);
      setProbe({ ref, ...(r.results?.[0] || { ok: false, error: r.error }) });
      await load();
    } catch (e) { setProbe({ ref, ok: false, error: e.message }); }
    finally { setBusy(''); }
  }

  const summary = data?.summary;
  const currentRef = model || '';

  return (
    <div>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Model health</h3>
          <div className="tiny" style={{ marginTop: 4, maxWidth: '70ch', lineHeight: 1.55 }}>
            Models the app has actually called. A provider that answers “no such model” gets that id hidden from
            the picker — here is where it is listed, with the sentence the provider used.
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small ghost" onClick={load} disabled={Boolean(busy)}>{busy === 'load' ? 'reading…' : '↻ Refresh'}</button>
        </div>
      </div>

      {summary && (
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Pill kind="ok">{summary.tracked} tracked</Pill>
          <Pill kind="ok">{summary.ok} answered</Pill>
          <Pill kind={summary.missing ? 'warn' : 'ok'}>{summary.missing} rejected</Pill>
          {summary.fastest && <Pill kind="ok">fastest {fmtLatency(summary.fastest.latency_ms)}</Pill>}
          {summary.slowest && <Pill kind={summary.slowest.latency_ms > 20000 ? 'warn' : 'ok'}>slowest {fmtLatency(summary.slowest.latency_ms)}</Pill>}
        </div>
      )}

      {probe && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="tiny" style={{ lineHeight: 1.6 }}>
            <b>{probe.ref}</b>{' '}
            {probe.ok
              ? <>answered in {fmtLatency(probe.ms)} — it works, and it is back in the picker.</>
              : <>failed after {fmtLatency(probe.ms)}: {probe.error} <span className="kbd">{probe.state}</span></>}
          </div>
        </div>
      )}

      {hidden && hidden.count > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="row between">
            <b style={{ fontSize: 13 }}>Hidden from the picker</b>
            <span className="tiny">{hidden.rejected} rejected · {hidden.unverified} unlisted</span>
          </div>
          <div className="mh-hidden">
            {(hidden.models || []).map((m) => (
              <div key={`${m.provider}:${m.id}`} className="mh-row">
                <span className="mh-ref">{m.provider}::{m.id}</span>
                <Pill kind="warn">{m.hidden_because === 'rejected' ? 'rejected' : 'not listed'}</Pill>
                <span className="tiny mh-why">{m.reason || ''}</span>
              </div>
            ))}
            {(hidden.models || []).length < hidden.count && (
              <div className="tiny" style={{ opacity: 0.6, marginTop: 6 }}>…and {hidden.count - hidden.models.length} more.</div>
            )}
          </div>
          <div className="tiny" style={{ marginTop: 8, lineHeight: 1.55, opacity: 0.8 }}>
            Nothing was deleted. “Rejected” entries return by themselves the moment a call to them succeeds, or after
            12 hours, or when you forget the verdict below.
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter used models" style={{ maxWidth: 320 }} />
      </div>

      <div className="card" style={{ marginTop: 10, padding: 0 }}>
        {!data && <div className="tiny" style={{ padding: 14 }}>Reading…</div>}
        {data && rows.length === 0 && (
          <div className="tiny" style={{ padding: 14, lineHeight: 1.6 }}>
            Nothing has been called yet. Send one message and this fills in — including how long the first token took,
            which is the number that explains “it takes sooo long”.
          </div>
        )}
        {rows.slice(0, 200).map((r) => {
          const copy = STATE_COPY[r.state] || { label: r.state || 'unknown', kind: 'warn' };
          const isCurrent = r.ref === currentRef;
          return (
            <div key={r.ref} className={`mh-row ${isCurrent ? 'cur' : ''}`}>
              <span className="mh-ref" title={r.last_error || ''}>{r.ref}</span>
              <Pill kind={copy.kind}>{copy.label}</Pill>
              <span className="tiny mh-time" title="last answer">{fmtLatency(r.latency_ms)}</span>
              <span className="tiny mh-time" title="first token">{r.first_token_ms != null ? `first ${fmtLatency(r.first_token_ms)}` : ''}</span>
              <span className="tiny mh-checks">{r.checks || 0}×</span>
              <div style={{ flex: 1 }} />
              <button className="btn small ghost" onClick={() => tryModel(r.ref)} disabled={Boolean(busy)}>
                {busy === `probe:${r.ref}` ? 'testing…' : 'Test'}
              </button>
              <button className="btn small ghost" onClick={() => forget(r.ref)} disabled={Boolean(busy)} title="Forget this verdict">Forget</button>
            </div>
          );
        })}
      </div>

      <div className="tiny" style={{ marginTop: 10, lineHeight: 1.55, opacity: 0.75 }}>
        Testing spends real tokens (at most eight). It runs here rather than on a hosted deployment, where the key
        would be someone else's.
      </div>
    </div>
  );
}
