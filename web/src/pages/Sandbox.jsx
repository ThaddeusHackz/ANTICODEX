import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sandbox as sbx } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import Icon from '../Icon.jsx';

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

const EMPTY_REMOTE = {
  loading: true,
  available: false,
  profiles: [],
  defaults: null,
  note: '',
  error: null
};

/** Mirror of lib/remote.js parseSshTarget for instant form feedback. The server
 *  parses again before saving, so a client bug cannot persist a different host. */
function parseSshCommand(raw) {
  const text = String(raw || '').trim().replace(/^[$>]\s*/, '');
  if (!text) return null;
  const tokens = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = rx.exec(text))) tokens.push(m[1] ?? m[2] ?? m[3]);
  if (!tokens.length) return null;
  let username = '', host = '', port = 22;
  let i = /^ssh(\.exe)?$/i.test(tokens[0]) ? 1 : 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-p' || t === '--port') { port = Number(tokens[++i]); continue; }
    if (/^-p\d+$/.test(t)) { port = Number(t.slice(2)); continue; }
    if (t === '-l') { username = String(tokens[++i] || ''); continue; }
    if (t.startsWith('-')) return { ok: false, error: `Flag ${t} is not supported here — use a plain ssh user@host.` };
    const at = t.lastIndexOf('@');
    if (at > 0) { username = t.slice(0, at); host = t.slice(at + 1); }
    else host = t;
    const colon = host.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) { port = Number(host.slice(colon + 1)); host = host.slice(0, colon); }
  }
  if (!username || !host || !Number.isInteger(port)) return { ok: false, error: 'Expected a command like ssh user@ssh.app.daytona.io.' };
  return { ok: true, username, host, port };
}

const looksLikeAccessString = (host, username) => /^[A-Za-z0-9_-]{24,}$/.test(String(username || '')) && /(^|\.)daytona\.io$/i.test(String(host || ''));

const blankProfile = (defaults = {}) => ({
  id: '',
  label: '',
  host: defaults.host || 'ssh.app.daytona.io',
  port: defaults.port || 22,
  username: defaults.username || '',
  key_path: defaults.key_path || ''
});

