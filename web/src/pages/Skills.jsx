import React, { useEffect, useMemo, useState } from 'react';
import { skills as skillsApi, artifacts as artifactsApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Pill } from '../ui.jsx';

// Skill management.
//
// The ChatGPT app's webview talks to its main process over a small set of skill
// channels — `skills/list`, `skills/manage`, `skills/config`, `skills/plugins`
// and a `skills/changed` event (seen in the asar: 736 files mention SKILL.md,
// and the strings `skills/remote-skills`, `skills/list`, `skills/config` and
// `skills/plugins` all appear in the renderer bundles). This page is those five
// views in one place, against the registry this app already reads from disk:
//
//   Installed — every SKILL.md the loader found, with scope and size
//   Remote    — packaged `.skill` archives, i.e. what `skills/remote-skills`
//   Plugins   — artifact templates shipped by plugins (document/deck/sheet)
//   Config    — the roots that were searched, and what failed to parse
//
// Enabled state is persisted by the bridge per authenticated account.

const TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'remote', label: 'Remote' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'config', label: 'Config' }
];

const KINDS = [
  { id: 'document', label: 'Documents (.docx)' },
  { id: 'presentation', label: 'Decks (.pptx)' },
  { id: 'spreadsheet', label: 'Sheets (.xlsx)' }
];

