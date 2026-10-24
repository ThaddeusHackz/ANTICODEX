import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sandbox as sbx, image as imageApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';

// Sandbox — where generated code is actually run.
//
// The point of this page is the thing that makes a code agent trustworthy: the
// program it wrote either produced that output on this machine, or it did not.
// No "here is some code, try it" — press Run and the stdout below came from a
// real process in a temporary directory that is thrown away.
//
// Two halves:
//   * write (or paste) code and run it, with the language, the timeout, and the
//     files it left behind;
//   * describe what you want, let the model write it (the same Fast/Balanced/Max
//     deliberation setting as chat), then run that.
//
// It is local-only on purpose: executing arbitrary code is not something a shared
// server may do for whoever asks. The desktop app runs the same page against the
// same bridge on your own machine.
const LANGS = [
  { id: 'node', label: 'JavaScript', sample: 'const t = Date.now();\nconsole.log("hello from the sandbox");\nconsole.log("node", process.version);\nconsole.log("took", Date.now() - t, "ms (plus startup)");' },
  { id: 'python', label: 'Python', sample: 'import sys, platform\nprint("hello from the sandbox")\nprint("python", platform.python_version())\nprint("isolated:", not hasattr(sys, "real_prefix"))' },
  { id: 'bash', label: 'Shell', sample: 'echo "hello from the sandbox"\nuname -srm\nls -la | head -5' }
];

