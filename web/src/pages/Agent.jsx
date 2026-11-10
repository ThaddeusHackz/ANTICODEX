import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Facts, StatusPill, Modal } from '../ui.jsx';

// Agent — the OpenCode-shaped loop, on the machine you point it at.
//
// What this page guarantees, because a coding agent is only useful if you can
// trust what it says it did:
//
//   * every tool call is a visible part with its own state (pending → running →
//     done/denied/failed), the machine it ran on, and its duration;
//   * a diff is shown where a diff exists, not summarised as "edited the file";
//   * an `ask` permission stops the run and asks you, with the pattern it matched,
//     so "allow always" means exactly that pattern and nothing wider;
//   * Plan and Build are a switch you cannot forget (the read-only agent has no
//     write tools at all — they are not offered, so they cannot be talked into
//     being used);
//   * the target is on screen at all times: "Daytona · …" or "this machine".

const STATES = {
  pending: { label: 'queued', pill: '' },
  running: { label: 'running', pill: 'live' },
  ok: { label: 'done', pill: 'ok' },
  failed: { label: 'failed', pill: 'err' },
  denied: { label: 'denied', pill: 'warn' }
};

function ToolPart({ part, onOpenDiff }) {
  const [open, setOpen] = useState(false);
  const st = STATES[part.state] || STATES.pending;
  const arg = part.args?.command || part.args?.file_path || part.args?.path || part.args?.pattern || part.args?.query || part.args?.slug || part.args?.id || '';
  return (
    <div className={`card`} style={{ padding: '8px 10px', marginBottom: 6, borderColor: part.state === 'failed' ? 'var(--danger)' : part.state === 'denied' ? 'var(--warn)' : undefined }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <StatusPill status={st.pill || 'partial'} />
        <b style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}>{part.tool}</b>
        <span className="tiny" style={{ fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{String(arg).slice(0, 160)}</span>
        {part.target && <span className="pill tiny">{part.target}</span>}
        {part.duration_ms != null && <span className="pill tiny">{part.duration_ms} ms</span>}
        <span className="tiny">{st.label}</span>
        <button className="btn tiny ghost" onClick={() => setOpen((v) => !v)}>{open ? 'hide' : 'details'}</button>
      </div>
      {part.reason && <div className="tiny" style={{ marginTop: 4, opacity: .8 }}>{part.reason}</div>}
      {part.diff && (
        <pre
          onClick={() => onOpenDiff?.(part.diff, part.tool)}
          title="open the diff"
          style={{ margin: '6px 0 0', padding: 8, background: 'var(--bg-input)', borderRadius: 8, fontSize: 11.5, maxHeight: 220, overflow: 'auto', cursor: 'pointer' }}
        >
          {part.diff.split('\n').slice(0, 40).map((l, i) => (
            <div key={i} style={{ color: l.startsWith('+') ? 'var(--ok)' : l.startsWith('-') ? 'var(--danger)' : 'var(--text-2)' }}>{l || ' '}</div>
          ))}
        </pre>
      )}
      {open && (
        <pre style={{ margin: '6px 0 0', padding: 8, background: 'var(--bg-input)', borderRadius: 8, fontSize: 11.5, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {JSON.stringify({ args: part.args, result: part.result }, null, 2).slice(0, 6000)}
        </pre>
      )}
    </div>
  );
}

export default function AgentPage() {
  const { model, notify, user } = useApp();
  const [status, setStatus] = useState(null);
  const [agentId, setAgentId] = useState('build');
  const [target, setTarget] = useState('auto');
  const [input, setInput] = useState('');
  const [todos, setTodos] = useState([]);
  const [parts, setParts] = useState([]);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [session, setSession] = useState(null);
  const [grants, setGrants] = useState({});
  const [autoApprove, setAutoApprove] = useState(false);
  const [history, setHistory] = useState([]);
  const [diff, setDiff] = useState(null);
  const [provisioning, setProvisioning] = useState(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);

  const load = useCallback(() => {
    api.agent.status(target).then(setStatus).catch(() => {});
  }, [target]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [parts.length, text]);

  const activeAgent = useMemo(() => (status?.agents || []).find((a) => a.id === agentId), [status, agentId]);
  const token = status?.daytona?.token;
  const targetLabel = status?.target?.label || '—';

  async function send() {
    const prompt = input.trim();
    if (!prompt || running) return;
    setRunning(true);
    setParts([]);
    setText('');
    setTodos([]);
    setDiff(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const msgs = [{ role: 'user', content: prompt }];
    try {
      const out = await api.agent.stream({
        messages: msgs, agent: agentId, target, model, session_id: session, grants,
        auto_approve: autoApprove, use_mcp: true
      }, {
        signal: ctrl.signal,
        onEvent: (evt) => {
          if (evt.type === 'session') {
            setSession(evt.sessionId);
            if (evt.note) notify(evt.note);
          }
          if (evt.type === 'assistant_delta') setText((t) => (t ? `${t}\n\n` : '') + evt.text);
          if (evt.type === 'tool_start') {
            setParts((p) => [...p, { key: `${evt.step}-${p.length}`, tool: evt.tool, args: evt.args, state: evt.decision === 'deny' ? 'denied' : 'running', decision: evt.decision, reason: evt.reason, target: evt.target }]);
          }
          if (evt.type === 'tool_end') {
            setParts((p) => {
              const next = [...p];
              // The matching part is the most recent unfinished one with this tool.
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].tool === evt.tool && next[i].state === 'running') {
                  next[i] = { ...next[i], state: evt.denied ? 'denied' : evt.ok ? 'ok' : 'failed', duration_ms: evt.duration_ms, diff: evt.diff, result: evt.ok ? { ok: true } : { error: evt.error }, error: evt.error };
                  break;
                }
              }
              return next;
            });
          }
          if (evt.type === 'todo') setTodos(evt.todos || []);
          if (evt.type === 'step_limit') notify(`Step limit reached (${evt.steps}) — the agent was asked to answer.`);
          if (evt.type === 'permission') {
            setParts((p) => [...p, { key: `perm-${p.length}`, tool: evt.tool, args: evt.args, state: 'denied', decision: 'ask', reason: `${evt.reason} — auto-approve is off, so this was denied. Turn it on to let the agent run unattended on Daytona.`, target: evt.target }]);
          }
          if (evt.type === 'error') notify(evt.error);
        }
      });
      if (out?.grants) setGrants(out.grants);
      if (out?.todos) setTodos(out.todos);
      setHistory((h) => [{ prompt, agent: agentId, target: targetLabel, at: Date.now(), rounds: out?.rounds, text: out?.text || '' }, ...h].slice(0, 20));
    } catch (e) {
      if (e?.name !== 'AbortError') notify(e.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
      load();
    }
  }

  async function runProvision() {
    setProvisioning({ running: true, steps: [] });
    try {
      const r = await api.daytona.provision();
      setProvisioning({ running: false, ...r });
      notify(r?.ok ? 'Workspace provisioned' : (r?.error || 'Provisioning did not finish'));
    } catch (e) {
      setProvisioning({ running: false, error: e.message });
      notify(e.message);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agent</h1>
          <p className="sub">
            A coding agent with hands: it reads, writes, edits, greps and runs commands — on <b>{targetLabel}</b>, and
            every step below says which machine it touched. Plan mode has no write tools at all; Build asks before it changes anything.
          </p>
        </div>
        <div className="actions">
          <div className="chips">
            <button className={`chip ${agentId === 'build' ? 'active' : ''}`} onClick={() => setAgentId('build')} title="Full access: read, write, edit, bash — asks before changes">Build</button>
            <button className={`chip ${agentId === 'plan' ? 'active' : ''}`} onClick={() => setAgentId('plan')} title="Read-only: no write, edit, patch or bash tools are even offered">Plan</button>
            <button className={`chip ${agentId === 'explore' ? 'active' : ''}`} onClick={() => setAgentId('explore')} title="Read-only and offline: fast codebase exploration">Explore</button>
          </div>
        </div>
      </div>

      <Facts items={[
        { k: 'Target', v: status?.target?.mode === 'daytona' ? 'Daytona' : 'This machine', d: status?.target?.configured ? 'connected' : 'no workspace' },
        { k: 'Token', v: token?.known ? `${token.hours_left}h left` : '—', d: token?.known ? token.note.slice(0, 60) : 'not tracked' },
        { k: 'Agent', v: activeAgent?.label || 'Build', d: `${activeAgent?.steps || 12} tool rounds max` },
        { k: 'Model', v: model || 'default', d: 'the same key as Chat' }
      ]} />

      {/* Target + token strip: the two things that decide whether this works. */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <div className="chips">
            <button className={`chip ${target === 'auto' ? 'active' : ''}`} onClick={() => setTarget('auto')}>Auto</button>
            <button className={`chip ${target === 'daytona' ? 'active' : ''}`} onClick={() => setTarget('daytona')} disabled={!status?.daytona?.configured}>Daytona</button>
            <button className={`chip ${target === 'local' ? 'active' : ''}`} onClick={() => setTarget('local')}>This machine</button>
          </div>
          <div className="between" />
          {token?.known && (
            <span className={`pill ${token.state === 'valid' ? 'ok' : token.state === 'soon' ? 'warn' : 'err'}`} title={token.note}>
              token {token.state} · {token.minutes_left} min
            </span>
          )}
          <label className="tiny row" style={{ gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />  {/* the wrapping <label> names it */}
            auto-approve changes on Daytona
          </label>
          <button className="btn small" onClick={runProvision} disabled={!status?.daytona?.configured || provisioning?.running}>
            {provisioning?.running ? 'Provisioning…' : 'Install / repair sandbox'}
          </button>
        </div>
        {status?.target?.note && <div className="tiny" style={{ marginTop: 6 }}>{status.target.note}</div>}
        {token?.known && token.state !== 'valid' && (
          <div className="tiny" style={{ marginTop: 6, color: 'var(--danger)' }}>
            {token.note} <a href="/sandbox">Paste a new token on the Sandbox page →</a>
          </div>
        )}
        {provisioning && !provisioning.running && (
          <div style={{ marginTop: 8 }}>
            <div className="tiny" style={{ marginBottom: 4 }}>{provisioning.summary?.line || provisioning.error}</div>
            {/* Row-header table: each cell is meaningless without the step name
                beside it, so the first cell is a <th scope="row">, not a <td>. */}
            <table className="table" style={{ fontSize: 12 }}>
              <tbody>
                {(provisioning.steps || []).map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 20 }}><span aria-hidden="true">{s.ok ? '✓' : s.optional ? '·' : '✗'}</span><span className="sr-only">{s.ok ? 'done' : s.optional ? 'skipped' : 'failed'}</span></td>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>{s.label}</th>
                    <td className="tiny" style={{ whiteSpace: 'pre-wrap', opacity: .8 }}>{s.detail || s.error}</td>
                    <td className="tiny" style={{ textAlign: 'right' }}>{s.seconds}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section split" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
        <div>
          <div className="card">
            <div className="card-head">
              <h3>{running ? 'Working…' : 'Task'}</h3>
              <div className="right">
                {running && <button className="btn small" onClick={() => abortRef.current?.abort()}>Stop</button>}
                <button className="btn small primary" onClick={send} disabled={running || !input.trim()}>Run</button>
              </div>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}
              rows={4}
              placeholder={agentId === 'plan'
                ? 'Ask for an analysis. Plan mode cannot change anything — it will answer with diffs instead.'
                : 'Something to build or fix. e.g. "add a /health endpoint, run the tests, and report what failed"'}
              spellCheck={false}
              style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: 11, fontFamily: 'var(--mono)', fontSize: 12.8, lineHeight: 1.6, outline: 'none' }}
            />
            <div className="tiny" style={{ marginTop: 4 }}>⌘↵ runs it. Nothing leaves this machine except the model call itself.</div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="card-head">
              <h3>Steps</h3>
              <div className="right">
                <span className="pill">{parts.length} tool{parts.length === 1 ? '' : 's'}</span>
                {status?.target?.mode === 'daytona' && <span className="pill info">on Daytona</span>}
              </div>
            </div>
            {!parts.length && !text && <div className="empty">Nothing yet. Every tool the agent calls appears here as its own step, with the machine it ran on.</div>}
            {parts.map((p) => <ToolPart key={p.key} part={p} onOpenDiff={(d, t) => setDiff({ text: d, tool: t })} />)}
            {text && (
              <div style={{ marginTop: 10, padding: 11, background: 'var(--bg-input)', borderRadius: 10, fontSize: 13.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{text}</div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-head"><h3>Task list</h3><div className="right"><span className="pill">{todos.filter((t) => t.status === 'done').length}/{todos.length}</span></div></div>
            {!todos.length && <div className="empty">The agent keeps a task list here for anything with more than two steps.</div>}
            {todos.map((t, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
                <span style={{ width: 14, flex: 'none' }}>{t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '·'}</span>
                <span style={{ fontSize: 12.5, opacity: t.status === 'done' ? .65 : 1, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.text}</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="card-head"><h3>Permissions</h3></div>
            <div className="tiny" style={{ marginBottom: 6 }}>
              {agentId === 'build'
                ? 'Build asks before writing, editing or running anything not on the safe list. Allowances you granted this session are below.'
                : `${activeAgent?.label || 'This agent'} cannot write or run commands — those tools are not offered to the model at all.`}
            </div>
            {Object.keys(grants).length ? Object.entries(grants).map(([k, v]) => (
              <div key={k} className="row" style={{ gap: 6, fontSize: 12 }}>
                <span className={`pill ${v === 'allow' ? 'ok' : 'err'}`}>{v}</span>
                <code className="code-inline">{k}</code>
              </div>
            )) : <div className="tiny">No standing allowances.</div>}
          </div>

          {history.length > 0 && (
            <div className="card" style={{ marginTop: 10 }}>
              <div className="card-head"><h3>This session</h3></div>
              {history.map((h, i) => (
                <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                  <div className="tiny" style={{ opacity: .7 }}>{h.agent} · {h.target} · {h.rounds || '?'} rounds</div>
                  <div style={{ fontSize: 12.5 }}>{h.prompt.slice(0, 140)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {diff && (
        <Modal title={`${diff.tool} diff`} onClose={() => setDiff(null)} width={900}>
          <div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--bg-input)', borderRadius: 10, fontSize: 12, maxHeight: '70vh', overflow: 'auto' }}>
              {diff.text.split('\n').map((l, i) => (
                <div key={i} style={{ color: l.startsWith('+') ? 'var(--ok)' : l.startsWith('-') ? 'var(--danger)' : 'var(--text-2)' }}>{l || ' '}</div>
              ))}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
