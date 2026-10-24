import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from './lib/api.js';
import { useApp } from './lib/state.jsx';
import { Pill } from './ui.jsx';

// ChatGPT-style model selector: every model of every provider in one searchable
// list, badges for what a model can do, a live "sync from provider" per gateway,
// and a free-text row so you can point ANTICODEX at any id you want — including
// models this build's catalog has not heard of yet.
//
// The list comes from `/api/bridge?action=models` → `picker`, which the server
// resolves with *your* account's keys, so a key you saved in Settings flips
// `configured` immediately (it used to be invisible to the listing, and the old
// menu had no model ids at all — it sent "<provider>::default", which every real
// endpoint rejects. That is why a fresh NVIDIA key "did not work").

const INDEX_TTL = 10 * 60 * 1000;
const INDEX_V = 3;                                // v3 adds health + the hidden bucket
const autoVerified = new Set();                   // one opportunistic sync per provider per page load
const RECENT_MAX = 6;
let memoryIndex = null;   // per page-load cache; localStorage handles longer life

function readCachedIndex() {
  try {
    const raw = JSON.parse(localStorage.getItem('acx_model_index') || 'null');
    if (raw && raw.v === INDEX_V && raw.at && Date.now() - raw.at < INDEX_TTL && Array.isArray(raw.providers)) return raw;
  } catch { /* private mode */ }
  return null;
}

function knownLabels() {
  try { return JSON.parse(localStorage.getItem('acx_model_labels') || '{}') || {}; } catch { return {}; }
}

/** Remember the name of an id we just saw named. The index is a cache that gets
 *  thrown away on purpose (a provider rejecting an id clears it so the menu
 *  re-reads), and losing a cache must not rename the model in the top bar from
 *  "DeepSeek R1" back to "deepseek-ai/deepseek-r1". */
export function rememberLabel(ref, label) {
  const key = String(ref || '');
  const name = String(label || '').trim();
  if (!key.includes('::') || !name || name === key || name === key.split('::').slice(1).join('::')) return;
  try {
    const map = knownLabels();
    map[key] = name.slice(0, 80);
    const keys = Object.keys(map);
    for (const stale of keys.slice(0, Math.max(0, keys.length - 60))) delete map[stale];
    localStorage.setItem('acx_model_labels', JSON.stringify(map));
  } catch { /* quota / private mode */ }
}

export function modelLabel(ref, index) {
  const text = String(ref || '');
  if (!text.includes('::')) return text === 'anticodex/demo-core' ? 'Demo Core' : (text.split('/').pop() || text);
  const [pid, ...rest] = text.split('::');
  const id = rest.join('::');
  const p = (index?.providers || []).find((x) => x.id === pid);
  const m = (p?.models || []).find((x) => x.id === id);
  // A model we know by label shows its friendly name; anything else (including an
  // id you typed yourself) keeps the full id — dropping the org prefix would make
  // "vendor/totally-new-2027-model" read as just "2027-model".
  return m?.label || knownLabels()[text] || id || `${pid} · ${id}`;
}

function recentRefs() {
  try { return JSON.parse(localStorage.getItem('acx_model_recent') || '[]'); } catch { return []; }
}

export function rememberModel(ref) {
  try {
    const next = [ref, ...recentRefs().filter((x) => x !== ref)].slice(0, RECENT_MAX);
    localStorage.setItem('acx_model_recent', JSON.stringify(next));
  } catch { /* quota */ }
}