export default function SandboxPage() {
  const { model, effort, notify } = useApp();
  const [lang, setLang] = useState('node');
  const [code, setCode] = useState(LANGS[0].sample);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(8000);
  const [viewing, setViewing] = useState(null);
  const taRef = useRef(null);

  useEffect(() => {
    sbx.status().then(setStatus).catch((e) => setStatus({ ok: false, error: e.message }));
  }, []);

  const switchLang = (id) => {
    const next = LANGS.find((l) => l.id === id);
    setLang(id);
    if (next && (!code.trim() || LANGS.some((l) => l.sample === code))) setCode(next.sample);
  };

  async function run() {
    if (busy) return;
    setBusy('run');
    setViewing(null);
    try {
      const out = await sbx.run({ language: lang, code, timeout_ms: Number(timeoutMs) || 8000 });
      setResult(out);
      if (out.timed_out) notify(`Stopped after ${Math.round((out.duration_ms || 0) / 1000)}s — the run hit its limit`, 'warn');
      else if (out.ok) notify(`Ran in ${out.duration_ms} ms`);
      else notify(out.error || `Exited ${out.exit_code}`, 'warn');
    } catch (e) {
      setResult({ ok: false, error: e.message || String(e) });
      notify(e.message || 'Could not run that', 'warn');
    } finally { setBusy(''); }
  }

  async function generate() {
    const ask = prompt.trim();
    if (!ask || busy) return;
    setBusy('gen');
    try {
      const [pid, ...rest] = String(model || '').split('::');
      const out = await sbx.generate({
        prompt: ask,
        language: lang === 'python' ? 'python' : lang === 'bash' ? 'shell' : 'JavaScript',
        model: rest.join('::') || model,
        provider: rest.length ? pid : undefined,
        effort
      });
      if (!out.ok || !out.code) { notify('The model did not return code — try a narrower ask'); return; }
      setCode(out.code);
      notify('Code written — Run to see what it actually does');
      setTimeout(() => taRef.current?.focus(), 40);
    } catch (e) {
      notify(e.message || 'Code generation failed', 'warn');
    } finally { setBusy(''); }
  }

  async function openFile(name) {
    if (!result?.run_id) return;
    try {
      const r = await sbx.read(result.run_id, name);
      setViewing(r.ok ? { name, content: r.content } : { name, content: r.error || 'could not read it' });
    } catch (e) { setViewing({ name, content: e.message }); }
  }

  const blocked = status && status.ok === false;
  const langs = status?.languages || [];

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Sandbox</h1>
          <p className="tiny">
            Write code, or let the model write it, then run it for real. Every run gets a fresh
            directory, a scrubbed environment and {Math.round((status?.limits?.max_timeout_ms || 15000) / 1000)}s at most.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn small ghost" to="/images">Image gen →</Link>
          <Link className="btn small ghost" to="/codex">Codex workspace →</Link>
        </div>
      </div>

      {blocked && (
        <div className="card sb-blocked">
          <strong>Running code happens on your own machine.</strong>
          <p className="tiny">{status.error}</p>
          <p className="tiny">Install ANTICODEX Desktop — the Sandbox works there, with your own Node and Python.</p>
        </div>
      )}

      {status?.ok && (
        <div className="row sb-meta">
          {langs.map((l) => (
            <span key={l.id} className={`sb-lang${l.available ? ' on' : ''}`} title={l.hint || ''}>
              {l.label} {l.available ? '·' : '· missing'}
            </span>
          ))}
          <span className="tiny">runs kept: {status.runs?.length || 0}</span>
        </div>
      )}

      <div className="sb-grid">
        <div className="card sb-pane">
          <div className="row sb-pane-head">
            <select className="sb-select" value={lang} onChange={(e) => switchLang(e.target.value)} aria-label="Language">
              {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <select className="sb-select" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} aria-label="Time limit">
              {[2000, 5000, 8000, 12000, 15000].map((ms) => <option key={ms} value={ms}>{ms / 1000}s limit</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <button className="btn small" onClick={run} disabled={Boolean(busy) || blocked}>
              {busy === 'run' ? 'Running…' : '▶ Run'}
            </button>
          </div>
          <textarea
            ref={taRef}
            className="sb-code"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } }}
            aria-label="Code"
          />
          <div className="row sb-gen">
            <input
              className="sb-input"
              placeholder="…or describe it: “fibonacci up to 1000, printed one per line”"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            />
            <button className="btn small ghost" onClick={generate} disabled={Boolean(busy) || !prompt.trim()}>
              {busy === 'gen' ? 'Writing…' : `Write with ${effort}`}
            </button>
          </div>
        </div>

        <div className="card sb-pane">
          <div className="row sb-pane-head">
            <strong className="tiny">Output</strong>
            {result?.run_id && <span className="tiny sb-runid">run {result.run_id}</span>}
            <div style={{ flex: 1 }} />
            {result && (
              <span className={`badge ${result.ok ? 'ok' : 'warn'}`}>
                {result.timed_out ? 'timed out' : result.ok ? 'exit 0' : `exit ${result.exit_code}`} · {result.duration_ms} ms
              </span>
            )}
          </div>
          {!result && <p className="tiny">Nothing has run yet. Press Run — the output below is the real process.</p>}
          {result?.error && !result.stdout && <pre className="sb-out sb-err">{result.error}</pre>}
          {result && (
            <>
              <pre className="sb-out">{result.stdout || '(no stdout)'}</pre>
              {result.stderr ? <pre className="sb-out sb-err">{result.stderr}</pre> : null}
              {result.truncated && <p className="tiny">Output was cut at {status?.limits?.max_output_bytes || 64000} bytes.</p>}
              {(result.files || []).length > 0 && (
                <div className="row sb-files">
                  <span className="tiny">files:</span>
                  {result.files.map((f) => (
                    <button key={f.name} className="pill sb-file" onClick={() => openFile(f.name)} title={`${f.bytes} bytes`}>
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
              {viewing && (
                <div className="sb-view">
                  <div className="row">
                    <span className="tiny">{viewing.name}</span>
                    <div style={{ flex: 1 }} />
                    <button className="icon-btn" title="Close" onClick={() => setViewing(null)}>×</button>
                  </div>
                  <pre className="sb-out">{viewing.content}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card sb-note">
        <strong className="tiny">What this is not</strong>
        <p className="tiny">
          The sandbox is a separate directory, a scrubbed environment and a hard time limit — not a container.
          A program can still open sockets and read files it has permission to read. It runs only for the person
          sitting at the machine (the desktop app, or a server you started yourself), never for a remote visitor.
        </p>
      </div>
    </div>
  );
}
