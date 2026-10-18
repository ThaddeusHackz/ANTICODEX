import React, { useEffect, useState } from 'react';
import { pairing as pairApi, chat as chatApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Empty, Modal } from '../ui.jsx';

const ACTIONS = [
  { id: 'screenshot', label: 'Capture screen', desc: 'Full-desktop screenshot sent to your connected vision model' },
  { id: 'move', label: 'Move mouse', desc: 'Move the cursor to absolute coordinates' },
  { id: 'click', label: 'Click', desc: 'Left/right/middle click at a position' },
  { id: 'type', label: 'Type text', desc: 'Send keystrokes to the focused window' },
  { id: 'launch', label: 'Open app / install', desc: 'Launch programs or run installers (with confirmation)' },
  { id: 'windows', label: 'List windows', desc: 'Enumerate open windows for targeting' }
];

export default function ComputerPage() {
  const { notify, model, user } = useApp();
  const [pairCode, setPairCode] = useState(null);
  const [desktop, setDesktop] = useState(() => Boolean(window.anticodexDesktop));
  const [log, setLog] = useState([{ kind: 'sys', text: 'Computer-use console ready. Pair the desktop app for live control.' }]);
  const [cmd, setCmd] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [shot, setShot] = useState(null);

  async function makeCode() {
    try {
      const r = await pairApi.create();
      setPairCode(r.code);
      notify('Pairing code created — enter it in the ANTICODEX desktop app');
    } catch (e) { notify(e.message, 'error'); }
  }

  async function runAction(a) {
    if (['launch', 'install'].includes(a.id) || a.danger) {
      setConfirm(a);
      return;
    }
    await exec(a.id, {});
  }

  async function exec(id, args) {
    setLog((l) => [...l, { kind: 'cmd', text: `${id} ${JSON.stringify(args || {})}` }]);
    try {
      if (desktop) {
        const r = await window.anticodexDesktop.computer(id, args || {});
        setLog((l) => [...l, { kind: 'out', text: JSON.stringify(r).slice(0, 500) }]);
        if (r?.image) setShot(r.image);
      } else {
        // Browser preview: simulate the action and explain the desktop path.
        setLog((l) => [...l, {
          kind: 'out',
          text: `[preview] ${id} acknowledged. Install the ANTICODEX desktop app (Windows .exe in GitHub Releases) to execute real mouse/keyboard/screen actions on your PC.`
        }]);
      }
    } catch (e) {
      setLog((l) => [...l, { kind: 'err', text: String(e.message || e) }]);
    }
    setConfirm(null);
  }

  async function aiCommand() {
    const text = cmd.trim();
    if (!text) return;
    setLog((l) => [...l, { kind: 'cmd', text: `ai> ${text}` }]);
    setCmd('');
    try {
      const r = await chatApi({
        model,
        system: 'You are ANTICODEX computer-use. Translate the user goal into numbered automation steps using screenshot/move/click/type/launch. Be terse.',
        messages: [{ role: 'user', content: text }]
      });
      setLog((l) => [...l, { kind: 'out', text: r.text }]);
    } catch (e) {
      setLog((l) => [...l, { kind: 'err', text: String(e.message || e) }]);
    }
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Computer Use</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Let ANTICODEX see and operate the whole PC it is installed on — vision, mouse, keyboard, installs — through your connected AI model.
          </p>
        </div>
        <Pill kind={desktop ? 'ok' : 'warn'}>{desktop ? 'desktop connected' : 'browser preview'}</Pill>
      </div>

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
          {desktop && <p className="muted">This session is already bridged to the ANTICODEX desktop process.</p>}
          <div style={{ marginTop: 14 }}>
            {ACTIONS.map((a) => (
              <div className="perm-row" key={a.id}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.label}</div>
                  <div className="tiny">{a.desc}</div>
                </div>
                <button className="btn small" onClick={() => runAction(a)}>Run</button>
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
            background: '#07090f', borderRadius: 12, padding: 14, fontFamily: 'var(--mono)', fontSize: 12
          }}>
            {log.map((l, i) => (
              <div key={i} style={{
                color: l.kind === 'err' ? '#fca5a5' : l.kind === 'cmd' ? '#e8ebf6' : l.kind === 'sys' ? '#8b93ab' : '#9fe8b8',
                whiteSpace: 'pre-wrap', marginBottom: 6
              }}>
                {l.kind === 'cmd' && <span style={{ color: '#22d3ee' }}>› </span>}{l.text}
              </div>
            ))}
          </div>
          <div className="composer" style={{ borderRadius: 12, marginTop: 12 }}>
            <textarea value={cmd} onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiCommand(); } }}
              placeholder="Tell the agent what to do: “open notepad and type hello”, “install the update”, “read the error dialog”…"
              style={{ minHeight: 40 }} />
            <div className="composer-bar">
              <span className="tiny">agent → computer-use actions</span>
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={!cmd.trim()} onClick={aiCommand}>Run ⏎</button>
            </div>
          </div>
          {shot && (
            <div className="media-frame" style={{ marginTop: 12 }}>
              <img src={shot} alt="screenshot" />
            </div>
          )}
        </div>
      </div>

      {confirm && (
        <Modal title="Confirm privileged action" onClose={() => setConfirm(null)}>
          <p className="muted">
            <b>{confirm.label}</b> — {confirm.desc}. Computer-use actions can modify the system; only approve actions you initiated.
          </p>
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn danger" style={{ flex: 1 }} onClick={() => exec(confirm.id, { confirmed: true })}>I understand — run</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
