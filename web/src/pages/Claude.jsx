import React, { useEffect, useRef, useState } from 'react';
import { chat as chatApi, agents as agentsApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { modelLabel } from '../ModelPicker.jsx';
import { renderMarkdown } from '../lib/markdown.js';
import { Pill, Field, CopyBtn } from '../ui.jsx';

const SKILLS = [
  { name: 'reverse-engineer-anything', src: 'REA v42', desc: 'Native, managed, Electron/JS, firmware, browser targets' },
  { name: 'leanrea', src: 'leanrea', desc: 'Fast-path RE with plain CLI tools, no MCP needed' },
  { name: 'rea-tool-design', src: 'REA', desc: 'Design RE tooling and workflows' },
  { name: 'rea-ci-tests-audit', src: 'REA', desc: 'CI/test auditing methodology' },
  { name: 'code-review-plugin', src: 'claude-desktop', desc: 'Structured code review (from .claude plugins)' },
  { name: 'plans-and-file-history', src: 'claude-desktop', desc: 'Plans / file-history / shell-snapshots workflow' }
];

// v2.5 — the sub-agent roster is now real: each role below maps to a genuine
// orchestrated agent in lib/agents.js (planner → parallel specialists with
// live tool access → synthesizer → critic).
const MODES = [
  { id: 'auto', label: 'Auto', hint: 'Lead agent plans the team itself (1-4 sub-agents)' },
  { id: 'research', label: 'Deep research', hint: 'Researcher + analyst in parallel, cited synthesis' },
  { id: 'review', label: 'Review panel', hint: 'Critic scores the draft before you see it' }
];

export default function ClaudePage() {
  const { model, notify } = useApp();
  const [memory, setMemory] = useState(() => localStorage.getItem('acx_memory') ||
    '# ANTICODEX.md — project memory\n\n- Product: ANTICODEX universal AI workspace\n- Stack: React + Vite web, Node bridge API, Supabase, Electron desktop\n- Style: crisp, geometric, dark-first\n');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('auto');
  const [useTools, setUseTools] = useState(true);
  const [run, setRun] = useState(null); // last orchestration result (agents[], score…)
  const [plan, setPlan] = useState([
    'Survey workspace and load project memory',
    'Break the task into verifiable steps',
    'Execute tools (search, files, MCP) with a visible tool log',
    'Summarize results and next actions'
  ]);
  const [toolLog, setToolLog] = useState([
    { tool: 'memory.read', args: 'ANTICODEX.md', ok: true }
  ]);
  const bottomRef = useRef(null);

  useEffect(() => { localStorage.setItem('acx_memory', memory); }, [memory]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, run]);

  async function sendAgents(content) {
    // The real pipeline: one POST runs planner → parallel sub-agents (each can
    // call builtins + connected MCP tools) → synthesizer → critic.
    setBusy(true);
    setToolLog((l) => [...l, { tool: 'orchestrator.start', args: `${mode} · ${content.slice(0, 60)}`, ok: true }]);
    try {
      const briefs = mode === 'research'
        ? [{ role: 'researcher', goal: `Research thoroughly, with sources: ${content}` },
           { role: 'analyst', goal: `Analyze implications, trade-offs and risks: ${content}` }]
        : mode === 'review'
        ? [{ role: 'writer', goal: `Draft a direct answer: ${content}` },
           { role: 'critic', goal: `Critique accuracy and completeness for: ${content}. Output JSON {"score":n,"verdict":"ship|revise","defects":[...]}` }]
        : undefined;
      const r = await agentsApi({ task: content, model, briefs, use_mcp: useTools, critique: true });
      if (!r.ok) throw new Error(r.error || 'the orchestrator returned no answer');
      setRun(r);
      setMessages((ms) => [...ms, { role: 'assistant', content: r.answer }]);
      for (const a of r.agents || []) {
        setToolLog((l) => [...l, {
          tool: `agent.${a.role}`,
          args: `${a.ok ? `${a.chars} chars` : `FAILED: ${a.error}`}${a.tools_used?.length ? ` · ${a.tools_used.join(', ')}` : ''} · ${(a.ms / 1000).toFixed(1)}s`,
          ok: a.ok
        }]);
      }
      if (typeof r.score === 'number') {
        setToolLog((l) => [...l, { tool: 'critic.score', args: `${r.score}/10 — ${r.verdict}`, ok: r.verdict === 'ship' }]);
      }
    } catch (e) {
      setMessages((ms) => [...ms, { role: 'assistant', content: `⚠ ${e.message}` }]);
      setToolLog((l) => [...l, { tool: 'orchestrator.error', args: String(e.message).slice(0, 80), ok: false }]);
    } finally { setBusy(false); }
  }

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    setInput('');
    const prev = messages;
    setMessages((ms) => [...ms, { role: 'user', content }]);
    if (mode !== 'single') return sendAgents(content);

    setBusy(true);
    setMessages((ms) => [...ms, { role: 'assistant', content: '', streaming: true }]);
    setToolLog((l) => [...l, { tool: 'plan.update', args: content.slice(0, 60), ok: true }]);
    try {
      const r = await chatApi({
        model,
        system: `You are the ANTICODEX Agent Studio (Claude-Code-style). Project memory:\n${memory}\nCurrent plan:\n${plan.join('\n')}\nCite tools you would use in [tool:name] brackets.`,
        messages: [...prev, { role: 'user', content }]
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
          {SKILLS.map((s) => (
            <div key={s.name} className="perm-row">
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{s.name}</div>
                <div className="tiny">{s.desc}</div>
              </div>
              <Pill>{s.src}</Pill>
            </div>
          ))}
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
            <textarea value={input} placeholder="Ask the agent… (Auto mode fans the task out to real sub-agents)"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              style={{ minHeight: 38 }} />
            <div className="composer-bar">
              <span className="tiny" title={model}>{modelLabel(model)}</span>
              {' '}
              {MODES.map((m) => (
                <button key={m.id} className={`btn small ${mode === m.id ? 'primary' : ''}`} title={m.hint}
                  onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
              {' '}
              <button className={`btn small ${useTools ? '' : 'ghost'}`} title="Let sub-agents call builtins + connected MCP tools"
                onClick={() => setUseTools(!useTools)}>{useTools ? '⚙ tools on' : '⚙ tools off'}</button>
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={busy || !input.trim()} onClick={send}>{busy ? 'orchestrating…' : 'Run ⏎'}</button>
            </div>
          </div>
        </div>

        <div className="card" style={{ minHeight: 420 }}>
          <h3>Tool log</h3>
          <p className="sub">Every tool invocation, streamed live — like Claude Code's tool-use trace.</p>
          {run && (
            <div className="card" style={{ marginBottom: 10, padding: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Pill kind={run.ok ? 'ok' : 'bad'}>{run.ok ? 'run ok' : 'run failed'}</Pill>
                {typeof run.score === 'number' && <Pill kind={run.verdict === 'ship' ? 'ok' : 'warn'}>critic {run.score}/10 · {run.verdict}</Pill>}
                <Pill>{(run.ms / 1000).toFixed(1)}s</Pill>
                <Pill>{run.agents?.length || 0} agents</Pill>
                <Pill>{run.tools_available || 0} tools</Pill>
              </div>
              <div className="tiny" style={{ marginTop: 6 }}>{run.objective}</div>
              {run.defects?.length > 0 && (
                <ul className="tiny" style={{ margin: '6px 0 0 16px', paddingLeft: 0 }}>
                  {run.defects.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </div>
          )}
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
