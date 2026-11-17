import React, { useEffect, useState } from 'react';
import { pairing as pairApi, chat as chatApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Pill, Modal } from '../ui.jsx';

// Computer Use.
//
// Two modes, and the page never blurs them:
//   * desktop  — `window.anticodexDesktop.computer(id, args)` reaches the Electron
//                main process, which owns screen capture, mouse, keyboard and
//                process launch on this machine;
//   * browser  — there is no PC to drive. The page says so and disables the
//                actions instead of printing a fake "[preview] acknowledged".
//
// The buttons used to send `{}` for every action, so Move/Click/Type could never
// work even in the desktop app. Each action now asks for the values it needs.

const ACTIONS = [
  { id: 'screenshot', label: 'Capture screen', desc: 'Full-desktop screenshot for the connected vision model', icon: '▣' },
  { id: 'windows', label: 'List windows', desc: 'Enumerate open windows for targeting', icon: '▤' },
  { id: 'move', label: 'Move mouse', desc: 'Move the cursor to absolute screen coordinates', icon: '↖', fields: ['x', 'y'] },
  { id: 'click', label: 'Click', desc: 'Left/right/middle click at a position', icon: '◉', fields: ['x', 'y', 'button', 'count'] },
  { id: 'type', label: 'Type text', desc: 'Send keystrokes to the focused window', icon: '⌨', fields: ['text'] },
  { id: 'key', label: 'Press keys', desc: 'A key combo, e.g. ctrl+s or alt+tab', icon: '⎇', fields: ['combo'] },
  { id: 'launch', label: 'Open app / install', desc: 'Launch a program (confirmation required)', icon: '▶', fields: ['target'], danger: true },
  { id: 'shell', label: 'Run command', desc: 'Run a shell command on this PC (confirmation required)', icon: '$_', fields: ['command'], danger: true }
];

const emptyParams = { x: 0, y: 0, button: 'left', count: 1, text: '', combo: '', target: '', command: '' };

function safeSteps(raw) {
  // The model is asked for {"steps":[…]}; accept a code fence or a bare array,
  // and drop anything that is not in the fixed action table. A plan is a
  // proposal, not a license to run arbitrary names.
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const arr = text.indexOf('[');
  try {
    if (start !== -1 && (arr === -1 || start < arr)) {
      const obj = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
      if (Array.isArray(obj.steps)) return obj.steps;
    }
    if (arr !== -1) {
      const list = JSON.parse(text.slice(arr, text.lastIndexOf(']') + 1));
      if (Array.isArray(list)) return list;
    }
  } catch { /* not a plan */ }
  return null;
}

function planAction(step) {
  const raw = String(step?.action || step?.id || '').toLowerCase();
  const known = ACTIONS.find((a) => a.id === raw);
  if (!known) return null;
  // A plan may annotate, but it may not name a command that the desktop bridge
  // does not implement. Launch/shell need a separate explicit confirmation.
  if (known.danger) return null;
  return { ...known, args: step };
}

