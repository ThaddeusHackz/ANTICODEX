import React, { useEffect, useState } from 'react';
import { models as modelsApi, testEndpoint, updateCheck } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Modal, Switch } from '../ui.jsx';

function ProviderCard({ title, desc, fields, onSave, configured }) {
  const [vals, setVals] = useState(fields.reduce((a, f) => ({ ...a, [f.key]: f.value || '' }), {}));
  const [testOut, setTestOut] = useState('');
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h3>{title}</h3>
          <p className="sub">{desc}</p>
        </div>
        <Pill kind={configured ? 'ok' : 'warn'}>{configured ? 'configured' : 'not set'}</Pill>
      </div>
      {fields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint}>
          <input
            type={f.secret ? 'password' : 'text'}
            value={vals[f.key]}
            placeholder={f.placeholder || ''}
            onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
          />
        </Field>
      ))}
      <div className="row">
        <button className="btn primary" onClick={() => onSave(vals)}>Save</button>
        <button className="btn" onClick={async () => {
          setTestOut('Testing…');
          try {
            const r = await testEndpoint({
              endpoint: vals.endpoint || fields.find((f) => f.key === 'endpoint')?.placeholder,
              api_key: vals.api_key || vals.key,
              type: vals.type || 'openai'
            });
            setTestOut(r.ok ? `✓ ${r.message || 'OK'} ${r.models?.length ? `· ${r.models.length} models: ${r.models.slice(0, 6).join(', ')}…` : ''}` : `✗ ${r.error || r.status}`);
          } catch (e) { setTestOut('✗ ' + e.message); }
        }}>Test connection</button>
      </div>
      {testOut && <div className="tiny" style={{ marginTop: 8 }}>{testOut}</div>}
    </div>
  );
}

export default function SettingsPage() {
  const { notify, cfg, theme, setTheme, user, model, setModel } = useApp();
  const [tab, setTab] = useState('providers');
  const [providers, setProviders] = useState([]);
  const [customs, setCustoms] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_custom_providers') || '[]'); } catch { return []; }
  });
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => { modelsApi().then((r) => setProviders(r.providers || [])).catch(() => {}); }, []);

  function saveLocal(key, value, msg) {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    notify(msg || 'Saved locally on this device');
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Settings</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>API keys, providers, model testing, appearance, desktop and updates.</p>
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
          <ProviderCard
            title="NVIDIA NIM (primary engine)"
            desc="All NVIDIA-hosted models — chat, reasoning and vision — via integrate.api.nvidia.com."
            configured={Boolean(localStorage.getItem('acx_nvidia_key'))}
            fields={[
              { key: 'api_key', label: 'NVIDIA API key', secret: true, placeholder: 'nvapi-…' },
              { key: 'endpoint', label: 'Endpoint', value: 'https://integrate.api.nvidia.com/v1', hint: 'OpenAI-compatible. Any gateway (Groq, OpenRouter, Ollama, LM Studio…) works too.' }
            ]}
            onSave={(v) => saveLocal('acx_nvidia_key', v.api_key, 'NVIDIA key saved on this device (set it in Admin → Keys for global use)')}
          />
          <ProviderCard
            title="Custom model endpoint (Claude-desktop Developer mode)"
            desc="Bring your own AI: enter API endpoint + key, then test the models — exactly like the Claude desktop developer settings."
            configured={customs.length > 0}
            fields={[
              { key: 'name', label: 'Provider name', placeholder: 'My gateway' },
              { key: 'endpoint', label: 'API endpoint', placeholder: 'https://api.example.com/v1' },
              { key: 'api_key', label: 'API key', secret: true, placeholder: 'sk-…' },
              { key: 'type', label: 'Type', value: 'openai', hint: 'openai or anthropic' }
            ]}
            onSave={(v) => {
              const next = [...customs, { id: `custom_${Date.now().toString(36)}`, ...v }];
              setCustoms(next);
              saveLocal('acx_custom_providers', next, 'Custom provider saved');
            }}
          />
          <div className="card">
            <div className="row between">
              <h3 style={{ margin: 0 }}>Saved custom providers</h3>
              <Pill>{customs.length}</Pill>
            </div>
            {customs.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>None yet.</p>}
            {customs.map((c) => (
              <div className="perm-row" key={c.id}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                  <div className="tiny">{c.endpoint} · {c.type}</div>
                </div>
                <button className="btn small danger" onClick={() => {
                  const next = customs.filter((x) => x.id !== c.id);
                  setCustoms(next); saveLocal('acx_custom_providers', next, 'Provider removed');
                }}>Remove</button>
              </div>
            ))}
          </div>
          <div className="card">
            <h3>Default model</h3>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="anticodex/demo-core">ANTICODEX Demo Core</option>
              {providers.flatMap((p) => (p.models || []).map((m) => (
                <option key={`${p.id}:${m.id}`} value={m.id}>{p.name} — {m.label}</option>
              )))}
            </select>
          </div>
        </>
      )}

      {tab === 'search' && (
        <ProviderCard
          title="Web search (Tavily + Exa)"
          desc="ANTICODEX uses Tavily and Exa for live web search in chat. These keys are designed to be shipped with the product (owner-approved, non-expiring)."
          configured={Boolean(cfg?.search_configured)}
          fields={[
            { key: 'tavily', label: 'Tavily API key', secret: true, placeholder: 'tvly-…' },
            { key: 'exa', label: 'Exa API key', secret: true, placeholder: 'exa-…' }
          ]}
          onSave={(v) => saveLocal('acx_search_keys', v, 'Search keys saved on this device (set globally in Admin → Keys)')}
        />
      )}

      {tab === 'media' && (
        <>
          <ProviderCard
            title="Cloudflare Workers AI — Flux images"
            desc="Image generation runs on Cloudflare Flux (schnell/dev)."
            configured={Boolean(cfg?.flux_configured)}
            fields={[
              { key: 'account', label: 'Cloudflare Account ID', placeholder: 'hex account id' },
              { key: 'token', label: 'Cloudflare API token', secret: true, placeholder: 'token with Workers AI:run' }
            ]}
            onSave={(v) => saveLocal('acx_cf', v, 'Cloudflare settings saved')}
          />
          <ProviderCard
            title="MiniMax Hailuo — video generation (H3)"
            desc="Unlimited video generation on your MiniMax key."
            configured={Boolean(cfg?.minimax_configured)}
            fields={[
              { key: 'api_key', label: 'MiniMax API key', secret: true },
              { key: 'group_id', label: 'Group ID (optional)' }
            ]}
            onSave={(v) => saveLocal('acx_minimax', v, 'MiniMax settings saved')}
          />
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
              <div className="tiny">6-digit codes, 15-minute expiry, verified against the database</div>
            </div>
            <Pill kind="ok">enabled</Pill>
          </div>
        </div>
      )}

      {tab === 'desktop' && (
        <div className="card">
          <h3>ANTICODEX Desktop</h3>
          <p className="sub">Windows app with auto-update: when you publish a release, every installed copy offers the update and applies it after the user accepts.</p>
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
              <div style={{ fontWeight: 700, fontSize: 13 }}>Computer-use bridge</div>
              <div className="tiny">Mouse, keyboard, screen vision, installs — handled by the desktop companion</div>
            </div>
            <Pill kind={window.anticodexDesktop ? 'ok' : 'warn'}>{window.anticodexDesktop ? 'connected' : 'install desktop app'}</Pill>
          </div>
        </div>
      )}
    </div>
  );
}
