import React, { useCallback, useEffect, useRef, useState } from 'react';
import { chat as chatApi, workspace as workspaceApi, workspaceFs, egress as egressApi, mcp as mcpApi, rea as reaApi } from '../lib/api.js';
import { Link } from 'react-router-dom';
import { useApp, userKey } from '../lib/state.jsx';
import ModelPicker from '../ModelPicker.jsx';
import { renderMarkdown } from '../lib/markdown.js';
import { CopyBtn, Pill } from '../ui.jsx';

// The seeded files are the DEMO workspace: hosted visitors get a virtual tree
// and the page says so. On the desktop app or a local server the same page
// drives a real folder through api/bridge.js → lib/workspacefs.js.
const SEED_FS = {
  'ANTICODEX.md': '# Project memory\n\nDemo workspace (virtual files). Open ANTICODEX Desktop or run the server yourself and this page edits a real folder on your machine.',
  'src/index.js': `// Example entry\nexport function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n\nconsole.log(greet('ANTICODEX'));\n`,
  'package.json': `{\n  "name": "anticodex-sandbox-project",\n  "version": "0.1.0",\n  "type": "module"\n}\n`
};

// These are the real Codex approval policies (codex-rs protocol `AskForApproval`)
// paired with the sandbox each one implies. The bridge enforces this matrix —
// decideApproval() runs server-side before any file or process is touched.
const MODES = [
  { id: 'suggest', label: 'Suggest', approval: 'untrusted', sandbox: 'read-only', desc: 'Nothing runs without your approval. Codex calls this untrusted + read-only.' },
  { id: 'auto-edit', label: 'Auto-edit', approval: 'on-request', sandbox: 'workspace-write', desc: 'Writes inside the workspace; anything outside it asks. Codex: on-request + workspace-write.' },
  { id: 'auto-run', label: 'Auto-run', approval: 'never', sandbox: 'danger-full-access', desc: 'No approvals and no sandbox. Codex: never + danger-full-access — throwaway machines only.' }
];

const SANDBOXES = [
  { id: 'read-only', label: 'read-only' },
  { id: 'workspace-write', label: 'workspace-write' },
  { id: 'external-sandbox', label: 'external-sandbox' },
  { id: 'danger-full-access', label: 'danger-full-access' }
];

function DiffView({ hunks = [], truncated_hunks }) {
  return (
    <pre className="term" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
      {hunks.map((h, i) => (
        <span key={i} style={{ color: h.t === '+' ? '#9fe8b8' : h.t === '-' ? '#fca5a5' : '#8b93ab', display: 'block' }}>
          {h.t}{h.line}
        </span>
      ))}
      {truncated_hunks && <span style={{ color: '#8b93ab', display: 'block' }}>… diff truncated</span>}
    </pre>
  );
}