export default function ComputerPage() {
  const { notify, model } = useApp();
  const [pairCode, setPairCode] = useState(null);
  const desktop = Boolean(typeof window !== 'undefined' && window.anticodexDesktop?.computer);
  const [log, setLog] = useState([{
    kind: 'sys',
    text: desktop
      ? 'Computer-use console ready. Actions run on this PC.'
      : 'This is the website. Mouse, keyboard and screen control need the ANTICODEX desktop app — nothing will be simulated here.'
  }]);
  const [cmd, setCmd] = useState('');
  const [sheet, setSheet] = useState(null);       // { action, params, fromPlan }
  const [shot, setShot] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (desktop) {
      window.anticodexDesktop.computer('screenshot', {})
        .then((r) => { if (r?.image) setShot(r.image); })
        .catch(() => {});
    }
  }, [desktop]);

  async function makeCode() {
    try {
      const r = await pairApi.create();
      setPairCode(r.code);
      notify('Pairing code created — enter it in the ANTICODEX desktop app');
    } catch (e) { notify(e.message, 'error'); }
  }

  function openAction(a) {
    if (!desktop) {
      notify('Computer Use runs only in the ANTICODEX desktop app. The website cannot control a PC.', 'warn');
      return;
    }
    if (!a.fields) { exec(a.id, {}); return; }
    setSheet({ action: a, params: { ...emptyParams } });
  }

  async function exec(id, args, opts = {}) {
    if (!desktop) {
      setLog((l) => [...l, { kind: 'err', text: 'No desktop bridge in this browser. Install ANTICODEX Desktop to run this action.' }]);
      return { ok: false, error: 'desktop only' };
    }
    setLog((l) => [...l, { kind: 'cmd', text: `${id} ${JSON.stringify(args || {})}` }]);
    try {
      const r = await window.anticodexDesktop.computer(id, args || {});
      if (r?.image) setShot(r.image);
      if (r?.needsConfirmation) {
        setSheet({ action: ACTIONS.find((a) => a.id === id), params: { ...emptyParams, ...args }, confirmOnly: true });
        return r;
      }
      const printable = r?.image ? { ...r, image: `${String(r.image).slice(0, 36)}…` } : r;
      setLog((l) => [...l, { kind: r?.ok === false || r?.error ? 'err' : 'out', text: JSON.stringify(printable).slice(0, 900) }]);
      if (id === 'screenshot' && opts.quiet !== true) notify('Screenshot captured');
      return r;
    } catch (e) {
      setLog((l) => [...l, { kind: 'err', text: String(e.message || e) }]);
      return { ok: false, error: String(e.message || e) };
    }
  }

  function sheetArgs() {
    const p = sheet?.params || {};
    switch (sheet?.action?.id) {
      case 'move': return { x: Number(p.x), y: Number(p.y) };
      case 'click': return { x: Number(p.x), y: Number(p.y), button: p.button, count: Number(p.count) || 1 };
      case 'type': return { text: String(p.text || '') };
      case 'key': return { combo: String(p.combo || '') };
      case 'launch': return { target: String(p.target || ''), confirmed: true };
      case 'shell': return { command: String(p.command || ''), confirmed: true };
      default: return {};
    }
  }

  async function submitSheet() {
    if (!sheet) return;
    const args = sheetArgs();
    const action = sheet.action;
    setSheet(null);
    await exec(action.id, args);
  }

  async function aiCommand() {
    const text = cmd.trim();
    if (!text || busy) return;
    if (!desktop) {
      notify('Describe a task in the desktop app — the website has no PC to act on.', 'warn');
      return;
    }
    setBusy(true);
    setLog((l) => [...l, { kind: 'cmd', text: `ai> ${text}` }]);
    setCmd('');
    try {
      const r = await chatApi({
        model,
        system: `You are ANTICODEX computer-use on ${navigator.platform}. Reply with a JSON object only:
{"steps":[{"action":"screenshot"},{"action":"move","x":100,"y":200},{"action":"click","x":100,"y":200,"button":"left"},{"action":"type","text":"hello"},{"action":"key","combo":"ctrl+s"},{"action":"windows"}]}
Allowed actions: screenshot, windows, move, click, type, key. Never emit launch or shell. Coordinates are absolute pixels on the primary display. If the goal cannot be done without a shell, return {"steps":[]} and one sentence in "note".`,
        messages: [{ role: 'user', content: text }]
      });
      const payload = r.text || '';
      const steps = safeSteps(payload);
      const usable = (steps || []).map(planAction).filter(Boolean);
      if (usable.length) {
        setPlan({ goal: text, steps: usable });
        setLog((l) => [...l, { kind: 'out', text: `Proposed ${usable.length} step(s). Review and press Run plan — nothing has run yet.` }]);
      } else {
        setLog((l) => [...l, { kind: 'out', text: payload || '(no response)' }]);
      }
    } catch (e) {
      setLog((l) => [...l, { kind: 'err', text: String(e.message || e) }]);
    } finally { setBusy(false); }
  }

  async function runPlan() {
    if (!plan?.steps?.length) return;
    setBusy(true);
    setLog((l) => [...l, { kind: 'sys', text: `Running plan: ${plan.goal}` }]);
    for (const step of plan.steps) {
      const args = step.args || {};
      const r = await exec(step.id, args, { quiet: true });
      if (r?.ok === false || r?.error) {
        setLog((l) => [...l, { kind: 'err', text: `Stopped at ${step.id}: ${r.error || 'the action failed'}` }]);
        break;
      }
      await new Promise((x) => setTimeout(x, 350));
    }
    await exec('screenshot', {}, { quiet: true });
    setPlan(null);
    setBusy(false);
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Computer Use</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Let ANTICODEX see and operate the PC it is installed on — vision, mouse, keyboard, installs — through your connected AI model.
          </p>
        </div>
        <Pill kind={desktop ? 'ok' : 'warn'}>{desktop ? 'desktop connected' : 'desktop app required'}</Pill>
      </div>

      {!desktop && (
        <div className="card computer-desktop-note" style={{ marginBottom: 14 }}>
          <b>This page cannot control a PC from a browser.</b>
          <p className="tiny" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
            A web page has no access to your mouse, keyboard or screen, and a hosted server must not drive the
            machine of whoever opens it. Install <b>ANTICODEX Desktop</b> from <a href="/install">Install</a> or the
            GitHub release; the same page then runs against the desktop bridge. Nothing below will pretend to work.
          </p>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>Desktop pairing</h3>
          <p className="sub">Website ↔ desktop sync. The desktop app can also open this page and sign in with your account.</p>
          {!desktop && (
            <>
              <button className="btn primary" onClick={makeCode}>Generate pairing code</button>
              {pairCode && (
                <div className="card spark" style={{ marginTop: 12, textAlign: 'center', background: 'var(--bg-soft)' }}>
                  <div className="tiny">ENTER THIS CODE IN THE DESKTOP APP</div>
                  <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 10, fontFamily: 'var(--mono)', margin: '8px 0' }}>{pairCode}</div>
                  <div className="tiny">expires in 10 minutes</div>
                </div>
              )}
            </>
          )}
          {desktop && <p className="muted">This session is already bridged to the ANTICODEX desktop process on <b>{navigator.platform}</b>.</p>}
          <div style={{ marginTop: 14 }}>
            {ACTIONS.map((a) => (
              <div className="perm-row" key={a.id}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.icon} {a.label}</div>
                  <div className="tiny">{a.desc}</div>
                </div>
                <button
                  className={`btn small ${a.danger ? 'danger' : ''}`}
                  onClick={() => openAction(a)}
                  disabled={!desktop}
                  title={desktop ? '' : 'Install ANTICODEX Desktop to run this'}
                >Run</button>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>Live console</h3>
            <Pill>{model}</Pill>
          </div>
          <div style={{
            flex: 1, minHeight: 300, maxHeight: 420, overflowY: 'auto', marginTop: 12,
            background: 'var(--bg-input)', borderRadius: 12, padding: 14, fontFamily: 'var(--mono)', fontSize: 12
          }}>
            {log.map((l, i) => (
              <div key={i} style={{
                color: l.kind === 'err' ? 'var(--danger)' : l.kind === 'cmd' ? 'var(--text)' : l.kind === 'sys' ? 'var(--muted)' : 'var(--ok)',
                whiteSpace: 'pre-wrap', marginBottom: 6
              }}>
                {l.kind === 'cmd' && <span style={{ color: 'var(--accent-2)' }}>› </span>}{l.text}
              </div>
            ))}
          </div>

          {plan && (
            <div className="card computer-plan-card" style={{ marginTop: 10 }}>
              <div className="row between">
                <b className="tiny">Proposed plan · {plan.steps.length} step(s)</b>
                <button className="btn small ghost" onClick={() => setPlan(null)}>Discard</button>
              </div>
              <ol className="tiny" style={{ margin: '8px 0 10px', paddingLeft: 18, lineHeight: 1.6 }}>
                {plan.steps.map((s, i) => <li key={i}><b>{s.label}</b> — {JSON.stringify(s.args)}</li>)}
              </ol>
              <button className="btn primary small" onClick={runPlan} disabled={busy}>{busy ? 'Running…' : 'Run plan'}</button>
            </div>
          )}

          <div className="composer" style={{ borderRadius: 12, marginTop: 12 }}>
            <textarea value={cmd} onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiCommand(); } }}
              placeholder={desktop ? 'Tell the agent what to do: “open notepad and type hello”, “install the update”, “read the error dialog”…' : 'Install the desktop app to use this console.'}
              style={{ minHeight: 40 }} disabled={!desktop} />
            <div className="composer-bar">
              <span className="tiny">agent → proposed plan → your approval</span>
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={!cmd.trim() || !desktop || busy} onClick={aiCommand}>{busy ? '…' : 'Plan ⏎'}</button>
            </div>
          </div>
          {shot && (
            <div className="media-frame" style={{ marginTop: 12 }}>
              <img src={shot} alt="Desktop screenshot from this PC" />
            </div>
          )}
        </div>
      </div>

      {sheet && (
        <Modal title={sheet.action?.label || 'Confirm action'} onClose={() => setSheet(null)}>
          <p className="muted" style={{ marginTop: 0 }}>
            {sheet.action?.desc}{sheet.action?.danger ? ' — this can modify your PC.' : ''}
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {sheet.action?.fields?.includes('x') && (
              <label className="tiny">X <input type="number" value={sheet.params.x} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, x: e.target.value } }))} style={{ width: '100%', marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('y') && (
              <label className="tiny">Y <input type="number" value={sheet.params.y} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, y: e.target.value } }))} style={{ width: '100%', marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('button') && (
              <label className="tiny">Button
                <select value={sheet.params.button} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, button: e.target.value } }))} style={{ width: '100%', marginTop: 4 }}>
                  <option value="left">left</option><option value="right">right</option><option value="middle">middle</option>
                </select>
              </label>
            )}
            {sheet.action?.fields?.includes('count') && (
              <label className="tiny">Clicks <input type="number" min="1" max="5" value={sheet.params.count} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, count: e.target.value } }))} style={{ width: '100%', marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('text') && (
              <label className="tiny">Text <textarea value={sheet.params.text} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, text: e.target.value } }))} style={{ width: '100%', minHeight: 80, marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('combo') && (
              <label className="tiny">Combo <input value={sheet.params.combo} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, combo: e.target.value } }))} placeholder="ctrl+s" style={{ width: '100%', marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('target') && (
              <label className="tiny">Program or file <input value={sheet.params.target} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, target: e.target.value } }))} placeholder="notepad.exe" style={{ width: '100%', marginTop: 4 }} /></label>
            )}
            {sheet.action?.fields?.includes('command') && (
              <label className="tiny">Command <input value={sheet.params.command} onChange={(e) => setSheet((s) => ({ ...s, params: { ...s.params, command: e.target.value } }))} placeholder="uname -a" style={{ width: '100%', marginTop: 4 }} /></label>
            )}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => setSheet(null)}>Cancel</button>
            <button className={`btn ${sheet.action?.danger ? 'danger' : 'primary'}`} style={{ flex: 1 }} onClick={submitSheet}>
              {sheet.action?.danger ? 'I understand — run' : 'Run'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
