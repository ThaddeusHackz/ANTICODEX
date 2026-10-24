import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { models as modelsApi, testEndpoint, updateCheck, api, userKeys, storeKey } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Switch } from '../ui.jsx';
import ModelPicker from '../ModelPicker.jsx';
import ModelHealthPanel from './ModelHealth.jsx';

function ProviderCard({ def, onSave, onSaved, onPickModel, notify }) {
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(def.endpoint);
  const [out, setOut] = useState('');
  const [kind, setKind] = useState('');        // ok | bad | net — what the last probe proved
  const [models, setModels] = useState(def.models || []);
  const [busy, setBusy] = useState(false);

  // "Key saved" used to be the last honest word you got, and then nothing worked.
  // Saving now immediately asks the provider, so the card states a fact: the key
  // was accepted (and here is what it serves), the key was rejected, or this
  // server simply cannot reach that host.
  async function save() {
    if (!key) { setOut('Paste an API key first'); setKind('bad'); return; }
    setBusy(true); setOut('storing your key…'); setKind('');
    let r;
    try { r = await onSave(def, key, endpoint); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r || !r.ok) { setKind('bad'); setOut(`✗ ${r?.error || 'could not store that key'}`); setBusy(false); return; }
    setOut('checking it against the provider…');
    try {
      // the key is already stored against the account, so the probe needs no key
      const t = await testEndpoint({ provider: def.id, endpoint, type: def.protocol });
      if (t?.ok) {
        setKind('ok');
        setOut(`✓ ${t.message || 'key accepted'}`);
        if (t.models?.length) setModels(t.models.map((id) => ({ id, label: id, live: true })));
        if (onSaved) onSaved();
      } else if (t?.verdict === 'model') {
        setKind('ok');   // authenticated fine; the probe model just is not served here
        setOut('✓ key accepted — the test model was not listed, so press Sync models and pick one that exists');
        if (onSaved) onSaved();
      } else if (t?.verdict === 'unreachable') {
        setKind('net');
        setOut(`⚠ ${t.error || 'this server could not reach the provider'}`);
      } else {
        setKind('bad');
        setOut(`✗ ${t?.error || 'the provider rejected this key'}${t?.settings_link ? ' (keys are per account — paste it again)' : ''}`);
      }
    } catch (e) { setKind('bad'); setOut(`✗ probe failed: ${e.message || e}`); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setOut('Testing…'); setKind('');
    try {
      const r = await testEndpoint({ provider: def.id, endpoint, api_key: key, type: def.protocol });
      if (r.ok) {
        setKind('ok');
        setOut(`✓ ${r.message || 'OK'}`);
        if (r.models?.length) setModels(r.models.map((id) => ({ id, label: id, live: true })));
      } else {
        setKind(r.verdict === 'unreachable' ? 'net' : 'bad');
        setOut(`✗ ${r.error || r.status}`);
      }
    } catch (e) { setKind('bad'); setOut('✗ ' + e.message); }
    finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true); setOut('reading the live /models list…');
    try {
      // the typed key is sent only when present, so "sync before saving" works
      const r = await api('sync_models', { provider: def.id, endpoint, ...(key ? { api_key: key } : {}) });
      if (r.ok) {
        setKind('ok');
        setModels(r.models);
        setOut(`✓ ${r.models.length} live models${r.source === 'cache' ? ' (cached)' : ''} — the model menu lists them all, click one to use it`);
        if (onSaved) onSaved();
      } else {
        setKind(r.verdict === 'unreachable' ? 'net' : 'bad');
        setOut(`✗ ${r.error || 'sync failed'}`);
      }
    } catch (e) { setKind('bad'); setOut('✗ ' + e.message); }
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
        <Pill kind={kind === 'ok' || def.configured ? 'ok' : 'warn'}>
          {kind === 'ok' ? 'key works' : def.configured ? (def.models_verified ? 'configured · live' : 'configured') : 'needs key'}
        </Pill>
      </div>
      {def.note && <div className="tiny" style={{ margin: '8px 0 0' }}>{def.note}</div>}
      <div style={{ marginTop: 10 }}>
        <Field label="API endpoint"><input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></Field>
        <Field label="API key" hint={def.homepage ? `Get a key: ${def.homepage}` : undefined}>
          <input type="password" value={key} placeholder={def.placeholder || 'paste key'} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="row">
        <button className="btn primary small" disabled={busy} onClick={save}>{busy ? '…' : 'Save key'}</button>
        <button className="btn small" disabled={busy} onClick={test}>{busy ? '…' : 'Test'}</button>
        <button className="btn small ghost" disabled={busy} onClick={sync} title="Ask this endpoint for the models your key can actually call">Sync models</button>
        {def.configured && (
          <span className="tiny pc-src">{def.models_verified ? 'ids confirmed by the endpoint' : 'ids from the built-in catalog'}</span>
        )}
      </div>
      {out && <div className={`pc-verdict tiny ${kind}`} style={{ marginTop: 8 }}>{out}</div>}
      {models?.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 5, maxHeight: 130, overflowY: 'auto' }}>
          {models.slice(0, 40).map((m) => (
            <button
              key={m.id} className="pill model-chip" title={`${m.id} — click to use in chat`} style={{ fontWeight: 600 }}
              onClick={() => {
                const ref = `${def.id}::${m.id}`;
                if (onPickModel) { onPickModel(ref); notify(`Model set: ${m.label || m.id}`); }
              }}
            >
              {m.label || m.id}{m.vision ? ' ◉' : ''}{m.reasoning ? ' ∞' : ''}{m.live ? ' ✓' : ''}
            </button>
          ))}
          {models.length > 40 && <span className="tiny">+{models.length - 40} more — the model menu lists them all</span>}
        </div>
      )}
    </div>
  );
}