export default function CodexPage() {
  const { model, notify, user } = useApp();
  const account = String(user?.id ?? 'anon');
  const fsKey = userKey('acx_fs', user?.id);
  const readFs = (k) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null') || SEED_FS; } catch { return SEED_FS; }
  };

  // --- policy surface (what the bridge enforces) -----------------------------
  const [mode, setMode] = useState('suggest');
  const [sandbox, setSandbox] = useState('read-only');
  const [net, setNet] = useState(false);
  const policy = useCallback(() => ({
    sandbox,
    approval: MODES.find((m) => m.id === mode)?.approval,
    account
  }), [sandbox, mode, account]);

  // --- real vs demo workspace ------------------------------------------------
  const [wsMode, setWsMode] = useState('checking'); // checking | real | demo
  const [nodes, setNodes] = useState({});           // dir path -> {dirs, files} | undefined
  const [openDirs, setOpenDirs] = useState({});     // dir path -> true
  const [active, setActive] = useState(null);       // {path, content, base, truncated}
  const [demoFs, setDemoFs] = useState(() => readFs(fsKey));

  // --- approvals ------------------------------------------------------------
  const [pending, setPending] = useState(null);     // {kind, label, retry}

  // --- terminal ---------------------------------------------------------------
  const [term, setTerm] = useState([{ kind: 'sys', text: 'Workspace terminal. Commands run for real when a folder is attached — type help.' }]);
  const [termInput, setTermInput] = useState('');
  const bottomRef = useRef(null);

  // --- agent thread -----------------------------------------------------------
  const [messages, setMessages] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState(null);
  const [showAgents, setShowAgents] = useState(false);
  const [cwd, setCwd] = useState(() => localStorage.getItem('acx_workspace_cwd') || '');
  const [egress, setEgress] = useState({ running: false, local: true, allowed: 0, denied: 0 });
  const [agentTools, setAgentTools] = useState({ loading: true, connections: [], rea: null });

  // demo persistence (only when there is no real folder)
  useEffect(() => { setDemoFs(readFs(fsKey)); }, [fsKey]);
  useEffect(() => {
    if (wsMode === 'demo') { try { localStorage.setItem(fsKey, JSON.stringify(demoFs)); } catch { /* quota */ } }
  }, [demoFs, fsKey, wsMode]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, term, proposals]);
  useEffect(() => { const m = MODES.find((x) => x.id === mode); if (m) setSandbox(m.sandbox); }, [mode]);

  const loadDir = useCallback(async (dir = '') => {
    const r = await workspaceFs.list(dir, policy());
    if (r.needs_local || r.verdict === 'blocked') { setWsMode('demo'); return null; }
    if (r.needs_approval) { askApproval('list', dir, () => loadDir(dir)); return null; }
    if (!r.ok) { notify(`Workspace: ${r.error}`); return null; }
    setWsMode('real');
    setNodes((n) => ({ ...n, [dir]: r }));
    return r;
  }, [policy, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  function askApproval(kind, label, retry) {
    setPending({ kind, label, retry });
  }

  useEffect(() => {
    let gone = false;
    workspaceFs.status({ account }).then(async (r) => {
      if (gone) return;
      if (r.ok && r.local) {
        setWsMode('real');
        const listing = await loadDir('');
        // Open the first real file so the editor arrives wired, not empty.
        if (!gone && listing && listing.files.length) openFile(listing.files[0].path);
      } else setWsMode('demo');
    }).catch(() => { if (!gone) setWsMode('demo'); });
    return () => { gone = true; };
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    egressApi.status().then((r) => { setEgress(r); if (r.running) setNet(true); }).catch(() => {});
    let gone = false;
    Promise.all([
      mcpApi.list().catch(() => ({ connections: [] })),
      reaApi.status().catch(() => null)
    ]).then(([list, rea]) => {
      if (!gone) setAgentTools({ loading: false, connections: list.connections || [], rea });
    });
    return () => { gone = true; };
  }, []);

  // --- file ops ---------------------------------------------------------------
  async function openFile(p) {
    const r = await workspaceFs.read(p, policy());
    if (r.needs_local) { setWsMode('demo'); return; }
    if (!r.ok) { notify(r.error || 'Could not open file'); return; }
    setActive({ path: p, content: r.content, base: r.content, truncated: r.truncated });
  }

  async function saveActive() {
    if (!active) return;
    const r = await workspaceFs.write(active.path, active.content, policy());
    if (r.needs_approval) { askApproval('write', active.path, async () => {
      const c = await workspaceFs.write(active.path, active.content, { ...policy(), confirm: true });
      if (c.ok) { setActive((a) => ({ ...a, base: a.content })); setPending(null); notify(`Saved ${c.path} (${c.bytes} bytes)`); }
      else { setPending(null); notify(c.error || 'Write failed'); }
    }); return; }
    if (r.error) { notify(r.error); return; }
    setActive((a) => ({ ...a, base: a.content }));
    notify(`Saved ${r.path} (${r.bytes} bytes)`);
    loadDir(path0(active.path));
  }

  async function newFile() {
    const name = window.prompt('New file name (folders allowed, e.g. src/a.js)');
    if (!name) return;
    const r = await workspaceFs.write(name, '', policy());
    if (!r.ok && !r.needs_approval) { notify(r.error || 'Could not create file'); return; }
    if (r.needs_approval) { askApproval('write', name, async () => {
      const c = await workspaceFs.write(name, '', { ...policy(), confirm: true });
      if (c.ok) { setPending(null); setActive({ path: c.path, content: '', base: '' }); loadDir(path0(c.path)); }
    }); return; }
    setActive({ path: r.path, content: '', base: '' });
    loadDir(path0(r.path));
  }

  async function deleteActive() {
    if (!active) return;
    const r = await workspaceFs.rm(active.path, policy());
    if (r.needs_approval) { askApproval('rm', active.path, async () => {
      const c = await workspaceFs.rm(active.path, { ...policy(), confirm: true });
      if (c.ok) { setPending(null); setActive(null); notify(`Removed ${c.removed}`); loadDir(path0(active.path)); }
    }); return; }
    if (!r.ok) { notify(r.error || 'Remove failed'); return; }
    setActive(null); notify(`Removed ${r.removed}`); loadDir(path0(active.path));
  }

  const path0 = (p) => (String(p).includes('/') ? String(p).slice(0, String(p).lastIndexOf('/')) : '');

  // --- terminal ---------------------------------------------------------------
  async function runTerm(raw) {
    const line = String(raw ?? termInput).trim();
    if (!line) return;
    setTermInput('');
    const push = (...items) => setTerm((t) => [...t, ...items]);
    if (line === 'clear') { setTerm([]); return; }
    if (line === 'help') {
      push({ kind: 'out', text: 'ls [folder] · cat <file> · write <file> <text> · mkdir <folder> · rm <path> · node <file> · any other line runs as a real shell command' });
      return;
    }
    if (wsMode !== 'real') { // demo virtual fs, clearly labeled
      const [c, ...a] = line.split(/\s+/);
      if (c === 'ls') push({ kind: 'out', text: `[demo] ${Object.keys(demoFs).join('  ')}` });
      else if (c === 'cat') push({ kind: 'out', text: `[demo] ${demoFs[a[0]] ?? `cat: ${a[0]}: No such file`}` });
      else if (c === 'write') { const [f, ...rest] = a; setDemoFs((fs0) => ({ ...fs0, [f]: rest.join(' ') })); push({ kind: 'out', text: `[demo] wrote ${f}` }); }
      else if (c === 'echo') push({ kind: 'out', text: line.slice(5) });
      else push({ kind: 'err', text: '[demo workspace — no real folder attached. Desktop/local server unlocks real commands.]' });
      return;
    }
    const [c, ...a] = line.split(/\s+/);
    let call;
    if (c === 'ls') call = () => workspaceFs.list(a[0] || '', policy());
    else if (c === 'cat') call = () => workspaceFs.read(a[0] || '', policy());
    else if (c === 'write') call = () => workspaceFs.write(a[0] || '', a.slice(1).join(' '), policy());
    else if (c === 'mkdir') call = () => workspaceFs.mkdir(a[0] || '', policy());
    else if (c === 'rm') call = () => workspaceFs.rm(a[0] || '', policy());
    else if (c === 'node' && a[0]) call = () => workspaceFs.exec(`node ${a[0]}`, policy());
    else call = () => workspaceFs.exec(line, policy());

    push({ kind: 'cmd', text: line });

    const r = await call();
    if (r.needs_approval) {
      setPending({ kind: 'exec', label: line, retry: async () => {
        const payload = { ...policy(), confirm: true };
        let cr;
        if (c === 'ls') cr = await workspaceFs.list(a[0] || '', payload);
        else if (c === 'cat') cr = await workspaceFs.read(a[0] || '', payload);
        else if (c === 'write') cr = await workspaceFs.write(a[0] || '', a.slice(1).join(' '), payload);
        else if (c === 'mkdir') cr = await workspaceFs.mkdir(a[0] || '', payload);
        else if (c === 'rm') cr = await workspaceFs.rm(a[0] || '', payload);
        else cr = await workspaceFs.exec(line, payload);
        setPending(null);
        renderResult(cr, c);
      } });
      push({ kind: 'sys', text: `${MODES.find((m) => m.id === mode)?.approval} policy: this needs your approval — use the Allow button.` });
      return;
    }
    if (r.verdict === 'deny') { push({ kind: 'err', text: r.error }); return; }
    renderResult(r, c);
  }

  function confirmRerun() { return Promise.resolve(null); }

  function renderResult(r, c) {
    if (!r) return;
    if (r.error) { setTerm((t) => [...t, { kind: 'err', text: r.error }]); return; }
    if (c === 'ls') {
      const items = [...(r.dirs || []).map((d) => `${d.name}/`), ...(r.files || []).map((f) => `${f.name} (${f.bytes}B)`)];
      setTerm((t) => [...t, { kind: 'out', text: items.join('   ') || '(empty)' }]);
      return;
    }
    if (c === 'cat') { setTerm((t) => [...t, { kind: 'out', text: r.content ?? '' }]); return; }
    if (c === 'write' || c === 'mkdir' || c === 'rm') {
      setTerm((t) => [...t, { kind: 'out', text: r.removed ? `removed ${r.removed}` : `${c === 'rm' ? '' : 'wrote '}${r.path || ''} ${r.bytes != null ? `(${r.bytes} bytes)` : ''}`.trim() }]);
      loadDir(path0(r.path || r.removed || ''));
      return;
    }
    const out = [];
    if (r.stdout) out.push({ kind: 'out', text: r.stdout.replace(/\n$/, '') });
    if (r.stderr) out.push({ kind: 'err', text: r.stderr.replace(/\n$/, '') });
    if (r.timed_out) out.push({ kind: 'err', text: `[timed out after the sandbox window — killed]` });
    if (r.exit_code !== 0 && r.exit_code != null) out.push({ kind: 'sys', text: `[exit ${r.exit_code} · ${r.duration_ms ?? '?'}ms]` });
    if (!out.length) out.push({ kind: 'sys', text: `[done · exit ${r.exit_code} · ${r.duration_ms ?? '?'}ms]` });
    setTerm((t) => [...t, ...out]);
    if (c !== 'exec') loadDir('');
  }

  // --- agent chat with real proposals -----------------------------------------
  async function fileContextForPrompt() {
    if (wsMode !== 'real') {
      return Object.entries(demoFs).map(([k, v]) => `--- ${k} ---\n${String(v).slice(0, 600)}`).join('\n\n');
    }
    const all = [];
    const collect = (dir) => {
      for (const d of (nodes[dir]?.dirs || [])) collect(d.path);
      for (const f of (nodes[dir]?.files || [])) all.push(f);
    };
    collect('');
    const parts = [];
    for (const f of all.slice(0, 12)) {
      if (f.bytes > 200000) continue;
      const r = await workspaceFs.read(f.path, policy());
      if (r.ok) parts.push(`--- ${r.path} ---\n${r.content}`);
    }
    return parts.join('\n\n') || '(workspace is empty)';
  }

  async function askAgent() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true); setInput('');
    setMessages((ms) => [...ms, { role: 'user', content }, { role: 'assistant', content: '', streaming: true }]);
    try {
      const fileContext = await fileContextForPrompt();
      const projectBlock = agents?.ok && agents.instructions ? agents.instructions : '';
      const r = await chatApi({
        model: model.includes('::') ? model.split('::').slice(1).join('::') : model,
        provider: model.includes('::') ? model.split('::')[0] : undefined,
        system: `You are the ANTICODEX Codex agent (mode: ${mode}). Working files:\n${fileContext}\nWhen you change a file, output:\n\n\`\`\`proposed-file <path>\n<full new contents>\n\`\`\`\nOne block per file. The UI previews a real diff and applies it only with approval (or automatically when the policy allows writes).`,
        messages: projectBlock
          ? [{ role: 'user', content: projectBlock }, ...messages, { role: 'user', content }]
          : [...messages, { role: 'user', content }]
      });
      const full = r.error ? `⚠ ${r.error}${r.settings_link ? ' — fix it in Settings → Providers' : ''}` : (r.text || '(no response)');
      setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: full, streaming: false } : m));

      const blocks = [...full.matchAll(/```\s*proposed-file\s+([^\n`]+)\n([\s\S]*?)```/g)];
      for (const b of blocks) {
        const p = b[1].trim(); const body = b[2].replace(/\n$/, '');
        const pv = wsMode === 'real'
          ? await workspaceFs.preview(p, body, policy())
          : { ok: true, path: p, exists: Boolean(demoFs[p]), ...diffDemo(demoFs[p] || '', body) };
        if (!pv.ok) { notify(pv.error || 'Preview failed'); continue; }
        const proposal = { path: p, content: body, added: pv.added, removed: pv.removed, hunks: pv.hunks, truncated_hunks: pv.truncated_hunks, id: `${p}-${Date.now()}` };
        setProposals((ps) => [...ps, proposal]);
        // Auto-apply only when the ENGINE says auto (suggest mode never does).
        if (wsMode === 'real' && mode !== 'suggest') {
          const w = await workspaceFs.write(p, body, policy());
          if (w.ok) applyProposalLocally(proposal, true);
          else if (w.needs_approval) { /* stay as a one-click proposal */ }
          else notify(w.error);
        }
      }
    } catch (e) {
      setMessages((ms) => ms.map((m, i) => i === ms.length - 1 ? { ...m, content: `⚠ ${e.message}`, streaming: false } : m));
    } finally { setBusy(false); }
  }

  function diffDemo(oldText, newText) {
    const a = String(oldText || '').split('\n'), b = newText.split('\n');
    let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const hunks = [];
    for (let i = 0; i < s; i++) hunks.push({ t: ' ', line: a[i] });
    for (let i = s; i < ea; i++) hunks.push({ t: '-', line: a[i] });
    for (let i = s; i < eb; i++) hunks.push({ t: '+', line: b[i] });
    for (let i = ea; i < a.length; i++) hunks.push({ t: ' ', line: a[i] });
    return { hunks, added: hunks.filter((h) => h.t === '+').length, removed: hunks.filter((h) => h.t === '-').length };
  }

  async function applyProposal(p) {
    if (wsMode === 'real') {
      const r = await workspaceFs.write(p.path, p.content, { ...policy(), confirm: true });
      if (!r.ok) { notify(r.error || 'Apply refused'); return; }
    } else {
      setDemoFs((fs0) => ({ ...fs0, [p.path]: p.content }));
    }
    applyProposalLocally(p, false);
  }

  function applyProposalLocally(p, silent) {
    setProposals((ps) => ps.map((x) => x.id === p.id ? { ...x, applied: true } : x));
    if (active?.path === p.path) setActive({ ...active, content: p.content, base: p.content });
    if (!silent) notify(`Applied ${p.path} (+${p.added}/−${p.removed})`);
    else notify(`Auto-applied ${p.path} (+${p.added}/−${p.removed}) under ${mode}`);
    loadDir(path0(p.path));
  }

  // --- AGENTS.md / egress (unchanged behavior, real calls) ----------------------
  async function loadAgents() {
    try {
      const r = await workspaceApi.context({ cwd: cwd || undefined, sandbox: { mode: sandbox, network_access: net } });
      setAgents(r); setShowAgents(true);
      if (r.ok) { notify(`${r.documents.length} AGENTS.md file(s) · ${r.bytes}/${r.max_bytes} bytes · ${r.describe}`); if (cwd) localStorage.setItem('acx_workspace_cwd', cwd); }
      else notify(r.error || 'Could not read AGENTS.md');
    } catch (e) { notify('Could not read AGENTS.md: ' + e.message); }
  }

  async function toggleNet(on) {
    try {
      setEgress(await (on ? egressApi.start({ mode: 'allowlist' }) : egressApi.stop()));
      setNet(on);
      if (on === false) setEgress((e) => ({ ...e, running: false, allowed: 0, denied: 0 }));
    } catch (e) { notify('Egress: ' + e.message); setNet(false); }
  }

  // --- tree rendering -------------------------------------------------------------
  function TreeNode({ dir, depth }) {
    const n = nodes[dir];
    if (!n) return null;
    return (
      <>
        {n.dirs.map((d) => (
          <div key={d.path}>
            <button className="file-item" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => {
              if (openDirs[d.path]) setOpenDirs((o) => ({ ...o, [d.path]: false }));
              else { setOpenDirs((o) => ({ ...o, [d.path]: true })); if (!nodes[d.path]) loadDir(d.path); }
            }}>
              {openDirs[d.path] ? '▾' : '▸'} {d.name}/
            </button>
            {openDirs[d.path] && <TreeNode dir={d.path} depth={depth + 1} />}
          </div>
        ))}
        {n.files.map((f) => (
          <button key={f.path} className={`file-item ${active?.path === f.path ? 'active' : ''}`}
            style={{ paddingLeft: 10 + depth * 12 }} onClick={() => openFile(f.path)}>
            ▤ {f.name} <span className="tiny" style={{ opacity: 0.5 }}>{f.bytes}B</span>
          </button>
        ))}
      </>
    );
  }

  const dirty = active && active.content !== active.base;

  return (
    <div className="workspace">
      <div className="file-tree">
        <div className="row between" style={{ padding: '4px 8px 10px' }}>
          <b style={{ fontSize: 12, letterSpacing: 1 }}>{wsMode === 'real' ? 'WORKSPACE' : 'DEMO FILES'}</b>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn small ghost" title="new file" onClick={newFile}>+file</button>
            <button className="btn small ghost" title="new folder" onClick={async () => {
              const name = window.prompt('New folder name'); if (!name) return;
              const r = await workspaceFs.mkdir(name, policy());
              if (r.ok) loadDir(''); else if (!r.needs_approval) notify(r.error);
            }}>+dir</button>
          </div>
        </div>
        {wsMode === 'demo' && (
          <>
            {Object.keys(demoFs).map((f) => (
              <button key={f} className={`file-item ${active?.path === f ? 'active' : ''}`}
                onClick={() => setActive({ path: f, content: demoFs[f], base: demoFs[f] })}>▤ {f}</button>
            ))}
            <div className="tiny" style={{ padding: 10, opacity: 0.8 }}>
              Virtual demo workspace — <Link to="/desktop" style={{ color: 'var(--accent, #7c5cff)' }}>ANTICODEX Desktop</Link> (or your own <code>npm start</code>) edits a real folder here.
            </div>
          </>
        )}
        {wsMode === 'real' && <TreeNode dir="" depth={0} />}

        <div className="nav-section" style={{ marginTop: 14 }}>Approval mode</div>
        {MODES.map((m) => (
          <button key={m.id} className={`file-item ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
            {mode === m.id ? '◉' : '○'} {m.label}
          </button>
        ))}
        <div className="tiny" style={{ padding: '8px 10px' }}>{MODES.find((m) => m.id === mode)?.desc}</div>
        <div className="nav-section">Sandbox</div>
        {SANDBOXES.map((sb) => (
          <button key={sb.id} className={`file-item ${sandbox === sb.id ? 'active' : ''}`} onClick={() => setSandbox(sb.id)}>
            {sandbox === sb.id ? '◉' : '○'} {sb.label}
          </button>
        ))}
        <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px' }}>
          <input type="checkbox" checked={net} onChange={(e) => toggleNet(e.target.checked)} /> allow network
        </label>
        <div className="tiny mono" style={{ padding: '0 10px 8px', opacity: 0.8 }}>
          {egress.running
            ? `${egress.url} · ${egress.allowed || 0} allowed / ${egress.denied || 0} denied · ${egress.policy?.mode || 'allowlist'}`
            : egress.local === false ? 'egress needs the desktop app or a local start' : 'off — spawned work gets no proxy'}
        </div>
        <div className="nav-section">Agent tools</div>
        <div className="tiny" style={{ padding: '2px 10px 8px', lineHeight: 1.6 }}>
          {agentTools.loading ? 'Reading connectors…' : (
            <>
              {agentTools.connections.filter((c) => c.status === 'connected').map((c) => (
                <div key={c.id} className="row between" style={{ gap: 6 }}>
                  <span className="kbd">{c.id}</span>
                  <span style={{ opacity: 0.7 }}>{(c.tools || []).length} tools</span>
                </div>
              ))}
              {!agentTools.connections.some((c) => c.status === 'connected') && <div style={{ opacity: 0.7 }}>No connectors yet.</div>}
              <div style={{ marginTop: 6 }}>
                {agentTools.rea?.registered
                  ? <span style={{ color: '#6ee7a8' }}>REA installed · {agentTools.rea.probe?.tools || 207} tools</span>
                  : <Link to="/rea" style={{ color: 'var(--accent, #7c5cff)' }}>Install REA →</Link>}
              </div>
            </>
          )}
        </div>
        <div className="nav-section">AGENTS.md</div>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="workspace path (blank = app dir)"
          style={{ margin: '0 8px 6px', width: 'calc(100% - 16px)' }} />
        <button className="file-item" onClick={loadAgents}>
          ⇩ {agents?.ok ? `reload (${agents.documents.length} found)` : 'load project docs'}
        </button>
      </div>

      <div className="editor-pane">
        <div className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{active ? active.path : 'no file open'}</b>
          <div className="row" style={{ gap: 6 }}>
            {active && dirty && <Pill kind="warn">unsaved</Pill>}
            {active?.truncated && <Pill kind="warn">truncated</Pill>}
            <Pill kind={sandbox === 'danger-full-access' ? 'warn' : 'ok'}>{sandbox}{net ? ' · net' : ''}</Pill>
            {active && <CopyBtn text={active.content} />}
            {active && <button className="btn small ghost" onClick={deleteActive}>rm</button>}
            {active && <button className="btn small primary" disabled={!dirty} onClick={saveActive}>Save</button>}
          </div>
        </div>
        {pending && (
          <div className="row between" style={{ padding: '8px 14px', background: 'rgba(252,165,165,0.08)', borderBottom: '1px solid var(--border-soft)', gap: 8 }}>
            <span className="tiny">{mode} policy asks before <b>{pending.kind}</b>: <code>{String(pending.label).slice(0, 80)}</code></span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" onClick={() => pending.retry?.()}>Allow</button>
              <button className="btn small ghost" onClick={() => setPending(null)}>Deny</button>
            </div>
          </div>
        )}
        {active ? (
          <textarea
            value={active.content}
            spellCheck={false}
            onChange={(e) => setActive((a) => ({ ...a, content: e.target.value }))}
            placeholder="empty file"
          />
        ) : (
          <div className="muted" style={{ padding: 16, flex: 1 }}>Select a file from the tree.</div>
        )}
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
              onKeyDown={(e) => e.key === 'Enter' && runTerm()}
              style={{ background: 'transparent', border: 'none', color: '#9fe8b8', fontFamily: 'var(--mono)', fontSize: 12, padding: 0 }}
              placeholder={wsMode === 'real' ? 'real shell — ls, node file.js, anything' : 'demo: ls, cat, write…'}
            />
          </div>
        </div>
      </div>

      <div className="agent-pane">
        <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontSize: 13 }}>Codex agent</b>
          <Pill>{mode}</Pill>
        </div>
        {agents && (
          <div style={{ borderBottom: '1px solid var(--border-soft)', padding: '8px 12px', fontSize: 12 }}>
            {agents.ok ? (
              <>
                <div className="row between">
                  <span className="tiny">{agents.documents.length} AGENTS.md · {agents.bytes}/{agents.max_bytes} bytes{agents.truncated ? ' · truncated' : ''} · {agents.describe}</span>
                  <button className="btn small ghost" onClick={() => setShowAgents((v) => !v)}>{showAgents ? 'hide' : 'show'}</button>
                </div>
                {agents.documents.map((d) => (
                  <div key={d.path} className="tiny mono" style={{ opacity: .75 }}>{d.display} · {d.scope} · {d.bytes}B</div>
                ))}
                {showAgents && <pre className="term" style={{ marginTop: 6, maxHeight: 180, whiteSpace: 'pre-wrap' }}>{agents.instructions || '(no instructions)'}</pre>}
              </>
            ) : (
              <div className="tiny">⚠ {agents.error}{agents.needs_local ? ' Open the desktop app to read project docs.' : ''}</div>
            )}
          </div>
        )}
        <div className="messages" style={{ flex: 1, overflowY: 'auto' }}>
          {messages.length === 0 && proposals.length === 0 && (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>
              Ask the agent to explain the project, propose a refactor, or run a task.
              Proposals show a real diff and apply only through the same policy the sidebar shows.
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
          {proposals.map((p) => (
            <div key={p.id} className="msg-row" style={{ marginBottom: 14 }}>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>Δ</div>
              <div className="msg-body" style={{ width: '100%' }}>
                <div className="row between" style={{ gap: 8, marginBottom: 6 }}>
                  <b className="mono" style={{ fontSize: 12 }}>{p.path}</b>
                  <span className="tiny" style={{ color: '#9fe8b8' }}>+{p.added}</span>
                  <span className="tiny" style={{ color: '#fca5a5' }}>−{p.removed}</span>
                  <div style={{ flex: 1 }} />
                  {p.applied
                    ? <Pill kind="ok">applied</Pill>
                    : <button className="btn small primary" onClick={() => applyProposal(p)}>Apply diff</button>}
                </div>
                <DiffView hunks={p.hunks} truncated_hunks={p.truncated_hunks} />
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
              <ModelPicker compact />
              <div style={{ flex: 1 }} />
              <button className="btn primary small" disabled={busy || !input.trim()} onClick={askAgent}>{busy ? '…' : 'Run ⏎'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}