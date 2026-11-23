import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import { streamV3 } from '../lib/v3.js';
const STARTERS = [
  ['Architecture review', 'Inspect this workspace and propose the smallest coherent next improvement. Cite files and identify tests still needed.'],
  ['Find the weak spots', 'Review this workspace for security boundaries, error handling and missing regression tests. Prioritize concrete risks.'],
  ['Plan a feature', 'Map this workspace and propose a step-by-step implementation plan for its next user-facing feature. State assumptions clearly.']
];
export default function TeamsPage() {
  const { model, user } = useApp();
  const [goal, setGoal] = useState(''); const [target, setTarget] = useState('auto');
  const [members, setMembers] = useState([]); const [lead, setLead] = useState(''); const [phase, setPhase] = useState('Ready when you are');
  const [running, setRunning] = useState(false); const [error, setError] = useState(''); const ctrl = useRef(null);
  useEffect(() => () => { ctrl.current?.abort(); }, [user?.id]);
  async function run() {
    if (!goal.trim() || ctrl.current) return;
    const controller = new AbortController(); ctrl.current = controller;
    setRunning(true); setError(''); setLead(''); setMembers([]); setPhase('Connecting to your workspace');
    try {
      const out = await streamV3('teams', { goal: goal.trim(), target, model }, { signal: controller.signal, onEvent: (e) => {
        if (e.type === 'team_start') { setMembers(e.members.map((m) => ({ ...m, status: 'queued', text: '' }))); setPhase('Two independent perspectives'); }
        if (e.type === 'member_start') setMembers((all) => all.map((m) => m.id === e.member_id ? { ...m, status: 'running' } : m));
        if (e.type === 'member_event' && e.event.type === 'assistant_delta') setMembers((all) => all.map((m) => m.id === e.member_id ? { ...m, text: (m.text + '\n' + (e.event.text || '')).trim() } : m));
        if (e.type === 'member_done') setMembers((all) => all.map((m) => m.id === e.member_id ? { ...m, ...e } : m));
        if (e.type === 'lead_start') setPhase('The lead is connecting the dots');
        if (e.type === 'lead_event' && e.event.type === 'assistant_delta') setLead((s) => (s + '\n' + (e.event.text || '')).trim());
      } });
      setLead(out.text || ''); setPhase(out.partial ? 'Review finished with worker issues · inspect the findings' : 'Review complete · no files changed');
    } catch (e) { setPhase(e.name === 'AbortError' ? 'Stopped · partial results are not a completed review' : 'Review needs attention'); if (e.name !== 'AbortError') setError(e.message); }
    finally { if (ctrl.current === controller) ctrl.current = null; setRunning(false); }
  }
  return <section className="v3-root" aria-labelledby="teams-title">
    <header className="v3-hero"><div><div className="v3-eyebrow">ANTICODEX / Teams</div><h1 id="teams-title">One goal.<br /><em>More perspective.</em></h1><p>An architect and an independent reviewer explore your workspace. A lead turns their findings into one grounded plan.</p></div><span className="v3-trust">Read-only by design</span></header>
    <div className="v3-tabs"><Link className="active" to="/teams" aria-current="page">Agent Teams</Link><Link to="/sites">Sites ↗</Link></div>
    <div className="v3-team-layout"><div className="v3-panel v3-brief"><div className="v3-kicker">01 / The brief</div><h2>What are we working toward?</h2>
      <label htmlFor="team-goal">Your goal</label><textarea id="team-goal" maxLength={6000} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Describe the question, feature, or problem you want the team to investigate…" disabled={running} rows={6} />
      <div className="v3-label-row"><label htmlFor="team-target">Workspace</label><span>{goal.length}/6000</span></div><select id="team-target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={running}><option value="auto">Automatic target</option><option value="local">This machine · desktop/local</option><option value="daytona">Daytona workspace</option></select>
      <p className="v3-caption">Uses your selected model and configured target. Two workers + one lead; provider usage applies. No shell, writes, MCP calls or nested delegation.</p>
      <div className="v3-actions">{running ? <button className="v3-button secondary" onClick={() => ctrl.current?.abort()}>Stop review</button> : <button className="v3-button" onClick={run} disabled={!goal.trim()}>{error ? 'Retry review' : 'Start team review'} <span aria-hidden="true">↗</span></button>}</div>
      <div className="v3-starters"><span className="v3-kicker">A place to start</span>{STARTERS.map(([title, prompt]) => <button key={title} onClick={() => setGoal(prompt)} disabled={running}>{title}<span aria-hidden="true">↗</span></button>)}</div>
    </div><div className="v3-team-results"><div className="v3-status" role="status" aria-live="polite"><span className={running ? 'v3-dot live' : 'v3-dot'} />{phase}</div>
      {error && <div className="v3-alert" role="alert">{error}</div>}
      {!members.length && <div className="v3-empty"><div className="v3-orbit" aria-hidden="true">◌</div><h2>A small team, not a black box.</h2><p>Watch each perspective take shape. Findings and failures stay visible, and nothing silently changes your workspace.</p><div className="v3-roles"><span>01 Architect</span><span>02 Reviewer</span><span>03 Lead</span></div></div>}
      <div className="v3-worker-grid">{members.map((m) => <article className="v3-panel v3-worker" key={m.id}><div className="v3-label-row"><h3>{m.label}</h3><span className={`v3-pill ${m.status}`}>{m.status}</span></div>{m.text && <details><summary>Read findings</summary><pre>{m.text}</pre></details>}{m.error && <p className="v3-error">{m.error}</p>}{m.issues > 0 && <p className="v3-caption">{m.issues} tool issue(s) reported.</p>}</article>)}</div>
      {lead && <article className="v3-panel v3-lead"><div className="v3-kicker">The synthesis</div><h2>A clearer way forward.</h2><pre>{lead}</pre><Link className="v3-text-link" to="/agent">Continue in the Agent workspace, with its approval controls ↗</Link></article>}
    </div></div>
  </section>;
}