export default function SkillsPage() {
  const { notify } = useApp();
  const [tab, setTab] = useState('installed');
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ loading: true, skills: [], errors: [], duplicates: [], roots: [], local: false, note: null });
  const [enabled, setEnabled] = useState(() => new Set());
  const [kind, setKind] = useState('document');
  const [templates, setTemplates] = useState({ loading: false, cards: [], note: null });
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let gone = false;
    skillsApi.list()
      .then((r) => {
        if (gone) return;
        const list = r.skills || [];
        setState({ loading: false, skills: list, errors: r.errors || [], duplicates: r.duplicates || [], roots: r.roots || [], local: Boolean(r.local), note: r.note || null });
        setEnabled(new Set(list.filter((skill) => skill.enabled !== false).map((skill) => skill.name)));
      })
      .catch((e) => { if (!gone) setState((s) => ({ ...s, loading: false, note: e.message })); });
    return () => { gone = true; };
  }, []);

  async function loadTemplates(nextKind = kind) {
    setKind(nextKind);
    setTemplates({ loading: true, cards: [], note: null });
    try {
      const r = await artifactsApi.list(nextKind);
      setTemplates({ loading: false, cards: r.cards || [], note: r.note || (r.local && !r.count ? 'No templates installed in ~/.codex yet.' : null) });
    } catch (e) {
      setTemplates({ loading: false, cards: [], note: e.message });
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.skills.filter((s) => (tab === 'remote' ? s.packaged : true)).filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
  }, [state.skills, query, tab]);

  const toggle = async (name) => {
    const nextEnabled = !enabled.has(name);
    setEnabled((prev) => {
      const next = new Set(prev);
      if (nextEnabled) next.add(name); else next.delete(name);
      return next;
    });
    try {
      await skillsApi.configure(name, nextEnabled);
    } catch (error) {
      setEnabled((prev) => {
        const next = new Set(prev);
        if (nextEnabled) next.delete(name); else next.add(name);
        return next;
      });
      notify(error.message || 'Could not save skill setting', 'error');
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 20px 60px' }}>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Skills</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {state.loading ? 'Reading skill roots…' : `${state.skills.length} skill(s) from ${new Set(state.skills.map((s) => s.scope)).size} scope(s)`}
            {state.local ? ' · this machine' : ' · bundled only'}
          </p>
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or description" style={{ minWidth: 240 }} />
      </div>

      {state.note && <div className="card" style={{ marginTop: 16 }}><div className="tiny" style={{ opacity: 0.85 }}>{state.note}</div></div>}

      <div className="row" style={{ marginTop: 18, gap: 6, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.id} className={`chip-toggle ${tab === t.id ? 'on' : ''}`} onClick={() => { setTab(t.id); if (t.id === 'plugins') loadTemplates(kind); }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'config' && tab !== 'plugins' && (
        <div className="card" style={{ marginTop: 14, padding: 0 }}>
          {shown.length === 0 && !state.loading && (
            <div className="tiny" style={{ padding: 16, opacity: 0.8 }}>
              {tab === 'remote' ? 'No packaged .skill archives were found in this checkout.' : 'Nothing matched.'}
            </div>
          )}
          {shown.map((s) => (
            <div key={`${s.scope}:${s.path}`} style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <div className="row between" style={{ padding: '10px 14px', gap: 10 }}>
                <button className="row" style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', gap: 10, flex: 1, minWidth: 0 }} onClick={() => setOpen(open === s.name ? null : s.name)}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{s.name}</span>
                  <Pill kind={s.tier ? 'ok' : 'warn'}>{s.tier || s.scope}</Pill>
                  {s.archive_files ? <span className="tiny" style={{ opacity: 0.7 }}>{s.archive_files} entries</span> : null}
                </button>
                <div className="row" style={{ gap: 6 }}>
                  {s.bytes ? <span className="tiny" style={{ opacity: 0.6 }}>{(s.bytes / 1024).toFixed(1)} KB</span> : null}
                  <button className={`chip-toggle ${enabled.has(s.name) ? 'on' : ''}`} onClick={() => toggle(s.name)} title="Enable for this account">
                    {enabled.has(s.name) ? 'enabled' : 'disabled'}
                  </button>
                </div>
              </div>
              {open === s.name && (
                <div className="tiny" style={{ padding: '0 14px 12px', lineHeight: 1.5, opacity: 0.9 }}>
                  <div>{s.description || 'No description in this SKILL.md.'}</div>
                  <div style={{ fontFamily: 'var(--mono)', marginTop: 6, opacity: 0.75 }}>{s.path}</div>
                  {s.license ? <div style={{ marginTop: 4 }}>Licence: {s.license}</div> : null}
                  {s.dependencies?.length ? <div style={{ marginTop: 4 }}>Dependencies: {s.dependencies.join(', ')}</div> : null}
                  <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => { navigator.clipboard?.writeText(s.path || ''); notify('Path copied'); }}>Copy path</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'plugins' && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {KINDS.map((k) => (
              <button key={k.id} className={`chip-toggle ${kind === k.id ? 'on' : ''}`} onClick={() => loadTemplates(k.id)}>{k.label}</button>
            ))}
          </div>
          <div className="tiny" style={{ marginTop: 10, opacity: 0.8, minHeight: 18 }}>
            {templates.loading ? 'Reading templates…' : templates.note || `${templates.cards.length} template(s) offered for this kind`}
          </div>
          {templates.cards.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginTop: 10 }}>
              {templates.cards.map((c) => (
                <div key={c.id} className="card" style={{ padding: 8 }}>
                  {c.preview
                    ? <img src={c.preview} alt="" style={{ width: '100%', height: 92, objectFit: 'cover', borderRadius: 8 }} />
                    : <div style={{ height: 92, borderRadius: 8, background: 'var(--bg-soft)' }} />}
                  <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600 }}>{c.title}</div>
                  <div className="tiny" style={{ opacity: 0.75 }}>{c.skillName}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'config' && (
        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Roots searched</div>
          <div className="tiny" style={{ marginTop: 8, fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
            {state.roots.length === 0 && <div style={{ opacity: 0.7 }}>No roots reported.</div>}
            {state.roots.map((r) => (
              <div key={typeof r === 'string' ? r : r.path || JSON.stringify(r)} style={{ opacity: r.exists === false ? 0.45 : 1 }}>
                {typeof r === 'string'
                  ? r
                  : `${r.path} · ${r.label || r.scope || ''}${r.skills != null ? ` · ${r.skills} skill(s)` : ''}${r.exists === false ? ' · missing' : ''}`}
              </div>
            ))}
          </div>
          {state.errors.length > 0 && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 16 }}>Refused</div>
              <div className="tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
                {state.errors.map((e, i) => <div key={i}>{typeof e === 'string' ? e : `${e.path || ''} — ${e.error || JSON.stringify(e)}`}</div>)}
              </div>
            </>
          )}
          {state.duplicates?.length > 0 && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 16 }}>Shadows</div>
              <div className="tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
                {state.duplicates.map((d, i) => (
                  <div key={i}>
                    {typeof d === 'string'
                      ? d
                      : `${d.name} — kept ${d.kept || 'the earlier root'}, ignored ${d.ignored || 'a later root'}`}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