const USER_KEY_OPTIONS = [
  'NVIDIA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'ATRIA_API_KEY',
  'EXPLABS_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID',
  'MINIMAX_API_KEY', 'ELEVENLABS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'COHERE_API_KEY', 'MOONSHOT_API_KEY'
];

function MyKeysPanel() {
  const { notify } = useApp();
  const [owned, setOwned] = useState({});
  const [keyEnv, setKeyEnv] = useState('NVIDIA_API_KEY');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { const r = await userKeys.get(); setOwned(r.keys || {}); } catch { /* signed out */ }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Your API keys</h3>
      <p className="small" style={{ color: 'var(--text-2)' }}>
        ANTICODEX works out of the box on the built-in key pool. Paste <strong>your own</strong> key and it
        automatically replaces the built-in one — for <strong>your account only</strong> (linked to {user?.email || 'your email'}).
        Remove it any time to fall back to the default.
      </p>
      <div className="grid-2">
        <div className="field">
          <label className="tiny">Key</label>
          <select value={keyEnv} onChange={(e) => setKeyEnv(e.target.value)}>
            {USER_KEY_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="tiny">Your key value</label>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="paste key…" />
        </div>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || !value.trim()} onClick={async () => {
          setBusy(true);
          try {
            const r = await userKeys.save(keyEnv, value.trim());
            if (r.ok === false) { notify(r.error || 'failed'); return; }
            notify(r.message || 'Saved — your key now replaces the default');
            setValue('');
            await refresh();
          } catch (e) { notify(e.message); }
          finally { setBusy(false); }
        }}>Save my key</button>
        <span className="tiny">stored with your account · never shown in full</span>
      </div>
      {Object.keys(owned).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4>Your overrides</h4>
          {Object.entries(owned).map(([k, v]) => (
            <div key={k} className="perm-row">
              <div><strong style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{k}</strong> <span className="tiny">{v}</span></div>
              <button className="btn ghost" onClick={async () => {
                await userKeys.remove(k);
                notify('Reverted to the built-in default');
                await refresh();
              }}>Use built-in instead</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function githubNote(cfg) {
  const mode = cfg?.features?.github_login;
  if (mode === 'oauth') return 'Ready — one click signs you in with GitHub';
  if (mode === 'setup') return 'Almost: finish the GitHub OAuth App (Client ID + secret) in Admin → Keys';
  return 'Set GITHUB_CLIENT_ID/SECRET in Admin → Keys to enable';
}

export default function SettingsPage() {
  const { notify, cfg, setCfg, theme, setTheme, user, model, setModel, signOut } = useApp();
  const nav = useNavigate();
  // `/settings?tab=models` is a real entry point (the picker links to it when it
  // hides a model), so the tab has to come from the URL, not always 'providers'.
  const [tab, setTab] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return ['mykeys', 'providers', 'models', 'search', 'media', 'account', 'desktop'].includes(wanted) ? wanted : 'providers';
  });
  const [directory, setDirectory] = useState([]);
  const [providers, setProviders] = useState([]);
  const [filter, setFilter] = useState('');
  const [customs, setCustoms] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_custom_providers') || '[]'); } catch { return []; }
  });
  const [updateInfo, setUpdateInfo] = useState(null);
  const [gatewayNote, setGatewayNote] = useState('');
  const [keychain, setKeychain] = useState(null);

  const desktop = typeof window !== 'undefined' && window.anticodexDesktop;

  function refresh() {
    modelsApi().then((r) => {
      setDirectory(r.directory || []);
      setProviders(r.providers || []);
      setGatewayNote(r.provider_defs_note || '');
    }).catch(() => {});
  }
  useEffect(refresh, []);

  // Gateways belong to the machine they run on: the .exe keeps its own list and
  // sends it with each request, so Ollama on 127.0.0.1 or a LAN vLLM box works
  // from the desktop app while a public server refuses to dial those for a
  // browser. Load that copy when this is the desktop app.
  useEffect(() => {
    if (desktop?.getCustoms) {
      desktop.getCustoms()
        .then((list) => {
          if (Array.isArray(list) && list.length) {
            setCustoms(list);
            try { localStorage.setItem('acx_custom_providers', JSON.stringify(list)); } catch { /* private mode */ }
          }
        })
        .catch(() => {});
    }
    if (desktop?.keychainStatus) desktop.keychainStatus().then(setKeychain).catch(() => {});
  }, []);

  /** One place writes the gateway list, so the browser copy and the .exe copy
   *  cannot drift apart (drift is how a saved endpoint "disappears" after a
   *  restart and the app starts saying unknown provider). */
  function writeCustoms(next) {
    setCustoms(next);
    try { localStorage.setItem('acx_custom_providers', JSON.stringify(next)); } catch { /* private mode */ }
    if (desktop?.saveCustoms) Promise.resolve(desktop.saveCustoms(next)).catch(() => {});
  }

  async function saveKey(def, key, endpoint) {
    if (!key) return notify('Paste an API key first');
    // Your key goes to your ACCOUNT (which is what chat/search/image/video
    // resolve server-side) plus the desktop keychain when installed. It used to
    // be written to server-global config — read-only on serverless, silently
    // failing, and then reporting "key saved" anyway. That is why a pasted
    // NVIDIA key looked like nothing happened.
    const r = await storeKey(def.key_env, key);
    if (!r.ok) { notify(r.error || 'Could not store that key'); return r; }
    notify(`Saved to ${r.scopes.join(' + ')} — ${def.name} is ready. Pick a model in the top bar.`);
    refresh();
    return r;
    // the top-bar picker reads cfg.providers: re-pull config so the new key flips
    // "needs key" → "key ✓" without a reload
    api('config').then((c) => setCfg && setCfg(c)).catch(() => {});
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
          {['mykeys', 'providers', 'models', 'search', 'media', 'account', 'desktop'].map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'models' ? 'Model health' : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'mykeys' && <MyKeysPanel />}

      {tab === 'models' && <ModelHealthPanel notify={notify} />}

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
              <ProviderCard
                key={def.id} def={def} onSave={saveKey} notify={notify}
                onSaved={() => api('config').then((c) => setCfg && setCfg(c)).catch(() => {})}
                onPickModel={(ref) => { setModel(ref); notify(`Model set — ${ref.split('::').slice(1).join('::')}`); }}
              />
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Custom endpoint (Claude-desktop Developer mode)</h3>
            <p className="sub">
              Any OpenAI-/Anthropic-compatible gateway: endpoint + key + type, then test the models.
              The key is stored with your account (and in the desktop keychain on this device) — never in
              this row, because a list of endpoints is not a place for a secret.
            </p>
            {gatewayNote && <div className="pc-verdict tiny net" style={{ marginBottom: 10 }}>{gatewayNote}</div>}
            <CustomProviderForm onSave={async (v) => {
              const id = `custom_${Date.now().toString(36)}`;
              // A stable env name is what lets this row resolve a key the same way
              // every other provider does: account store → keychain → env.
              const key_env = `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
              const row = { id, name: v.name, endpoint: v.endpoint, type: v.type, key_env };
              writeCustoms([...customs, row]);
              if (v.api_key) {
                const r = await storeKey(key_env, v.api_key).catch(() => null);
                notify(r?.ok
                  ? `Gateway saved — key stored with ${r.scopes.join(' + ')}`
                  : `Gateway saved — its key could not be stored (${r?.error || 'sign in first'}), so paste it into the card below`);
              } else {
                notify('Gateway saved — press Sync models on its card to list what it serves');
              }
              refresh();
              api('config').then((c) => setCfg && setCfg(c)).catch(() => {});
            }} />
            {customs.length > 0 && (
              <div className="mcp-grid" style={{ marginTop: 14 }}>
                {customs.map((c) => {
                  // configured/models come from the server's view of THIS request,
                  // so the card cannot claim a gateway is ready when no key resolved.
                  const live = providers.find((p) => p.id === c.id) || {};
                  const def = {
                    id: c.id,
                    name: c.name || c.id,
                    category: desktop ? 'this device' : 'this browser',
                    protocol: c.type || 'openai',
                    endpoint: c.endpoint,
                    key_env: c.key_env || '',
                    placeholder: 'optional gateway key',
                    note: live.models_note || 'Added on this device — its /models list is the source of truth',
                    configured: Boolean(live.configured),
                    models_verified: Boolean(live.models_verified),
                    models: live.models?.length ? live.models : (c.default_model && c.default_model !== 'default' ? [{ id: c.default_model, label: c.default_model }] : [])
                  };
                  return (
                    <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <ProviderCard
                        def={def} onSave={saveKey} notify={notify}
                        onSaved={() => { refresh(); api('config').then((x) => setCfg && setCfg(x)).catch(() => {}); }}
                        onPickModel={(ref) => { setModel(ref); notify(`Model set — ${ref.split('::').slice(1).join('::')}`); }}
                      />
                      <button className="btn small ghost" onClick={() => { writeCustoms(customs.filter((x) => x.id !== c.id)); notify('Gateway removed from this device'); }}>
                        Remove gateway
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Default model</h3>
            <p className="sub">
              {model && model !== 'anticodex/demo-core'
                ? `Currently ${model.split('::').slice(1).join('::') || model}`
                : 'ANTICODEX Demo Core (built in, no key needed)'}
              {' '}· a <code>✓</code> means that id was read back from the endpoint just now, a <code>?</code> means it came from the built-in catalog.
            </p>
            {/* This used to be a <select> over the catalog baked into the bundle:
                a gateway's real ids never appeared, and a retired catalog id was
                still listed as if it worked. Same picker as the top bar — search,
                Sync models, and only live ids are picked without a warning. */}
            <div className="row" style={{ marginTop: 10 }}>
              <ModelPicker />
              <button className="btn small ghost" onClick={() => { setModel('anticodex/demo-core'); notify('Default model set — ANTICODEX Demo Core'); }}>
                Use Demo Core
              </button>
            </div>
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
            if (t) await storeKey('TAVILY_API_KEY', t).catch(() => {});
            if (x) await storeKey('EXA_API_KEY', x).catch(() => {});
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
              if (a) await storeKey('CF_ACCOUNT_ID', a).catch(() => {});
              if (t) await storeKey('CF_API_TOKEN', t).catch(() => {});
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
              if (k) await storeKey('MINIMAX_API_KEY', k).catch(() => {});
              if (g) await storeKey('MINIMAX_GROUP_ID', g).catch(() => {});
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
              <div className="tiny">{githubNote(cfg)}</div>
            </div>
            <Pill kind={cfg?.features?.github_login === 'oauth' ? 'ok' : 'warn'}>{cfg?.features?.github_login === 'oauth' ? 'on' : 'setup'}</Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Password reset codes</div>
              <div className="tiny">6-digit codes, 15-minute expiry, single-use, stored with their expiry so they can never be lost</div>
            </div>
            <Pill kind="ok">enabled</Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Email verification</div>
              <div className="tiny">{cfg?.features?.email_verification_required ? 'Required before sign-in on this server' : 'Not required — you keep access to your account even if the mailer is down'}</div>
            </div>
            <Pill kind={cfg?.features?.email_verification_required ? 'warn' : 'ok'}>{cfg?.features?.email_verification_required ? 'gated' : 'off'}</Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Account role</div>
              <div className="tiny">{user ? (user.role === 'admin' ? 'Administrator — full access to the app and the desktop build' : 'Member') : 'Signed out'}</div>
            </div>
            <button className="btn" onClick={() => { signOut(); nav('/login'); }}>Sign out</button>
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
              <div className="tiny">
                Keys you save in the app stay on this machine and are used for its own calls (no CORS).{' '}
                {desktop
                  ? keychain?.encrypted === false
                    ? 'This OS gave the app no secure storage, so they are written to your user profile unprotected — that is a fact, not a setting.'
                    : 'Protected by the OS (Windows DPAPI / macOS Keychain / libsecret), so the file is unreadable outside this user account.'
                  : 'Install the desktop app to keep keys off a server entirely.'}
              </div>
            </div>
            <Pill kind={desktop ? (keychain && keychain.encrypted === false ? 'warn' : 'ok') : 'warn'}>
              {desktop ? (keychain ? (keychain.encrypted ? 'encrypted' : 'plaintext') : 'connected') : 'install desktop app'}
            </Pill>
          </div>
          <div className="perm-row">
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Local gateways &amp; offline checks</div>
              <div className="tiny">
                {desktop
                  ? 'While offline or unpaired, this app still tests keys against the provider, syncs live model lists and reaches gateways on your own network (Ollama, LM Studio, a LAN vLLM box).'
                  : 'The website will not dial a private/LAN address for a browser; the desktop app can, because it is your own machine.'}
              </div>
            </div>
            <Pill kind={desktop ? 'ok' : 'warn'}>{desktop ? `${customs.length} gateway${customs.length === 1 ? '' : 's'}` : 'desktop app only'}</Pill>
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
          const r = await testEndpoint({ endpoint: v.endpoint, api_key: v.api_key, type: v.type })
            .catch((e) => ({ ok: false, error: e?.data?.error || e.message }));
          setOut(r.ok
            ? `✓ ${r.message || 'reachable'} ${r.models?.length ? `· ${r.models.length} models this key can list` : ''}`
            : `✗ ${r.error || r.status}${r.verdict === 'unreachable' ? ' — this server cannot reach that address; a LAN endpoint needs the desktop app' : ''}`);
        }}>Test</button>
        {out && <span className="tiny">{out}</span>}
      </div>
    </div>
  );
}
