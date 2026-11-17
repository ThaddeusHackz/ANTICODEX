import React, { useEffect, useMemo, useRef, useState } from 'react';
import { skills as skillsApi } from './lib/api.js';
import { useApp, userKey } from './lib/state.jsx';
import Icon from './Icon.jsx';
import { Pill } from './ui.jsx';

// The one skill picker used by Chat and Agent Studio. It reads the same registry
// as the Skills page (project, ~/.codex, ~/.claude, ~/.qoder, bundled) and keeps
// the enabled set per account — two people on one install do not inherit each
// other's tools.
//
// Nothing here claims a skill is "available" unless its SKILL.md parsed. Broken
// skills are listed under their own tab with the parser's reason, because a
// silent omission is how a user concludes the feature is fake.

export default function SkillPicker({ open, onClose, onChanged }) {
  const { user, notify } = useApp();
  const key = userKey('acx_enabled_skills', user?.id);
  const [state, setState] = useState({ loading: true, skills: [], errors: [], roots: [], local: false });
  const [enabled, setEnabled] = useState(() => readEnabled(key));
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function readEnabled(k) {
    try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); }
  }

  useEffect(() => {
    if (!open) return;
    let gone = false;
    setState((s) => ({ ...s, loading: true }));
    skillsApi.list()
      .then((r) => { if (!gone) setState({ loading: false, skills: r.skills || [], errors: r.errors || [], roots: r.roots || [], local: Boolean(r.local) }); })
      .catch((e) => { if (!gone) setState({ loading: false, skills: [], errors: [{ path: '', code: 'Unavailable', message: e.message }], roots: [], local: false }); });
    setEnabled(readEnabled(key));
    return () => { gone = true; };
  }, [open, key]);

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify([...enabled])); } catch { /* quota */ }
    try { window.dispatchEvent(new Event('acx:skills')); } catch { /* no DOM */ }
  }, [enabled, key]);

  // Escape closes the preview first, then the picker. Focus returns to whatever
  // opened it, so keyboard users do not land back at the top of the document.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (preview) setPreview(null);
      else closeRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open, preview]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.skills.filter((s) => {
      if (tab === 'enabled' && !enabled.has(s.name)) return false;
      if (tab === 'qoder' && !/qoder/i.test(s.root_label || '')) return false;
      if (!needle) return true;
      return (s.name || '').toLowerCase().includes(needle)
        || (s.description || '').toLowerCase().includes(needle)
        || (s.root_label || '').toLowerCase().includes(needle);
    });
  }, [state.skills, q, tab, enabled]);

  const counts = useMemo(() => ({
    all: state.skills.length,
    enabled: state.skills.filter((s) => enabled.has(s.name)).length,
    qoder: state.skills.filter((s) => /qoder/i.test(s.root_label || '')).length,
    errors: state.errors.length
  }), [state.skills, state.errors, enabled]);

  if (!open) return null;

  async function toggle(skill) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(skill.name)) next.delete(skill.name); else next.add(skill.name);
      return next;
    });
    onChanged?.();
  }

  async function inspect(skill) {
    setBusy(true);
    try {
      const r = await skillsApi.get(skill.name);
      if (r?.ok) setPreview({ name: skill.name, instructions: r.instructions, path: skill.path, description: skill.description });
      else notify(r?.error || 'Could not read that skill');
    } catch (e) { notify(e.message || 'Could not read that skill'); }
    finally { setBusy(false); }
  }

  const rootText = [...new Set(state.skills.map((s) => s.root_label).filter(Boolean))].join(' · ');

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="skill-picker" role="dialog" aria-modal="true" aria-label="Skills" ref={dialogRef}>
        <div className="skill-picker-head">
          <div>
            <div className="skill-picker-title"><Icon name="skills" size={19} /> Skills</div>
            <div className="tiny">
              {state.loading ? 'Reading skill roots…' : `${counts.all} installed · ${counts.enabled} enabled · ${state.local ? 'this machine' : 'bundled only'}`}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button>
        </div>

        <div className="skill-picker-tools">
          <div className="row" style={{ flex: 1, minWidth: 220 }}>
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, description or source" autoFocus />
          </div>
          <div className="skill-tabs">
            {[['all', `All ${counts.all}`], ['enabled', `Enabled ${counts.enabled}`], ['qoder', `Qoder ${counts.qoder}`]].map(([id, label]) => (
              <button key={id} className={`chip-toggle ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
        </div>

        {rootText && <div className="skill-roots"><Icon name="folder" size={13} /> {rootText}</div>}

        <div className="skill-list">
          {state.loading && <div className="skill-empty">Reading SKILL.md files…</div>}
          {!state.loading && rows.length === 0 && (
            <div className="skill-empty">
              {tab === 'qoder' ? 'No Qoder skills parsed yet. Install one under ~/.qoder/skills/<name>/SKILL.md.'
                : q ? `Nothing matches “${q}”.` : 'No skills found in the roots this machine can read.'}
            </div>
          )}
          {rows.map((s) => (
            <div key={`${s.root_label || s.scope}:${s.name}`} className="skill-row">
              <button className="skill-row-main" onClick={() => inspect(s)} title={s.path || ''}>
                <span className="skill-badge"><Icon name="skills" size={16} /></span>
                <span style={{ minWidth: 0 }}>
                  <span className="skill-name">{s.name}</span>
                  <span className="skill-desc">{s.description || 'No description in this SKILL.md.'}</span>
                  <span className="skill-meta">
                    <span className="source-chip">{s.root_label || s.scope}</span>
                    {s.bytes ? <span>{Math.max(1, Math.round(s.bytes / 1024))} KB</span> : null}
                    {s.dependencies?.length ? <span>{s.dependencies.length} deps</span> : null}
                  </span>
                </span>
              </button>
              <div className="skill-row-side">
                <button className={`switch ${enabled.has(s.name) ? 'on' : ''}`} onClick={() => toggle(s)} aria-pressed={enabled.has(s.name)} title={enabled.has(s.name) ? 'Disable for this account' : 'Enable for this account'} />
              </div>
            </div>
          ))}
          {state.errors.length > 0 && (
            <details className="skill-errors">
              <summary><Icon name="alert" size={14} /> {counts.errors} skill(s) refused — show why</summary>
              {state.errors.map((e, i) => <div key={i} className="tiny mono">{e.path ? `${e.path} — ` : ''}{e.message}</div>)}
            </details>
          )}
        </div>

        <div className="skill-picker-foot">
          <span className="tiny">Enabled skills are injected into every model call as instructions.</span>
          <span className="spacer" />
          <Pill kind="ok">account-scoped</Pill>
        </div>

        {preview && (
          <div className="skill-preview">
            <div className="row between" style={{ gap: 8 }}>
              <b>{preview.name}</b>
              <button className="icon-btn" onClick={() => setPreview(null)} aria-label="Close preview"><Icon name="close" size={15} /></button>
            </div>
            <div className="tiny mono" style={{ opacity: 0.7 }}>{preview.path}</div>
            <pre>{preview.instructions}</pre>
          </div>
        )}
        {busy && <div className="skill-busy">Reading instructions…</div>}
      </div>
    </div>
  );
}
