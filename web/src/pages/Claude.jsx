import React, { useEffect, useRef, useState } from 'react';
import { chat as chatApi, skills as skillsApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { modelLabel } from '../ModelPicker.jsx';
import { renderMarkdown } from '../lib/markdown.js';
import { Pill, Field, CopyBtn, Switch } from '../ui.jsx';

export default function ClaudePage() {
  const { model, notify } = useApp();
  const [memory, setMemory] = useState(() => localStorage.getItem('acx_memory') ||
    '# ANTICODEX.md — project memory\n\n- Product: ANTICODEX universal AI workspace\n- Stack: React + Vite web, Node bridge API, Supabase, Electron desktop\n- Style: crisp, geometric, dark-first\n');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState([
    'Survey workspace and load project memory',
    'Break the task into verifiable steps',
    'Execute tools (search, files, MCP) with a visible tool log',
    'Summarize results and next actions'
  ]);
  const [toolLog, setToolLog] = useState([
    { tool: 'memory.read', args: 'ANTICODEX.md', ok: true }
  ]);
  const [skills, setSkills] = useState([]);
  const [skillErrors, setSkillErrors] = useState([]);
  const [skillNote, setSkillNote] = useState(null);
  const [activeSkills, setActiveSkills] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_active_skills') || '[]'); } catch { return []; }
  });
  const [installing, setInstalling] = useState(false);
  // Installing writes to this machine, so it is offered only where the app can
  // reach the filesystem — the desktop build, not a hosted page.
  const canInstall = typeof window !== 'undefined' && Boolean(window.anticodexDesktop?.installSkill);
  const bottomRef = useRef(null);

  function installSkill() {
    setInstalling(true);
    window.anticodexDesktop.installSkill()
      .then((r) => {
        if (r?.canceled) return;
        if (!r?.ok) throw new Error(r?.error || 'install failed');
        notify(`Installed ${r.name}`);
        return skillsApi.list().then((list) => {
          setSkills(list.skills || []); setSkillErrors(list.errors || []); setSkillNote(list.note || null);
          if (!activeSkills.includes(r.name)) toggleSkill(r.name);
        });
      })
      .catch((e) => notify('Install failed: ' + e.message))
      .finally(() => setInstalling(false));
  }

  // Skills are read from disk by the bridge (Codex's rules: a root is a `skills`
  // dir, a skill is a SKILL.md, a broken one is an error row, and the first root
  // to define a name wins).
  useEffect(() => {
    skillsApi.list()
      .then((r) => { setSkills(r.skills || []); setSkillErrors(r.errors || []); setSkillNote(r.note || null); })
      .catch((e) => notify('Could not load skills: ' + e.message));
  }, []);

  useEffect(() => {
    try { localStorage.setItem('acx_active_skills', JSON.stringify(activeSkills)); } catch { /* quota */ }
  }, [activeSkills]);

  const toggleSkill = (name) => setActiveSkills((cur) => cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);

  useEffect(() => { localStorage.setItem('acx_memory', memory); }, [memory]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true); setInput('');
    const next = [...messages, { role: 'user', content }, { role: 'assistant', content: '', streaming: true }];
    setMessages(next);
    setToolLog((l) => [...l, { tool: 'plan.update', args: content.slice(0, 60), ok: true }]);
    try {
      // Active skills + any $mention in the message, resolved from the registry
      // rather than from a hardcoded list.
      let skillBlock = '';
      try {
        const mentioned = await skillsApi.resolve(content);
        const names = new Set([...activeSkills, ...(mentioned.matched || []).map((m) => m.name)]);
        const blocks = [];
        for (const n of names) {
          const g = await skillsApi.get(n).catch(() => null);
          if (g?.ok) blocks.push(g.instructions);
        }
        if (blocks.length) {
          skillBlock = '\n\n' + blocks.join('\n\n');
          setToolLog((l) => [...l, { tool: 'skills.load', args: [...names].join(', '), ok: true }]);
        }
      } catch { /* skills are optional */ }

      const r = await chatApi({
        model,
        system: `You are the ANTICODEX Agent Studio (Claude-Code-style). Project memory:\n${memory}\nCurrent plan:\n${plan.join('\n')}\nCite tools you would use in [tool:name] brackets.${skillBlock}`,
        messages: [...messages, { role: 'user', content }]
      });
      const full = r.text || '(no response)';
      let shown = '';
      for (const w of full.split(/(\s+)/)) {
        shown += w;
        setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: shown } : m));
        await new Promise((x) => setTimeout(x, 10));
      }
      setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: full, streaming: false } : m));
      setToolLog((l) => [...l, { tool: 'agent.respond', args: `${full.length} chars`, ok: true }]);
    } catch (e) {
      setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: `⚠ ${e.message}`, streaming: false } : m));
    } finally { setBusy(false); }
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Agent Studio</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>Claude-Code-class agent: plans, persistent project memory, skills and a live tool log.</p>
        </div>
        <Pill kind="ok">agent online</Pill>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>Plan</h3>
          <p className="sub">Editable task plan, updated as the agent works.</p>
          {plan.map((p, i) => (
            <div key={i} className="row" style={{ gap: 8, marginBottom: 8 }}>
              <span className="pill">{i + 1}</span>
              <input value={p} onChange={(e) => setPlan(plan.map((x, j) => j === i ? e.target.value : x))} />
            </div>
          ))}
          <button className="btn small" onClick={() => setPlan([...plan, 'New step'])}>+ Add step</button>
        </div>

        <div className="card">
          <h3>Project memory</h3>
          <p className="sub">Persisted as ANTICODEX.md — the Claude desktop <code>.claude</code> pattern.</p>
          <textarea value={memory} onChange={(e) => setMemory(e.target.value)} style={{ minHeight: 220, fontFamily: 'var(--mono)', fontSize: 12.5 }} />
          <div className="row" style={{ marginTop: 8 }}><CopyBtn text={memory} /><Pill kind="ok">auto-saved</Pill></div>
        </div>

        <div className="card">
          <h3>Skills & plugins</h3>
          <p className="sub">REA / leanrea installed, plus Claude-desktop skill surfaces.</p>
          {skills.map((s) => (
            <div key={s.name + (s.archive || '')} className="perm-row">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {s.name} <span className="tiny mono">{s.bytes}B</span>
                </div>
                <div className="tiny">{s.short_description || s.description}</div>
                {s.packaged && (
                  <div className="tiny mono" style={{ opacity: 0.75 }}>
                    {s.archive_files} file(s) in {Math.round((s.archive_bytes || 0) / 1024)} KB
                    {s.license ? ` · ${s.license}` : ''}
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {s.packaged && <Pill kind="ok">.skill</Pill>}
                {s.tier && <Pill>{s.tier}</Pill>}
                <Pill>{s.scope}</Pill>
                <Switch on={activeSkills.includes(s.name)} onChange={() => toggleSkill(s.name)} />
              </div>
            </div>
          ))}
          {skills.length === 0 && !skillErrors.length && <div className="tiny">Scanning skill roots…</div>}
          {skillErrors.map((e) => (
            <div key={e.path} className="perm-row">
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>⚠ {e.code}</div>
                <div className="tiny mono">{e.path}</div>
                <div className="tiny">{e.message}</div>
              </div>
              <Pill kind="warn">invalid</Pill>
            </div>
          ))}
          {canInstall && (
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="btn ghost small" onClick={installSkill} disabled={installing}>
                {installing ? 'Installing…' : 'Install .skill…'}
              </button>
              <span className="tiny">a packaged skill is a ZIP with &lt;name&gt;/SKILL.md</span>
            </div>
          )}
          <div className="tiny" style={{ marginTop: 8 }}>
            {skills.length} skill(s) from {new Set(skills.map((s) => s.scope)).size} scope(s)
            {activeSkills.length ? ` · ${activeSkills.length} active` : ''} · mention one with <span className="mono">$name</span>
            {skillNote ? ` — ${skillNote}` : ''}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <h3>Agent thread</h3>
          <div className="messages" style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {messages.length === 0 && (
              <div className="muted" style={{ fontSize: 13 }}>
                Try: <i>“Plan a reverse-engineering sweep of an Electron app, citing tools.”</i>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className="msg-row" style={{ marginBottom: 14 }}>
                <div className={`avatar ${m.role === 'user' ? 'user' : 'ai'}`} style={{ width: 28, height: 28, fontSize: 11 }}>{m.role === 'user' ? 'You' : 'AX'}</div>
                <div className="msg-body">
                  <div className="msg-text" style={{ fontSize: 13.8 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  {m.streaming && <span className="typing" />}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="composer" style={{ borderRadius: 12 }}>
            <textarea value={input} placeholder="Ask the agent…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              style={{ minHeight: 38 }} />
            <div className="composer-bar">
              <span className="tiny" title={model}>{modelLabel(model)}</span>
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={busy || !input.trim()} onClick={send}>{busy ? '…' : 'Send ⏎'}</button>
            </div>
          </div>
        </div>

        <div className="card" style={{ minHeight: 420 }}>
          <h3>Tool log</h3>
          <p className="sub">Every tool invocation, streamed live — like Claude Code's tool-use trace.</p>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, maxHeight: 340, overflowY: 'auto' }}>
            {toolLog.map((t, i) => (
              <div key={i} style={{ padding: '5px 0', borderBottom: '1px dashed var(--border-soft)' }}>
                <span style={{ color: t.ok ? 'var(--ok)' : 'var(--danger)' }}>●</span>{' '}
                <b>{t.tool}</b> <span className="tiny">{t.args}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