export default function ModelPicker({ compact = false, align = 'left' }) {
  const { model, setModel, notify, cfg } = useApp();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(() => memoryIndex || readCachedIndex());
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('configured');
  const [busy, setBusy] = useState('');
  const [customProvider, setCustomProvider] = useState('nvidia');
  const [customId, setCustomId] = useState('');
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const load = async (force = false) => {
    if (index && !force) return index;
    setBusy('list');
    try {
      const r = await api.models();
      const next = r.picker
        ? {
            v: INDEX_V, at: Date.now(), providers: r.picker.providers,
            total: r.picker.total_models,
            // What was removed and why: the difference between a shorter list
            // and a list that quietly lies about what exists.
            hidden: r.picker.hidden || { count: 0, models: [] },
            health: r.health || null
          }
        : null;
      if (next) { memoryIndex = next; try { localStorage.setItem('acx_model_index', JSON.stringify(next)); } catch { /* quota */ } setIndex(next); }
      else notify('Could not read the model list from this server');
    } catch (e) { notify(`Model list unavailable: ${e.message || e}`); } finally { setBusy(''); }
  };

  useEffect(() => { if (index) memoryIndex = index; }, [index]);
  // Pull the index once on mount, not only on open: without it the top bar can
  // only print the raw id ("deepseek-ai/deepseek-r1") instead of the model's
  // name, and the first click has nothing to mark as current.
  useEffect(() => { if (!index) load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    if (!index) load(false);
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  // A key that works should not still be showing guessed catalog ids: the first
  // time you open the picker, the provider you are on (or your first configured
  // one) gets its live list pulled in the background.
  useEffect(() => {
    if (!open || !index) return;
    const wanted = String(model || '').split('::')[0];
    const target = (index.providers || []).find((p) => p.id === wanted && p.configured && !p.verified)
      || (index.providers || []).find((p) => p.configured && p.models_dynamic !== false && !p.verified && p.id !== 'demo');
    if (!target || autoVerified.has(target.id)) return;
    autoVerified.add(target.id);
    syncProvider(target, { quiet: true });
  }, [open, index, model]);                       // eslint-disable-line react-hooks/exhaustive-deps

  const providers = index?.providers || [];
  const configuredCount = providers.filter((p) => p.configured).length;
  const recents = recentRefs();

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matchModel = (m) => !needle || (m.label || '').toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle);
    let base = providers;
    if (tab === 'configured') base = base.filter((p) => p.configured);
    if (tab === 'recent') {
      const all = providers.flatMap((p) => (p.models || []).map((m) => ({ p, m })));
      const picked = recents.map((ref) => all.find(({ p, m }) => `${p.id}::${m.id}` === ref)).filter(Boolean);
      return picked.length ? [{ id: 'recent', name: 'Recently used', configured: true, models: picked.map((x) => x.m), _from: picked.map((x) => x.p.id) }] : [];
    }
    const out = [];
    for (const p of base) {
      const models = (p.models || []).filter(matchModel);
      if (models.length) out.push({ ...p, models });
      else if (needle && (p.name || '').toLowerCase().includes(needle)) out.push({ ...p, models: [] });
    }
    return out;
  }, [providers, q, tab, recents]);

  const rows = useMemo(() => groups.flatMap((g) => (g.models || []).map((m) => ({ g, m }))), [groups]);
  useEffect(() => { setCursor(0); }, [q, tab, groups.length]);

  const choose = (pid, m) => {
    const ref = `${pid}::${m.id}`;
    const provider = providers.find((p) => p.id === pid);
    if (provider && !provider.configured) notify(`${provider.name} has no API key yet — add one in Settings and this model goes live.`);
    else if (m.unverified) notify(`${provider?.name || pid} did not list "${m.id}" in its live model list — if it refuses, the model menu and Settings both have Sync models.`);
    setModel(ref);
    rememberModel(ref);
    rememberLabel(ref, m.label);
    setOpen(false);
  };

  async function syncProvider(p, opts = {}) {
    setBusy(`sync:${p.id}`);
    try {
      const r = await api.syncModels({ provider: p.id, ...(p.endpoint ? { endpoint: p.endpoint } : {}) });
      if (!r.ok) {
        // background attempts stay silent; a clicked button always reports
        if (!opts.quiet) notify(r.error || 'sync failed');
        else autoVerified.delete(p.id);
        return;
      }
      const merged = { ...index, v: INDEX_V, at: Date.now(), providers: index.providers.map((x) => (x.id === p.id ? { ...x, models: r.models, verified: true, synced: true } : x)) };
      setIndex(merged); memoryIndex = merged;
      try { localStorage.setItem('acx_model_index', JSON.stringify(merged)); } catch { /* quota */ }
      if (!opts.quiet) notify(`${p.name}: ${r.models.length} models from the live endpoint`);
    } catch (e) { if (!opts.quiet) notify(`Sync failed: ${e.message || e}`); autoVerified.delete(p.id); }
    finally { setBusy(''); }
  }

  function onKeyDown(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const next = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      setCursor(next);
      listRef.current?.querySelectorAll?.('.mp-row')[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && rows.length) { e.preventDefault(); const r = rows[cursor]; choose(r.g.id, r.m); }
  }

  const current = modelLabel(model, index) || 'Choose model';
  const currentProvider = providers.find((p) => model.startsWith(`${p.id}::`));

  return (
    <div className={`mp ${compact ? 'compact' : ''}`} onKeyDown={onKeyDown}>
      <button
        className="mp-trigger" title="Choose a model (any provider, any id)"
        onClick={() => { setOpen((v) => !v); }}
      >
        <span className="mp-cur">{current}</span>
        {currentProvider && !currentProvider.configured && <span className="mp-warn" title="this provider has no key yet">needs key</span>}
        <span className="mp-caret">▾</span>
      </button>
      {open && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className={`modal mp-modal ${align === 'right' ? 'right' : ''}`} role="dialog" aria-label="Choose a model">
            <div className="mp-head">
              <div>
                <div className="mp-title">Choose a model</div>
                <div className="tiny">
                  {providers.length} providers · {index ? index.total : '…'} models · {configuredCount} with a key
                  {index ? '' : busy === 'list' ? ' · loading…' : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn small ghost" onClick={load.bind(null, true)} disabled={busy === 'list'}>↻ Reload</button>
                <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
              </div>
            </div>
            <div className="mp-tools">
              <input
                ref={searchRef} value={q} placeholder="Search 700+ models — DeepSeek, Nemotron, Claude, vision, reasoning…"
                onChange={(e) => setQ(e.target.value)} aria-label="Search models"
              />
              <div className="mp-tabs">
                {[['configured', 'My keys'], ['all', 'All providers'], ['recent', 'Recent']].map(([id, label]) => (
                  <button key={id} className={`mp-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="modal-body mp-list" ref={listRef}>
              {!index && <div className="muted" style={{ padding: 16 }}>{busy === 'list' ? 'Loading the model list…' : 'Model list not loaded yet.'}</div>}
              {index && tab === 'configured' && configuredCount === 0 && (
                <div className="mp-empty">
                  <b>No provider keys on your account yet.</b>
                  <span>Demo Core answers offline, or paste an NVIDIA / OpenAI / DeepSeek key and pick from hundreds of models.</span>
                  <button className="btn primary small" onClick={() => { setOpen(false); nav('/settings'); }}>Add an API key</button>
                </div>
              )}
              {index && rows.length === 0 && (
                <div className="mp-empty">
                  <b>Nothing matched “{q}”.</b>
                  {q ? <span>Try the id directly (e.g. <span className="kbd">deepseek-v4</span>), or switch to All providers.</span> : null}
                  <div className="row" style={{ gap: 8 }}>
                    {tab === 'configured' && <button className="btn small" onClick={() => setTab('all')}>Search all providers</button>}
                    <button className="btn small ghost" onClick={() => { setCustomId(q); document.querySelector('.mp-custom input')?.focus(); }}>Use “{q}” as a model id</button>
                  </div>
                </div>
              )}
              {groups.map((g) => (
                <div key={g.id} className="mp-group">
                  <div className="mp-ghead">
                    <span className="mp-gname">{g.name}</span>
                    <Pill kind={g.configured ? 'ok' : 'warn'}>{g.configured ? 'key ✓' : 'needs key'}</Pill>
                    <span className="tiny">
                      {(g.models || []).length}{g.verified ? ' · from this endpoint' : g.models_note ? ' · live-syncable' : ''}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      className="btn small ghost" title="Ask this endpoint for its current /models list"
                      disabled={!g.configured || busy === `sync:${g.id}`}
                      onClick={() => syncProvider(g)}
                    >{busy === `sync:${g.id}` ? 'syncing…' : 'Sync models'}</button>
                  </div>
                  {(g.models || []).length === 0 && <div className="tiny" style={{ padding: '4px 10px' }}>{g.models_note || 'no models listed for this endpoint'}</div>}
                  {(g.models || []).map((m) => {
                    const flat = rows.findIndex((r) => r.g.id === g.id && r.m.id === m.id);
                    const isCur = `${g.id}::${m.id}` === model;
                    return (
                      <button
                        key={`${g.id}::${m.id}`} data-mp-row className={`mp-row ${isCur ? 'cur' : ''} ${flat === cursor ? 'hot' : ''}`}
                        onClick={() => choose(g.id, m)} onMouseEnter={() => setCursor(flat)}
                      >
                        <span className="mp-check">{isCur ? '●' : ''}</span>
                        <span className="mp-label">{m.label || m.id}</span>
                        <span className="mp-badges">
                          {m.vision ? <i title="vision / images">◉</i> : null}
                          {m.reasoning ? <i title="reasoning">∞</i> : null}
                          {m.tools ? <i title="tool calling">⚙</i> : null}
                          {m.live ? <i className="mp-live" title="this endpoint listed it — safe to call">✓</i> : null}
                          {m.unverified ? <i className="mp-unver" title="in our catalog, but this endpoint did not list it">?</i> : null}
                          {m.health?.latency_ms ? (
                            <i
                              className={`mp-speed ${m.health.latency_ms > 20000 ? 'slow' : m.health.latency_ms < 2500 ? 'fast' : ''}`}
                              title={`last answer took ${(m.health.latency_ms / 1000).toFixed(1)}s${m.health.first_token_ms ? ` (first token ${(m.health.first_token_ms / 1000).toFixed(1)}s)` : ''}`}
                            >
                              {m.health.latency_ms >= 1000 ? `${(m.health.latency_ms / 1000).toFixed(0)}s` : `${m.health.latency_ms}ms`}
                            </i>
                          ) : null}
                        </span>
                        {tab !== 'recent' && <span className="mp-prov">{g.name}</span>}
                        <span className="mp-id">{m.id}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {index?.hidden?.count > 0 && (
                <div className="mp-hidden">
                  <div className="mp-ghead">
                    <span className="mp-gname">Hidden models</span>
                    <span className="tiny">{index.hidden.count} removed</span>
                  </div>
                  <div className="tiny" style={{ padding: '0 10px 6px', lineHeight: 1.5 }}>
                    {index.hidden.rejected ? <><b>{index.hidden.rejected}</b> were rejected by their provider (“does not exist”) and are no longer offered. </> : null}
                    {index.hidden.unverified ? <><b>{index.hidden.unverified}</b> are catalog guesses the endpoint did not list. </> : null}
                    Nothing was deleted — Settings → Model health can show them and put any of them back.
                  </div>
                </div>
              )}
              <div className="mp-custom">
                <div className="mp-ghead"><span className="mp-gname">Any model id</span><span className="tiny">type it, we route it</span></div>
                <div className="row" style={{ gap: 8, padding: '2px 8px 6px' }}>
                  <select value={customProvider} onChange={(e) => setCustomProvider(e.target.value)} aria-label="Provider for this model id">
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    value={customId} placeholder="e.g. nvidia/nemotron-3.5-super-vl-120b-a12b"
                    onChange={(e) => setCustomId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && customId.trim()) { choose(customProvider, { id: customId.trim() }); setCustomId(''); } }}
                  />
                  <button
                    className="btn primary small" disabled={!customId.trim()}
                    onClick={() => { choose(customProvider, { id: customId.trim() }); setCustomId(''); }}
                  >Use</button>
                </div>
                <div className="tiny" style={{ padding: '0 10px 4px' }}>
                  Sent as <span className="kbd">{customProvider || 'provider'}::{customId || 'model-id'}</span> — useful for brand-new or private
                  endpoints. Unknown ids still work if the endpoint serves them.
                </div>
              </div>
            </div>
            <div className="mp-foot">
              <span className="tiny">↑↓ move · ⏎ use · Esc close</span>
              <div style={{ flex: 1 }} />
              <button className="btn small ghost" onClick={() => { setOpen(false); nav('/settings?tab=models'); }}>Model health…</button>
              <button className="btn small ghost" onClick={() => { setOpen(false); nav('/settings'); }}>Provider keys…</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
