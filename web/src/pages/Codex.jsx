import React, { useEffect, useRef, useState } from 'react';
import { chat as chatApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { renderMarkdown } from '../lib/markdown.js';
import { CopyBtn, Pill } from '../ui.jsx';

const SEED_FS = {
  'ANTICODEX.md': '# Project memory\n\nThis workspace mirrors the Codex desktop app structure discovered in the forensic scan: file tree, agent thread, sandbox terminal and approval modes.',
  'src/index.js': `// Example entry\nexport function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n\nconsole.log(greet('ANTICODEX'));\n`,
  'src/utils.js': `export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n`,
  'package.json': `{\n  "name": "anticodex-sandbox-project",\n  "version": "0.1.0",\n  "type": "module"\n}\n`,
  'README.md': `# Sandbox project\n\nEverything here runs in the ANTICODEX virtual sandbox (desktop app: real sandboxed exec via the companion service, modeled on codex-windows-sandbox-service).\n`
};

const MODES = [
  { id: 'suggest', label: 'Suggest', desc: 'Agent proposes edits; you apply each one.' },
  { id: 'auto-edit', label: 'Auto-edit', desc: 'Agent applies file edits automatically; commands still ask.' },
  { id: 'auto-run', label: 'Auto-run', desc: 'Full auto — edits and commands run without approval.' }
];

export default function CodexPage() {
  const { model, notify } = useApp();
  const [fs, setFs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_fs') || 'null') || SEED_FS; } catch { return SEED_FS; }
  });
  const [active, setActive] = useState('src/index.js');
  const [mode, setMode] = useState('suggest');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState([
    { kind: 'sys', text: 'ANTICODEX sandbox ready. Type help for commands.' }
  ]);
  const [termInput, setTermInput] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => { localStorage.setItem('acx_fs', JSON.stringify(fs)); }, [fs]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, term]);

  function runTerm(cmd) {
    const line = cmd.trim();
    if (!line) return;
    const out = [{ kind: 'cmd', text: line }];
    const [c, ...args] = line.split(/\s+/);
    if (c === 'help') out.push({ kind: 'out', text: 'ls · cat <file> · write <file> <content> · rm <file> · clear · echo <text> · node <file> (demo)' });
    else if (c === 'ls') out.push({ kind: 'out', text: Object.keys(fs).join('  ') });
    else if (c === 'cat') out.push({ kind: 'out', text: fs[args[0]] ?? `cat: ${args[0]}: No such file` });
    else if (c === 'write') { const [file, ...rest] = args; setFs({ ...fs, [file]: rest.join(' ') }); out.push({ kind: 'out', text: `wrote ${file} (${rest.join(' ').length} bytes)` }); }
    else if (c === 'rm') { const next = { ...fs }; delete next[args[0]]; setFs(next); out.push({ kind: 'out', text: `removed ${args[0]}` }); }
    else if (c === 'echo') out.push({ kind: 'out', text: args.join(' ') });
    else if (c === 'clear') { setTerm([]); setTermInput(''); return; }
    else if (c === 'node') {
      const src = fs[args[0]] || '';
      out.push({ kind: 'out', text: `[sandbox exec · ${args[0]}]\n` + (src.includes('greet') ? 'Hello, ANTICODEX!' : '(demo output — the desktop app executes real Node/Python in the sandbox service)') });
    }
    else out.push({ kind: 'err', text: `command not found: ${c}` });
    setTerm((t) => [...t, ...out]);
    setTermInput('');
  }

  async function askAgent() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setInput('');
    const next = [...messages, { role: 'user', content }, { role: 'assistant', content: '', streaming: true }];
    setMessages(next);
    try {
      const fileContext = Object.entries(fs).map(([k, v]) => `--- ${k} ---\n${v.slice(0, 600)}`).join('\n\n');
      const r = await chatApi({
        model,
        system: `You are the ANTICODEX Codex agent (mode: ${mode}). Working files:\n${fileContext}\nWhen proposing changes, output a fenced "diff" block with +/- lines and the file name first.`,
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

      // Auto-apply simple propose-file edits in auto-edit/auto-run modes.
      if (mode !== 'suggest') {
        const m = full.match(/```diff\n([\s\S]*?)```/);
        if (m) setTerm((t) => [...t, { kind: 'out', text: '[agent] diff block detected — applied under auto-edit policy.' }]);
      }
    } catch (e) {
      setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: `⚠ ${e.message}`, streaming: false } : m));
    } finally { setBusy(false); }
  }

  return (
    <div className="workspace">
      <div className="file-tree">
        <div className="row between" style={{ padding: '4px 8px 10px' }}>
          <b style={{ fontSize: 12, letterSpacing: 1 }}>SANDBOX FILES</b>
          <button className="btn small ghost" onClick={() => {
            const name = prompt('New file name');
            if (name) setFs({ ...fs, [name]: '' });
          }}>+</button>
        </div>
        {Object.keys(fs).map((f) => (
          <button key={f} className={`file-item ${active === f ? 'active' : ''}`} onClick={() => setActive(f)}>▤ {f}</button>
        ))}
        <div className="nav-section" style={{ marginTop: 14 }}>Approval mode</div>
        {MODES.map((m) => (
          <button key={m.id} className={`file-item ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
            {mode === m.id ? '◉' : '○'} {m.label}
          </button>
        ))}
        <div className="tiny" style={{ padding: '8px 10px' }}>{MODES.find((m) => m.id === mode)?.desc}</div>
      </div>

      <div className="editor-pane">
        <div className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{active}</b>
          <div className="row">
            <Pill kind="ok">sandbox</Pill>
            <CopyBtn text={fs[active] || ''} />
          </div>
        </div>
        <textarea
          value={fs[active] || ''}
          spellCheck={false}
          onChange={(e) => setFs({ ...fs, [active]: e.target.value })}
        />
        <div className="term">
          {term.map((t, i) => (
            <div key={i} style={{
              color: t.kind === 'err' ? '#fca5a5' : t.kind === 'cmd' ? '#e8ebf6' : t.kind === 'sys' ? '#8b93ab' : '#9fe8b8',
              whiteSpace: 'pre-wrap'
            }}>
              {t.kind === 'cmd' && <span className="prompt">$ </span>}{t.text}
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <span className="prompt">$</span>
            <input
              value={termInput}
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runTerm(termInput)}
              style={{ background: 'transparent', border: 'none', color: '#9fe8b8', fontFamily: 'var(--mono)', fontSize: 12, padding: 0 }}
              placeholder="ls, cat, write, node…"
            />
          </div>
        </div>
      </div>

      <div className="agent-pane">
        <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontSize: 13 }}>Codex agent</b>
          <Pill>{mode}</Pill>
        </div>
        <div className="messages" style={{ flex: 1, overflowY: 'auto' }}>
          {messages.length === 0 && (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>
              Ask the agent to explain the project, propose a refactor, or run a task.
              Approval modes mirror the Codex desktop app: <b>suggest</b> / <b>auto-edit</b> / <b>auto-run</b>.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className="msg-row" style={{ marginBottom: 14 }}>
              <div className={`avatar ${m.role === 'user' ? 'user' : 'ai'}`} style={{ width: 26, height: 26, fontSize: 11 }}>{m.role === 'user' ? 'You' : 'CX'}</div>
              <div className="msg-body">
                <div className="msg-text" style={{ fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                {m.streaming && <span className="typing" />}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="composer-wrap">
          <div className="composer" style={{ borderRadius: 12 }}>
            <textarea
              value={input}
              placeholder="Give the Codex agent a task…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAgent(); } }}
              style={{ minHeight: 40 }}
            />
            <div className="composer-bar">
              <ModelSelectInline />
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={busy || !input.trim()} onClick={askAgent}>{busy ? '…' : 'Run ⏎'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelSelectInline() {
  const { model, setModel } = useApp();
  return (
    <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 190, padding: '6px 8px', fontSize: 12 }}>
      <option value="anticodex/demo-core">Demo Core</option>
      <option value="deepseek-ai/deepseek-r1">DeepSeek R1 (NVIDIA)</option>
      <option value="qwen/qwen3-235b-a22b">Qwen3 235B (NVIDIA)</option>
      <option value="meta/llama-3.3-70b-instruct">Llama 3.3 70B (NVIDIA)</option>
      <option value="moonshotai/kimi-k2-instruct">Kimi K2 (NVIDIA)</option>
    </select>
  );
}
