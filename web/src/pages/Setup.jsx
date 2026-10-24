import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { Field, Switch, Pill, CopyBtn } from '../ui.jsx';

/**
 * Two things live here because they are the same idea: this machine already has
 * a setup, and the product should adopt it instead of asking you to re-enter it.
 *
 *   1. Bring your setup — reads a Codex `config.toml` and a Claude
 *      `.claude/settings.json` + `policy-limits.json` (the schemas recovered
 *      from the two desktop apps; see docs/REA-EVIDENCE.md) and shows exactly
 *      what it would connect and change BEFORE anything is written.
 *   2. Policy — the same shape of feature gate those apps ship, with every
 *      capability named and an explicit on/off.
 */

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('could not read ' + file.name));
    fr.readAsText(file);
  });
}

export default function SetupPage() {
  const { notify, user } = useApp();
  const [codexToml, setCodexToml] = useState('');
  const [claudeSettings, setClaudeSettings] = useState('');
  const [claudePolicy, setClaudePolicy] = useState('');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [policy, setPolicy] = useState(null);
  const [flagMeta, setFlagMeta] = useState({});
  const codexFile = useRef(null);
  const claudeFile = useRef(null);
  const policyFile = useRef(null);

  async function loadPolicy() {
    try {
      const r = await api.policy.get();
      setPolicy(r.policy);
      setFlagMeta(r.flags || {});
    } catch (e) { notify('Could not load policy: ' + e.message); }
  }
  useEffect(() => { loadPolicy(); }, []);

  async function preview() {
    setBusy('preview');
    try {
      const r = await api.importConfig({
        codex_toml: codexToml || undefined,
        claude_settings: claudeSettings || undefined,
        claude_policy: claudePolicy || undefined
      });
      setPlan(r);
      const s = r.summary || {};
      notify(`Plan ready — ${s.providers || 0} provider(s), ${s.mcp || 0} MCP server(s), ${s.flags || 0} flag(s). Nothing written yet.`);
    } catch (e) {
      notify('Could not read that config: ' + e.message);
    } finally { setBusy(''); }
  }

  async function apply() {
    if (!user) { notify('Sign in first — an import is stored with your account'); return; }
    setBusy('apply');
    try {
      const r = await api.importConfig({
        codex_toml: codexToml || undefined,
        claude_settings: claudeSettings || undefined,
        claude_policy: claudePolicy || undefined,
        apply: true
      });
      setPlan(r);
      // Custom providers and model aliases are a per-device choice in this
      // product, so they come back here rather than going into the ledger.
      if (r.providers?.length) {
        const existing = JSON.parse(localStorage.getItem('acx_custom_providers') || '[]');
        const byId = new Map(existing.map((p) => [p.id, p]));
        for (const p of r.providers) byId.set(p.id, { ...byId.get(p.id), ...p, added_at: Date.now() });
        localStorage.setItem('acx_custom_providers', JSON.stringify([...byId.values()]));
      }
      if (r.aliases?.length) localStorage.setItem('acx_model_aliases', JSON.stringify(r.aliases));
      if (r.migrations?.length) localStorage.setItem('acx_model_migrations', JSON.stringify(r.migrations));
      if (r.behaviour) localStorage.setItem('acx_behaviour', JSON.stringify(r.behaviour));
      notify(`Applied — ${r.applied?.length || 0} change(s)${r.skipped?.length ? `, ${r.skipped.length} skipped` : ''}`);
      await loadPolicy();
    } catch (e) {
      notify('Apply failed: ' + e.message);
    } finally { setBusy(''); }
  }

  async function toggleFlag(key, value) {
    if (!user) { notify('Sign in to change policy'); return; }
    const next = { ...policy, flags: { ...policy.flags, [key]: value } };
    setPolicy(next);
    try {
      const r = await api.policy.set({ flags: next.flags, defaults: next.defaults });
      setPolicy(r.policy);
      notify(`${flagMeta[key]?.label || key} ${value ? 'enabled' : 'disabled'}${r.persisted === false ? ' (this server is read-only, so it lasts for this session)' : ''}`);
    } catch (e) {
      notify('Could not save: ' + e.message);
      await loadPolicy();
    }
  }

  const s = plan?.summary || {};

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Bring your setup</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Adopt the configuration this machine already has — MCP servers, model providers, plugins,
            follow-up behaviour and feature policy. You see the plan before anything is written.
          </p>
        </div>
        <Pill kind={user ? 'ok' : 'warn'}>{user ? 'signed in' : 'read-only'}</Pill>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>1 · Codex / ChatGPT desktop</h3>
          <p className="sub">`~/.codex/config.toml` — model providers, MCP servers, marketplaces, plugins, desktop flags.</p>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <button className="btn ghost" onClick={() => codexFile.current?.click()}>Choose config.toml</button>
            <input ref={codexFile} type="file" accept=".toml,text/plain" style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try { setCodexToml(await readFile(f)); notify(`Read ${f.name} (${f.size} bytes)`); }
                catch (err) { notify(String(err.message || err)); }
              }} />
            <span className="tiny">{codexToml ? `${codexToml.length} chars loaded` : 'or paste below'}</span>
          </div>
          <textarea className="code-editor" rows={7} spellCheck={false} value={codexToml}
            onChange={(e) => setCodexToml(e.target.value)}
            placeholder={'model = "…"\n[model_providers.my-gateway]\nbase_url = "http://localhost:8080/v1"\n[mcp_servers.my_server]\ncommand = "npx"\nargs = ["-y", "some-mcp"]'} />
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>2 · Claude desktop</h3>
          <p className="sub">`.claude/settings.json` and `.claude/policy-limits.json` — base URL, model aliases, feature gates.</p>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <button className="btn ghost" onClick={() => claudeFile.current?.click()}>Choose settings.json</button>
            <input ref={claudeFile} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try { setClaudeSettings(await readFile(f)); notify(`Read ${f.name}`); }
                catch (err) { notify(String(err.message || err)); }
              }} />
            <button className="btn ghost" onClick={() => policyFile.current?.click()}>+ policy-limits.json</button>
            <input ref={policyFile} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try { setClaudePolicy(await readFile(f)); notify(`Read ${f.name}`); }
                catch (err) { notify(String(err.message || err)); }
              }} />
          </div>
          <textarea className="code-editor" rows={7} spellCheck={false} value={claudeSettings}
            onChange={(e) => setClaudeSettings(e.target.value)}
            placeholder={'{\n  "enableWorkflows": true,\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",\n    "ANTHROPIC_MODEL": "claude-sonnet-5"\n  }\n}'} />
          <div className="tiny" style={{ marginTop: 6 }}>
            A token in `env` is detected but never echoed back or stored by this page.
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 8, margin: '14px 0' }}>
        <button className="btn primary" onClick={preview} disabled={busy === 'preview' || (!codexToml && !claudeSettings && !claudePolicy)}>
          {busy === 'preview' ? 'Reading…' : 'Preview plan'}
        </button>
        <button className="btn" onClick={apply} disabled={!plan || busy === 'apply' || !user}>
          {busy === 'apply' ? 'Applying…' : 'Approve & apply'}
        </button>
        {plan && <span className="tiny">mode: {plan.mode} · providers {s.providers || 0} · mcp {s.mcp || 0} · plugins {s.plugins || 0} · flags {s.flags || 0} · aliases {s.aliases || 0}</span>}
      </div>

      {plan && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Plan</h3>
          {plan.providers?.length > 0 && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>Model providers</div>
              {plan.providers.map((p) => (
                <div key={p.id} className="perm-row">
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name} <span className="tiny">{p.wire_api}</span></div>
                    <div className="tiny">{p.endpoint} · key {p.key_env || '—'}{p.local ? ' · local gateway' : ''}</div>
                  </div>
                  <Pill kind="ok">provider</Pill>
                </div>
              ))}
            </>
          )}
          {plan.connections?.length > 0 && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>MCP servers</div>
              {plan.connections.map((c) => (
                <div key={c.id} className="perm-row">
                  <div>
                    <div style={{ fontWeight: 600 }}>{c.name} <span className="tiny">{c.transport}</span></div>
                    <div className="tiny">{c.transport === 'stdio' ? c.command : c.url}</div>
                  </div>
                  <Pill kind={c.needs_local ? 'warn' : 'ok'}>{c.needs_local ? 'runs locally' : 'remote'}</Pill>
                </div>
              ))}
            </>
          )}
          {plan.aliases?.length > 0 && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>Model aliases</div>
              {plan.aliases.map((a) => (
                <div key={a.env} className="perm-row">
                  <span className="tiny mono">{a.env}</span>
                  <span className="tiny">{a.model}</span>
                </div>
              ))}
            </>
          )}
          {plan.behaviour && (
            <div className="tiny" style={{ marginTop: 8 }}>
              follow-ups: <b>{plan.behaviour.follow_up_queue_mode}</b> · force-push {plan.behaviour.git_force_push ? 'on' : 'off'} ·
              PR auto-merge {plan.behaviour.pr_watch_auto_merge ? 'on' : 'off'}{plan.sandbox ? ` · sandbox ${plan.sandbox}` : ''}
            </div>
          )}
          {plan.migrations?.length > 0 && (
            <div className="tiny" style={{ marginTop: 6 }}>
              model migrations: {plan.migrations.map((m) => `${m.from}→${m.to}`).join(', ')}
            </div>
          )}
          {plan.warnings?.length > 0 && (
            <div className="tiny" style={{ marginTop: 8, color: 'var(--warn, #fbbf24)' }}>
              {plan.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {plan.skipped?.length > 0 && (
            <div className="tiny" style={{ marginTop: 8 }}>
              skipped: {plan.skipped.map((x) => `${x.id} (${x.reason})`).join('; ')}
            </div>
          )}
          {plan.note && <div className="tiny" style={{ marginTop: 8 }}>{plan.note}</div>}
        </div>
      )}

      <h3>Policy</h3>
      <p className="small" style={{ color: 'var(--text-2)', marginTop: 0 }}>
        Every capability is named and off by default when it is risky. Local MCP servers power the REA
        reverse-engineering tools; turning this off stops ANTICODEX spawning any local process.
      </p>
      <div className="card">
        {Object.entries(flagMeta).map(([key, meta]) => (
          <div key={key} className="perm-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{meta.label}</div>
              <div className="tiny">{meta.detail}</div>
            </div>
            <Switch on={Boolean(policy?.flags?.[key])} onChange={(v) => toggleFlag(key, v)} />
          </div>
        ))}
        {!Object.keys(flagMeta).length && <div className="tiny">Loading policy…</div>}
        {plan?.flags?.length > 0 && (
          <div className="tiny" style={{ marginTop: 10 }}>
            The imported policy-limits.json also gates: {plan.flags.map((f) => f.key).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
