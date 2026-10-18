import React, { useEffect, useMemo, useState } from 'react';
import { models as modelsApi, testEndpoint, updateCheck, api } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Switch } from '../ui.jsx';

function ProviderCard({ def, onSave, onTest }) {
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(def.endpoint);
  const [out, setOut] = useState('');
  const [models, setModels] = useState(def.models || []);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true); setOut('Testing…');
    try {
      const r = await testEndpoint({ provider: def.id, endpoint, api_key: key, type: def.protocol });
      if (r.ok) {
        setOut(`✓ ${r.message || 'OK'}`);
        if (r.models?.length) setModels(r.models.map((id) => ({ id, label: id })));
      } else setOut(`✗ ${r.error || r.status}`);
    } catch (e) { setOut('✗ ' + e.message); }
    finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true);
    try {
      const r = await api('sync_models', { provider: def.id, endpoint });
      if (r.ok) { setModels(r.models); setOut(`✓ synced ${r.models.length} live models`); }
      else setOut(`✗ ${r.error || 'sync failed'}`);
    } catch (e) { setOut('✗ ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <div className="mcp-icon" style={{ width: 38, height: 38, fontSize: 15 }}>{(def.name || '?')[0]}</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{def.name} {def.primary && <span className="pill" style={{ marginLeft: 6 }}>primary</span>}</div>
            <div className="tiny">{def.category} · {def.protocol}-wire · <span className="kbd">{def.key_env}</span></div>
          </div>
        </div>
        <Pill kind={def.configured ? 'ok' : 'warn'}>{def.configured ? 'configured' : 'needs key'}</Pill>
      </div>
      {def.note && <div className="tiny" style={{ margin: '8px 0 0' }}>{def.note}</div>}
      <div style={{ marginTop: 10 }}>
        <Field label="API endpoint"><input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></Field>
        <Field label="API key" hint={def.homepage ? `Get a key: ${def.homepage}` : undefined}>
          <input type="password" value={key} placeholder={def.placeholder || 'paste key'} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="row">
        <button className="btn primary small" onClick={() => onSave(def, key, endpoint)}>Save key</button>
        <button className="btn small" disabled={busy} onClick={test}>{busy ? '…' : 'Test'}</button>
        {(def.models_dynamic || def.id === 'nvidia' || def.id === 'openrouter') && (
          <button className="btn small ghost" disabled={busy} onClick={sync}>Sync models</button>
        )}
      </div>
      {out && <div className="tiny" style={{ marginTop: 8 }}>{out}</div>}
      {models?.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 5, maxHeight: 130, overflowY: 'auto' }}>
          {models.slice(0, 40).map((m) => (
            <span key={m.id} className="pill" title={m.id} style={{ fontWeight: 600 }}>
              {m.label || m.id}{m.vision ? ' ◉' : ''}{m.reasoning ? ' ∞' : ''}
            </span>
          ))}
          {models.length > 40 && <span className="tiny">+{models.length - 40} more</span>}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { notify, cfg, theme, setTheme, user, model, setModel } = useApp();
  const [tab, setTab] = useState('providers');
  const [directory, setDirectory] = useState([]);
  const [providers, setProviders] = useState([]);
  const [filter, setFilter] = useState('');
  const [customs, setCustoms] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_custom_providers') || '[]'); } catch { return []; }
  });
  const [updateInfo, setUpdateInfo] = useState(null);

  const desktop = typeof window !== 'undefined' && window.anticodexDesktop;

  function refresh() {
    modelsApi().then((r) => {
      setDirectory(r.directory || []);
      setProviders(r.providers || []);
    }).catch(() => {});
  }
  useEffect(refresh, []);

  async function saveKey(def, key, endpoint) {
    if (!key) return notify('Paste an API key first');
    // 1) server-side runtime config (works for web + desktop)
    try { await api('save_provider_key', { key_env: def.key_env, value: key }); } catch { /* local fallback below */ }
    // 2) device-local (this browser)
    localStorage.setItem(`acx_key_${def.key_env}`, key);
    // 3) desktop keychain (used for direct main-process calls)
    if (desktop?.saveKeys) { try { await desktop.saveKeys({ [def.key_env]: key }); } catch { /* optional */ } }
    notify(`${def.name} key saved`);
    refresh();
  }

  const visible = useMemo(() => directory.filter((d) =>
    !filter || d.name.toLowerCase().includes(filter.toLowerCase()) ||
    d.category.toLowerCase().includes(filter.toLowerCase()) ||
    d.key_env.toLowerCase().includes(filter.toLowerCase())), [directory, filter]);

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Settings</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {directory.length || 25}+ provider endpoints · API keys · model catalogs · appearance · desktop & updates
          </p>
        </div>
        <div className="tabs">
          {['providers', 'search', 'media', 'account', 'desktop'].map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'providers' && (
        <>
          <div className="row between" style={{ marginBottom: 14 }}>
            <input placeholder="Search providers, keys, categories…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 340 }} />
            <div className="row">
              <Pill kind="ok">{directory.filter((d) => d.configured).length} configured</Pill>
              <Pill>{directory.length} endpoints</Pill>
            </div>
          </div>
          <div className="mcp-grid">
            {visible.map((def) => (
              <ProviderCard key={def.id} def={def} onSave={saveKey} />
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Custom endpoint (Claude-desktop Developer mode)</h3>
            <p className="sub">Any OpenAI-/Anthropic-compatible gateway: endpoint + key + type, then test the models.</p>
            <CustomProviderForm onSave={(v) => {
              const next = [...customs, { id: `custom_${Date.now().toString(36)}`, ...v }];
              setCustoms(next);
              localStorage.setItem('acx_custom_providers', JSON.stringify(next));
              notify('Custom provider saved');
            }} />
            {customs.map((c) => (
              <div className="perm-row" key={c.id}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                  <div className="tiny">{c.endpoint} · {c.type}</div>
                </div>
                <button className="btn small danger" onClick={() => {
                  const next = customs.filter((x) => x.id !== c.id);
                  setCustoms(next); localStorage.setItem('acx_custom_providers', JSON.stringify(next));
                }}>Remove</button>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>Default model</h3>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="anticodex/demo-core">ANTICODEX Demo Core</option>
              {providers.flatMap((p) => (p.models || []).map((m) => (
                <option key={`${p.id}:${m.id}`} value={`${p.id}::${m.id}`}>{p.name} — {m.label || m.id}</option>
              )))}
            </select>
          </div>
        </>
      )}

      {tab === 'search' && (
        <div className="card">
          <h3>Web search — Tavily + Exa</h3>
          <p className="sub">ANTICODEX uses Tavily and Exa for live web search (owner-approved to ship inside the product).</p>
          <Field label="Tavily API key"><input type="password" placeholder="tvly-…" id="tavily" /></Field>
          <Field label="Exa API key"><input type="password" placeholder="exa-…" id="exa" /></Field>
          <button className="btn primary" onClick={async () => {
            const t = document.getElementById('tavily').value;
            const x = document.getElementById('exa').value;
            if (t) await api('save_provider_key', { key_env: 'TAVILY_API_KEY', value: t }).catch(() => {});
            if (x) await api('save_provider_key', { key_env: 'EXA_API_KEY', value: x }).catch(() => {});
            notify('Search keys saved');
          }}>Save search keys</button>
          <div className="tiny" style={{ marginTop: 8 }}>Also editable globally in Admin → Keys.</div>
        </div>
      )}

      {tab === 'media' && (
        <>
          <div className="card">
            <h3>Cloudflare Workers AI — Flux images</h3>
            <p className="sub">schnell/dev image generation on your Cloudflare account.</p>
            <Field label="Account ID"><input placeholder="hex account id" id="cfacct" /></Field>
            <Field label="API token (Workers AI:run)"><input type="password" placeholder="token" id="cftok" /></Field>
            <button className="btn primary" onClick={async () => {
              const a = document.getElementById('cfacct').value, t = document.getElementById('cftok').value;
              if (a) await api('save_provider_key', { key_env: 'CF_ACCOUNT_ID', value: a }).catch(() => {});
              if (t) await api('save_provider_key', { key_env: 'CF_API_TOKEN', value: t }).catch(() => {});
              notify('Cloudflare settings saved');
            }}>Save Flux settings</button>
          </div>
          <div className="card">
            <h3>MiniMax Hailuo — video (H3)</h3>
            <p className="sub">Unlimited video generation on your MiniMax key.</p>
            <Field label="MiniMax API key"><input type="password" id="mmkey" /></Field>
            <Field label="Group ID (optional)"><input id="mmgrp" /></Field>
            <button className="btn primary" onClick={async () => {
              const k = document.getElementById('mmkey').value, g = document.getElementById('mmgrp').value;
              if (k) await api('save_provider_key', { key_env: 'MINIMAX_API_KEY', value: k }).catch(() => {});
              if (g) await api('save_provider_key', { key_env: 'MINIMAX_GROUP_ID', value: g }).catch(() => {});
              notify('MiniMax settings saved');
            }}>Save MiniMax settings</button>
          </div>
        </>
      )}

      {tab === 'account' && (
        <div className="card">
          <h3>Account</h3>
          <p className="sub">{user ? `${user.name} · ${user.email}` : 'Not signed in'}</p>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Appearance</div>
              <div className="tiny">Dark / light theme</div>
            </div>
            <Switch on={theme === 'dark'} onChange={(v) => setTheme(v ? 'dark' : 'light')} />
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>GitHub login</div>
              <div className="tiny">{cfg?.features?.github_login ? 'Configured' : 'Set GITHUB_CLIENT_ID/SECRET in Admin → Keys to enable'}</div>
            </div>
            <Pill kind={cfg?.features?.github_login ? 'ok' : 'warn'}>{cfg?.features?.github_login ? 'on' : 'off'}</Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Password reset email codes</div>
              <div className="tiny">6-digit codes, 15-minute expiry, single-use, verified against the database</div>
            </div>
            <Pill kind="ok">enabled</Pill>
          </div>
        </div>
      )}

      {tab === 'desktop' && (
        <div className="card">
          <h3>ANTICODEX Desktop</h3>
          <p className="sub">Windows app with auto-update: when a release is published, every installed copy offers the update and applies it after the user accepts.</p>
          <div className="row">
            <button className="btn" onClick={async () => {
              const r = await updateCheck();
              setUpdateInfo(r);
            }}>Check for updates</button>
            <a className="btn primary" href="https://github.com/ThaddeusHackz/ANTICODEX/releases/latest" target="_blank" rel="noreferrer">Download .exe</a>
          </div>
          {updateInfo && (
            <div className="card" style={{ marginTop: 12, background: 'var(--bg-soft)' }}>
              {updateInfo.ok ? (
                <>
                  <div className="row"><Pill kind="ok">latest: v{updateInfo.version}</Pill><span className="tiny">{updateInfo.published_at}</span></div>
                  <div className="tiny" style={{ marginTop: 8 }}>{(updateInfo.assets || []).map((a) => a.name).join(' · ') || 'No assets yet'}</div>
                </>
              ) : <div className="tiny">No release found yet (or GitHub unreachable): {updateInfo.error}</div>}
            </div>
          )}
          <div className="perm-row" style={{ marginTop: 12 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Desktop keychain</div>
              <div className="tiny">Provider keys saved in the desktop app are used for direct main-process calls (no CORS)</div>
            </div>
            <Pill kind={desktop ? 'ok' : 'warn'}>{desktop ? 'connected' : 'install desktop app'}</Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Computer-use bridge</div>
              <div className="tiny">Mouse, keyboard, screen vision, installs — handled by the desktop companion</div>
            </div>
            <Pill kind={desktop ? 'ok' : 'warn'}>{desktop ? 'connected' : 'install desktop app'}</Pill>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomProviderForm({ onSave }) {
  const [v, setV] = useState({ name: '', endpoint: '', api_key: '', type: 'openai' });
  const [out, setOut] = useState('');
  return (
    <div className="grid-2">
      <Field label="Provider name"><input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="My gateway" /></Field>
      <Field label="API endpoint"><input value={v.endpoint} onChange={(e) => setV({ ...v, endpoint: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
      <Field label="API key"><input type="password" value={v.api_key} onChange={(e) => setV({ ...v, api_key: e.target.value })} /></Field>
      <Field label="Wire type">
        <select value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic Messages</option>
        </select>
      </Field>
      <div className="row" style={{ gridColumn: '1 / -1' }}>
        <button className="btn primary small" onClick={() => v.name && v.endpoint && onSave(v)}>Save provider</button>
        <button className="btn small" onClick={async () => {
          setOut('Testing…');
          const r = await testEndpoint({ endpoint: v.endpoint, api_key: v.api_key, type: v.type }).catch((e) => ({ ok: false, error: e.message }));
          setOut(r.ok ? `✓ ${r.message || 'OK'} ${r.models?.length ? `· ${r.models.length} models` : ''}` : `✗ ${r.error || r.status}`);
        }}>Test</button>
        {out && <span className="tiny">{out}</span>}
      </div>
    </div>
  );
}