export default function SandboxPage() {
  const { model, effort, notify, user } = useApp();
  const account = String(user?.id ?? 'anon');
  const [lang, setLang] = useState('node');
  const [code, setCode] = useState(LANGS[0].sample);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(8000);
  const [viewing, setViewing] = useState(null);
  const [target, setTarget] = useState('local');
  const [remote, setRemote] = useState(EMPTY_REMOTE);
  const [profileId, setProfileId] = useState('');
  const [form, setForm] = useState(() => blankProfile());
  const [remoteBusy, setRemoteBusy] = useState('');
  const [remoteCheck, setRemoteCheck] = useState(null);
  const [sshPaste, setSshPaste] = useState('');
  const [pasteNote, setPasteNote] = useState(null);
  const [storedCredential, setStoredCredential] = useState(false);
  const taRef = useRef(null);

  function applyRemote(next) {
    if (!next) return;
    setRemote((cur) => ({ ...cur, ...next, loading: false, profiles: next.profiles || [] }));
    const defaults = next.defaults || {};
    setForm((f) => ({
      ...f,
      host: f.host || defaults.host || 'ssh.app.daytona.io',
      port: f.port || defaults.port || 22,
      username: f.username || defaults.username || '',
      key_path: f.key_path || defaults.key_path || ''
    }));
    if (Array.isArray(next.profiles)) {
      setProfileId((cur) => (cur && next.profiles.some((p) => p.id === cur) ? cur : (next.profiles[0]?.id || '')));
    }
  }

  // The first saved profile is the default target. Fill the form with it so
  // "Test connection" tests the thing that is actually selected, not a blank.
  useEffect(() => {
    if (form.id || form.username) return;
    const p = remote.profiles.find((x) => x.id === profileId);
    if (p) {
      setForm({ id: p.id, label: p.label, host: p.host, port: p.port, username: p.username || '', key_path: p.key_path || '' });
      setStoredCredential(Boolean(p.has_credential));
    }
  }, [profileId, remote.profiles, form.id, form.username]);

  useEffect(() => {
    let gone = false;
    sbx.status().then((s) => { if (!gone) setStatus(s); })
      .catch((e) => { if (!gone) setStatus({ ok: false, error: e.message }); });
    // Profiles are per account; the status action also returns a copy for the
    // default account, which must not overwrite the signed-in account's list.
    sbx.remoteStatus(account)
      .then((r) => { if (!gone) applyRemote(r); })
      .catch((e) => { if (!gone) setRemote((cur) => ({ ...cur, loading: false, error: e.message || String(e) })); });
    return () => { gone = true; };
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchLang = (id) => {
    const next = LANGS.find((l) => l.id === id);
    setLang(id);
    if (next && (!code.trim() || LANGS.some((l) => l.sample === code))) setCode(next.sample);
  };

  async function run() {
    if (busy) return;
    if (target === 'remote') return runRemote();
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

  async function runRemote() {
    if (!profileId) {
      notify('Save or select an SSH profile first — the sandbox will not guess a host.', 'warn');
      return;
    }
    if (!remote.available) {
      notify('OpenSSH is not installed on this machine, so there is nothing to connect with.', 'warn');
      return;
    }
    setBusy('run');
    setViewing(null);
    try {
      const out = await sbx.remoteRun(account, {
        id: profileId, language: lang, code, timeout_ms: Number(timeoutMs) || 8000
      });
      setResult(out);
      if (out.timed_out) notify(out.error || 'The remote run hit its time limit', 'warn');
      else if (out.ok) notify(`Ran on ${out.username}@${out.host} in ${out.duration_ms} ms`);
      else notify(out.error || `Remote exit ${out.exit_code}`, 'warn');
    } catch (e) {
      setResult({ ok: false, remote: true, error: e.message || String(e) });
      notify(e.message || 'Could not run that remotely', 'warn');
    } finally { setBusy(''); }
  }

  // --- saved SSH profiles ---------------------------------------------------
  function selectProfile(p) {
    setProfileId(p.id);
    setForm({ id: p.id, label: p.label, host: p.host, port: p.port, username: p.username || '', key_path: p.key_path || '' });
    setStoredCredential(Boolean(p.has_credential));
    setPasteNote(null);
    setRemoteCheck(null);
    setSshPaste('');
  }

  function newProfile() {
    setProfileId('');
    setForm(blankProfile(remote.defaults || {}));
    setStoredCredential(false);
    setPasteNote(null);
    setRemoteCheck(null);
    setSshPaste('');
  }

  /** One field for the thing Daytona actually shows you. Fills host, port and
   *  username at once; the access string itself is never rendered back. */
  function applySshPaste(raw) {
    setSshPaste(raw);
    if (!raw.trim()) { setPasteNote(null); return; }
    const parsed = parseSshCommand(raw);
    if (!parsed) { setPasteNote(null); return; }
    if (!parsed.ok) { setPasteNote({ error: parsed.error }); return; }
    const secret = looksLikeAccessString(parsed.host, parsed.username);
    setForm((f) => ({
      ...f,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      label: f.label || (secret ? `Daytona ${parsed.host}` : '')
    }));
    setStoredCredential(false);
    setPasteNote({
      ok: true,
      host: parsed.host,
      port: parsed.port,
      username: secret ? `${parsed.username.slice(0, 4)}…${parsed.username.slice(-4)}` : parsed.username,
      access: secret
    });
    setSshPaste('');
    setRemoteCheck(null);
  }

  function field(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function saveProfile() {
    if (remoteBusy) return;
    setRemoteBusy('save');
    try {
      const payload = {
        ...form,
        port: Number(form.port) || 22,
        label: form.label.trim() || (form.username.trim() ? `${form.username.trim()}@${form.host.trim()}` : '')
      };
      const out = await sbx.remoteSave(account, payload);
      if (!out.ok) throw new Error(out.error || 'Could not save that profile.');
      setRemote((cur) => ({ ...cur, profiles: out.profiles || [], count: (out.profiles || []).length, error: null }));
      setProfileId(out.profile.id);
      setStoredCredential(Boolean(out.profile.has_credential));
      setForm({ id: out.profile.id, label: out.profile.label, host: out.profile.host, port: out.profile.port, username: out.profile.username || '', key_path: out.profile.key_path || '' });
      setRemoteCheck(null);
      notify(`Saved SSH profile ${out.profile.label}`);
    } catch (e) {
      notify(e.message || 'Could not save that profile.', 'warn');
    } finally { setRemoteBusy(''); }
  }

  async function deleteProfile(p) {
    if (remoteBusy) return;
    if (!window.confirm(`Remove the SSH profile "${p.label}"? The key file itself is not touched.`)) return;
    setRemoteBusy('delete');
    try {
      const out = await sbx.remoteDelete(account, p.id);
      if (!out.ok) throw new Error(out.error || 'Could not remove that profile.');
      setRemote((cur) => ({ ...cur, profiles: out.profiles || [], count: (out.profiles || []).length }));
      if (profileId === p.id) {
        const next = (out.profiles || [])[0];
        if (next) selectProfile(next); else { setProfileId(''); newProfile(); }
      }
      notify('SSH profile removed');
    } catch (e) {
      notify(e.message || 'Could not remove that profile.', 'warn');
    } finally { setRemoteBusy(''); }
  }

  async function testProfile() {
    if (remoteBusy) return;
    setRemoteBusy('test');
    setRemoteCheck(null);
    try {
      // Test what is in the form, not a stale saved copy: an edited host or key
      // path must fail (or pass) on its own values before someone saves it.
      const { id, ...draft } = form;
      const out = await sbx.remoteTest(account, { ...draft, id: id || undefined, port: Number(draft.port) || 22 });
      setRemoteCheck(out);
      if (out.ok) notify('SSH reached the remote machine — probe output is below');
      else notify(out.error || 'The SSH test did not succeed', 'warn');
    } catch (e) {
      setRemoteCheck({ ok: false, error: e.message || String(e) });
      notify(e.message || 'The SSH test did not run', 'warn');
    } finally { setRemoteBusy(''); }
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
  const selectedProfile = remote.profiles.find((p) => p.id === profileId) || null;
  const remoteReady = Boolean(selectedProfile) && remote.available && !remote.loading;
  const runDisabled = Boolean(busy) || (target === 'remote' ? !remoteReady : Boolean(blocked));

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

      <div className="sb-target" role="tablist" aria-label="Where to run">
        <button
          role="tab" aria-selected={target === 'local'}
          className={`sb-target-btn ${target === 'local' ? 'on' : ''}`}
          onClick={() => setTarget('local')}
        >
          <Icon name="terminal" size={15} /> This machine
        </button>
        <button
          role="tab" aria-selected={target === 'remote'}
          className={`sb-target-btn ${target === 'remote' ? 'on' : ''}`}
          onClick={() => setTarget('remote')}
        >
          <Icon name="remote" size={15} /> Remote over SSH
        </button>
        <span className="tiny sb-target-note">
          {target === 'local'
            ? 'A fresh directory and a hard time limit on this computer.'
            : selectedProfile
              ? `${selectedProfile.username || selectedProfile.username_hint || 'stored access string'}@${selectedProfile.host}:${selectedProfile.port}`
              : 'Save an SSH profile below, then run there.'}
        </span>
      </div>

      {target === 'remote' && (
        <div className="card sb-remote">
          <div className="row between sb-remote-head">
            <div>
              <strong>Remote over SSH</strong>
              <div className="tiny">
                Runs the snippet on a machine you own — Daytona, a dev box, a CI runner. The profile stores
                host, port, username and an optional key <em>path</em>; never a password and never the key itself.
              </div>
            </div>
            <span className={`badge ${remote.available ? 'ok' : remote.loading ? '' : 'warn'}`}>
              {remote.loading ? 'Checking OpenSSH…' : remote.available ? 'OpenSSH ready' : 'OpenSSH missing'}
            </span>
          </div>

          {remote.error && <p className="tiny sb-err">{remote.error}</p>}

          <div className="sb-remote-grid">
            <div className="sb-remote-list">
              <div className="sb-label">Saved profiles</div>
              {!remote.loading && remote.profiles.length === 0 && (
                <div className="tiny sb-empty">No profiles yet. The form on the right saves one.</div>
              )}
              {remote.profiles.map((p) => (
                <div key={p.id} className={`sb-profile ${profileId === p.id ? 'on' : ''}`}>
                  <button className="sb-profile-main" onClick={() => selectProfile(p)} title={`Use ${p.label}`}>
                    <span className="sb-profile-name">{p.label}</span>
                    <span className="sb-profile-meta">
                      {p.username || p.username_hint || 'access string stored'}@{p.host}:{p.port}
                      {' · '}
                      {p.has_credential ? '24h access string' : p.key_path ? p.key_path : 'ssh config / agent'}
                    </span>
                  </button>
                  <button
                    className="icon-btn sb-profile-del"
                    title={`Remove ${p.label}`}
                    onClick={() => deleteProfile(p)}
                    disabled={Boolean(remoteBusy)}
                  ><Icon name="trash" size={14} /></button>
                </div>
              ))}

              <div className="tiny sb-remote-note">
                <Icon name="key" size={13} />
                <span>Auth is this machine&apos;s SSH config, ssh-agent and keys first (<span className="mono">BatchMode=yes</span>). A key path only needs setting when OpenSSH cannot already reach the host.</span>
              </div>

              <div className="row sb-remote-actions">
                <button
                  className="btn small ghost"
                  onClick={testProfile}
                  disabled={Boolean(remoteBusy) || (!form.id && !form.username.trim())}
                >{remoteBusy === 'test' ? 'Testing…' : 'Test connection'}</button>
                <button className="btn small ghost" onClick={newProfile} disabled={Boolean(remoteBusy)}>New profile</button>
              </div>

              {remoteCheck && (
                <div className={`sb-check ${remoteCheck.ok ? 'ok' : 'err'}`}>
                  <div className="row between">
                    <b className="tiny">{remoteCheck.ok ? 'Reachable' : 'Not reachable'}</b>
                    <span className="tiny">{remoteCheck.duration_ms != null ? `${remoteCheck.duration_ms} ms` : ''}{remoteCheck.exit_code != null ? ` · exit ${remoteCheck.exit_code}` : ''}</span>
                  </div>
                  {remoteCheck.error && <p className="tiny sb-err">{remoteCheck.error}</p>}
                  {(remoteCheck.probe || []).length > 0 && <pre className="sb-out">{remoteCheck.probe.join('\n')}</pre>}
                  {!remoteCheck.ok && remoteCheck.stderr && <pre className="sb-out sb-err">{String(remoteCheck.stderr).slice(-1200)}</pre>}
                </div>
              )}
            </div>

            <div className="sb-profile-form">
              <div className="row between">
                <div className="sb-label">{form.id ? 'Edit profile' : 'New profile'}</div>
                {form.id && <span className="pill">saved</span>}
              </div>
              <div className="sb-fields">
                <label className="sb-field sb-field-wide">
                  <span>Paste the SSH command <span className="tiny">(the whole line from Daytona / your host)</span></span>
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      value={sshPaste}
                      onChange={(e) => setSshPaste(e.target.value)}
                      onPaste={(e) => {
                        const text = e.clipboardData?.getData('text');
                        if (text) { e.preventDefault(); applySshPaste(text); }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applySshPaste(sshPaste); } }}
                      placeholder="ssh At2W…@ssh.app.daytona.io"
                      spellCheck={false}
                      autoComplete="off"
                      className="mono"
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="btn small ghost" onClick={() => applySshPaste(sshPaste)} disabled={!sshPaste.trim()}>
                      Fill fields
                    </button>
                  </div>
                </label>
                {pasteNote && (
                  <div className={`sb-paste-note ${pasteNote.error ? 'err' : 'ok'}`}>
                    {pasteNote.error
                      ? pasteNote.error
                      : <>Parsed <b>{pasteNote.username}@{pasteNote.host}:{pasteNote.port}</b>{pasteNote.access ? ' — this is a bearer access string, so it is stored on this machine and shown only as a hint.' : ''}</>}
                  </div>
                )}
                <label className="sb-field">
                  <span>Label</span>
                  <input value={form.label} onChange={(e) => field('label', e.target.value)} placeholder="Daytona workspace" />
                </label>
                <label className="sb-field">
                  <span>Host</span>
                  <input value={form.host} onChange={(e) => field('host', e.target.value)} placeholder="ssh.app.daytona.io" spellCheck={false} />
                </label>
                <label className="sb-field">
                  <span>Port</span>
                  <input type="number" min="1" max="65535" value={form.port} onChange={(e) => field('port', e.target.value)} />
                </label>
                <label className="sb-field">
                  <span>Username {looksLikeAccessString(form.host, form.username) ? <span className="tiny">(access string)</span> : null}</span>
                  <input
                    value={form.username}
                    onChange={(e) => { field('username', e.target.value); setStoredCredential(false); }}
                    type={looksLikeAccessString(form.host, form.username) ? 'password' : 'text'}
                    placeholder={storedCredential ? 'stored — paste the ssh command again to replace' : 'the account on that host'}
                    spellCheck={false} autoComplete="off"
                  />
                </label>
                <label className="sb-field sb-field-wide">
                  <span>Private key path <span className="tiny">(optional)</span></span>
                  <input value={form.key_path} onChange={(e) => field('key_path', e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
                </label>
              </div>
              <div className="row sb-profile-save">
                <button
                  className="btn small primary" onClick={saveProfile}
                  disabled={Boolean(remoteBusy) || !form.host.trim() || (!form.username.trim() && !storedCredential)}
                >
                  {remoteBusy === 'save' ? 'Saving…' : form.id ? 'Update profile' : 'Save profile'}
                </button>
                <span className="tiny">No password field on purpose — OpenSSH cannot use one non-interactively here.</span>
              </div>
              <p className="tiny sb-remote-hint">
                Daytona&apos;s gateway is <span className="mono">ssh.app.daytona.io:22</span>. A Daytona access string
                is a bearer credential that lasts up to <b>1,440 minutes (24 h)</b>; generate a fresh one when it expires.
                The profile also works for any host in your <span className="mono">~/.ssh/config</span>.
              </p>
            </div>
          </div>
        </div>
      )}

      {blocked && (
        <div className="card sb-blocked">
          <strong>Running code happens on your own machine.</strong>
          <p className="tiny">{status.error}</p>
          <p className="tiny">Install ANTICODEX Desktop — the Sandbox works there, with your own Node and Python. Remote SSH is gated the same way, because the bridge is the thing holding the connection.</p>
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
            <button
              className="btn small"
              onClick={run}
              disabled={runDisabled}
              title={target === 'remote' && !selectedProfile ? 'Save or select an SSH profile first' : target === 'remote' && !remote.available ? 'OpenSSH is not installed on this machine' : ''}
            >
              {busy === 'run' ? (target === 'remote' ? 'Running over SSH…' : 'Running…') : target === 'remote' ? '▶ Run remotely' : '▶ Run'}
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
            {result?.remote && (
              <span className="pill sb-remote-badge"><Icon name="remote" size={12} /> {result.username}@{result.host}</span>
            )}
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
          {result?.error && result.stdout && <p className="tiny sb-err">{result.error}</p>}
          {result && (
            <>
              <pre className="sb-out">{result.stdout || '(no stdout)'}</pre>
              {result.stderr ? <pre className="sb-out sb-err">{result.stderr}</pre> : null}
              {result.truncated && <p className="tiny">Output was cut at {status?.limits?.max_output_bytes || 64000} bytes.</p>}
              {!result.remote && (result.files || []).length > 0 && (
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
