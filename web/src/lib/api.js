// ANTICODEX API client — talks to /api/bridge (or the desktop bridge when present).

const hasDesktop = () => typeof window !== 'undefined' && window.anticodexDesktop;

// Actions the desktop main process runs itself (no CORS, keychain keys attached).
const DESKTOP_PROXY = ['chat', 'search', 'image', 'video_start', 'video_status'];
// Listing / testing / syncing models must also see the desktop keychain, or the
// app shows "needs key" for a key that is actually installed on this machine.
const DESKTOP_KEYS = ['models', 'sync_models', 'test_endpoint', 'config'];

/** Gateways this device knows about (Ollama, LM Studio, a LAN box). The server has
 *  no copy of them, so a request that names one has to carry its definition —
 *  endpoint and wire type only; the key is resolved from the account/keychain by
 *  key_env, which is why a raw `api_key` in that list is never sent. */
const GATEWAY_ACTIONS = ['models', 'sync_models', 'test_endpoint', 'config', 'chat', 'search', 'image', 'video_start'];
function localGateways() {
  try {
    const list = JSON.parse(localStorage.getItem('acx_custom_providers') || '[]');
    if (!Array.isArray(list)) return [];
    return list.map((p) => ({
      id: p.id, name: p.name, type: p.type, endpoint: p.endpoint, key_env: p.key_env, default_model: p.default_model
    }));
  } catch { return []; }
}

export async function api(action, payload = {}) {
  const body = { action, ...payload };
  const token = localStorage.getItem('acx_token');
  if (!body.provider_defs && GATEWAY_ACTIONS.includes(action)) {
    const defs = localGateways();
    if (defs.length) body.provider_defs = defs;
  }
  // The token also goes in the body: Electron webviews and some corporate
  // proxies drop or rewrite Authorization on same-origin POSTs.
  if (token) body.token = token;

  if (hasDesktop() && DESKTOP_PROXY.includes(action)) {
    try {
      return await window.anticodexDesktop.api(action, payload);
    } catch { /* fall through to network */ }
  }
  if (hasDesktop() && DESKTOP_KEYS.includes(action) && window.anticodexDesktop.getKeys) {
    try {
      const keys = await window.anticodexDesktop.getKeys();
      if (keys && Object.keys(keys).length) body.provider_keys = { ...keys, ...(body.provider_keys || {}) };
    } catch { /* keychain unavailable */ }
  }

  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  const adminToken = localStorage.getItem('acx_admin_token');
  if (adminToken) opts.headers['X-Admin-Token'] = adminToken;

  const res = await fetch('/api/bridge', opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const chat = (payload) => api('chat', payload);

/**
 * Streamed chat.
 *
 * The request is the same shape as `chat`; the answer arrives as server-sent
 * events so the UI can show what is happening (contacting → connected →
 * streaming) instead of a spinner that might mean anything. Events are:
 * `phase`, `heartbeat`, `delta`, `tool`, `done`, `error`, `aborted`.
 *
 * Returns the same promise shape either way: `{ ok, text, model, ... }`, so a
 * caller that does not care about streaming can await it and ignore `onEvent`.
 */
export async function chatStream(payload, { onEvent, signal } = {}) {
  // In the packaged app the main process makes the request: it is the only place
  // that has this machine's keychain keys and the local token a LAN gateway
  // needs. It forwards the same events over IPC.
  if (hasDesktop() && window.anticodexDesktop.streamApi) {
    try {
      // The main process cancels by stream id, so the id has to be ours: the
      // Stop button aborts `signal`, and that has to reach the fetch the main
      // process is holding — otherwise it only hides the typing dots.
      const streamId = globalThis.crypto?.randomUUID
        ? `s_${globalThis.crypto.randomUUID()}`
        : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const cancel = () => { try { window.anticodexDesktop.abortStream?.(streamId); } catch { /* window gone */ } };
      if (signal) {
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      }
      try {
        return await window.anticodexDesktop.streamApi('chat_stream', payload, (evt) => {
          try { onEvent?.(evt); } catch { /* view error */ }
        }, streamId);
      } finally {
        try { signal?.removeEventListener('abort', cancel); } catch { /* no signal */ }
      }
    } catch (e) {
      // Fall through to the HTTP path; the bundled server serves it too.
      if (e?.name === 'AbortError') return { ok: true, aborted: true, text: '' };
    }
  }
  const body = { action: 'chat_stream', ...payload };
  const token = localStorage.getItem('acx_token');
  if (token) body.token = token;
  if (!body.provider_defs) {
    const defs = localGateways();
    if (defs.length) body.provider_defs = defs;
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;

  // The desktop app runs the same bridge on loopback, so a relative URL is
  // correct in both places; there is no second code path to keep in sync.
  const res = await fetch('/api/bridge', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    // A bridge without the stream action (an older deployment) still answers
    // JSON — fall back rather than showing an empty bubble.
    const data = await res.json().catch(() => ({}));
    if (data.text || data.error || data.ok === false) return data;
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.type === 'delta') text += evt.text || '';
      if (evt.type === 'thinking') reasoning += evt.text || '';
      if (evt.type === 'done') final = evt;
      if (evt.type === 'error') final = { ...evt, type: 'error' };
      if (evt.type === 'aborted') final = { ...evt, aborted: true };
      try { onEvent?.(evt); } catch { /* the view must not break the stream */ }
    }
  }
  if (final?.type === 'error') return { ok: false, error: final.error, verdict: final.verdict, fix: final.fix, ...final };
  return {
    ok: true,
    text,
    content: text,
    ...(reasoning ? { reasoning } : {}),
    model: final?.model,
    first_token_ms: final?.first_token_ms,
    thinking_ms: final?.thinking_ms,
    elapsed_ms: final?.elapsed_ms,
    aborted: Boolean(final?.aborted)
  };
}
export const search = (payload) => api('search', payload);
export const image = (payload) => api('image', payload);
export const videoStart = (payload) => api('video_start', payload);
export const videoStatus = (id) => api('video_status', { id });
export const models = (opts) => api('models', opts || {});
export const syncModels = (payload) => api('sync_models', payload);
export const config = () => api('config');
export const testEndpoint = (payload) => api('test_endpoint', payload);

export const auth = {
  register: (p) => api('register', p),
  verifyCode: (p) => api('verify_code', p),
  resend: (p) => api('resend_code', p),
  login: (p) => api('login', p),
  me: () => api('me'),
  logout: () => api('logout', {}).catch(() => ({ ok: true })),
  forgot: (p) => api('forgot', p),
  reset: (p) => api('reset', p),
  github: (p) => api('github_login', p || {}),
  oauthCallback: (p) => api('oauth_callback', p)
};

export const threads = {
  list: () => api('threads', { op: 'list' }),
  save: (thread) => api('threads', { op: 'save', thread }),
  remove: (id) => api('threads', { op: 'delete', id })
};

export const mcp = {
  catalog: () => api('mcp', { op: 'catalog' }),
  list: () => api('mcp', { op: 'list' }),
  save: (connection) => api('mcp', { op: 'save', connection }),
  remove: (id) => api('mcp', { op: 'delete', id }),
  probe: (url, token) => api('mcp', { op: 'probe', url, token }),
  connectBegin: (p) => api('mcp', { op: 'connect_begin', ...p }),
  connectCallback: (p) => api('mcp', { op: 'connect_callback', ...p }),
  test: (connection_id) => api('mcp', { op: 'test', connection_id }),
  call: (connection_id, tool, args) => api('mcp', { op: 'call', connection_id, tool, args })
};

export const admin = {
  login: (p) => api('admin', { op: 'login', ...p }),
  stats: (token) => api('admin', { op: 'stats', token }),
  users: (token) => api('admin', { op: 'users', token }),
  getKeys: (token) => api('admin', { op: 'get_keys', token }),
  setKeys: (token, keys) => api('admin', { op: 'set_keys', token, ...keys }),
  broadcast: (token, message) => api('admin', { op: 'broadcast', token, message })
};

export const pairing = {
  create: () => api('pair', { op: 'create' }),
  claim: (code, user_id, user_token, user) => api('pair', { op: 'claim', code, user_id, user_token, user }),
  status: (code) => api('pair', { op: 'status', code })
};

/** Adopt the config this machine already has (Codex config.toml, Claude settings). */
export const importConfig = (payload) => api('import_config', payload);

// Egress policy: an allowlisting proxy a spawned process is pointed at. Starting
// one listens on this machine, so every write op is desktop/local only.
export const egress = {
  status: () => api('egress', { op: 'status' }),
  presets: () => api('egress', { op: 'presets' }),
  check: (host, p = {}) => api('egress', { op: 'check', host, ...p }),
  start: (p = {}) => api('egress', { op: 'start', ...p }),
  update: (p = {}) => api('egress', { op: 'update', ...p }),
  stop: () => api('egress', { op: 'stop' })
};

// Artifact templates: the picture grid the ChatGPT app shows for a document,
// deck or spreadsheet style. Reads the local ChatGPT home, so it is local-only.
export const artifacts = {
  kinds: () => api('artifacts', { op: 'kinds' }),
  roots: () => api('artifacts', { op: 'roots' }),
  list: (artifactKind, request) => api('artifacts', { op: 'list', artifact_kind: artifactKind, request: request || undefined }),
  choose: (artifactKind, selection) => api('artifacts', { op: 'choose', artifact_kind: artifactKind, selection })
};

// What the picker knows about a model after someone used it: latency, and which
// ids a provider has rejected (those are the ones that answered "there is
// nothing like this model available" and are now hidden by default).
// The Sandbox runs code on the machine that owns the bridge (the desktop app, or
// a server you run yourself) — the whole point is that the code the model wrote
// is executed and its real output is shown, not described.
export const sandbox = {
  status: () => api('sandbox', { op: 'status' }),
  run: (payload) => api('sandbox', { op: 'run', ...payload }),
  read: (runId, name) => api('sandbox', { op: 'read', run_id: runId, name }),
  clear: (runId) => api('sandbox', { op: 'clear', run_id: runId }),
  // Ask the model for a snippet and hand back the first fenced code block: the
  // "code gen" half of the page, kept separate from running it.
  async generate({ prompt, language = 'node', model, provider, effort }) {
    const out = await chatStream({
      messages: [
        { role: 'system', content: `You write one runnable ${language} program. Reply with the code in a single fenced block and nothing else.` },
        { role: 'user', content: prompt }
      ],
      model, provider, effort, use_mcp: false
    });
    const text = out.text || out.content || '';
    const fence = text.match(/```[\w-]*\n([\s\S]*?)```/);
    return { ok: Boolean(out.ok && (fence || text)), code: (fence ? fence[1] : text).trim(), raw: text, model: out.model };
  }
};

export const modelHealth = {
  list: () => api('model_health', { op: 'list' }),
  clear: (ref) => api('model_health', { op: 'clear', ref }),
  probe: (models, opts = {}) => api('model_health', { op: 'probe', models, ...opts })
};

// REA — Reverse Engineer Anything. `plan` runs REA's own `setup --dry-run`, the
// UI shows it, and `apply` only runs the plan whose id was approved.
export const rea = {
  status: (client) => api('rea', { op: 'status', client }),
  plan: (p = {}) => api('rea', { op: 'plan', ...p }),
  apply: (planId, p = {}) => api('rea', { op: 'apply', plan_id: planId, approve: true, ...p }),
  verify: (p = {}) => api('rea', { op: 'verify', ...p }),
  register: () => api('rea', { op: 'register' }),
  tools: () => api('rea', { op: 'tools' }),
  run: (tool, args) => api('rea', { op: 'run', tool, args })
};

export const skills = {
  list: (p) => api('skills', { op: 'list', ...p }),
  get: (name) => api('skills', { op: 'get', name }),
  resolve: (text) => api('skills', { op: 'resolve', text }),
  // A `.skill` is a ZIP holding `<name>/SKILL.md` — the packaged form the shipped
  // desktop apps use. `archive` inspects one, `install` extracts it into this
  // machine's ~/.codex/skills (local only), `manifest` reads a bundled manifest.
  archive: (file) => api('skills', { op: 'archive', file }),
  install: (file, p = {}) => api('skills', { op: 'install', file, ...p }),
  manifest: (dir) => api('skills', { op: 'manifest', dir })
};

export const workspace = {
  context: (p) => api('workspace', { op: 'context', ...p }),
  set: (p) => api('workspace', { op: 'set', ...p })
};

/** Write a Codex-compatible `config.toml` from what this device knows. */
export const exportConfig = (state) => api('export_config', { state });

export const policy = {
  get: () => api('policy', { op: 'get' }),
  set: (patch) => api('policy', { op: 'set', patch })
};

export const extras = (payload) => api('extras', payload);

/**
 * Where a key you type into Settings actually lives:
 *   1. your ACCOUNT (server-side, used by chat/search/image/video for you) — this
 *      is the one that makes a provider work, and it used to be skipped by the
 *      provider cards, which is why a pasted NVIDIA key appeared to do nothing;
 *   2. the desktop keychain, for calls the .exe makes itself;
 *   3. NOT server-global config — that is admin-only (`save_provider_key`) and is
 *      a read-only filesystem on serverless anyway.
 * Returns the scope that succeeded so the UI can say something true.
 */
export async function storeKey(keyEnv, value) {
  const v = String(value || '').trim();
  if (!keyEnv || !v) return { ok: false, error: 'key and value required' };
  const out = { ok: false, scopes: [] };
  try {
    const r = await userKeys.save(keyEnv, v);
    if (r && r.ok !== false) out.scopes.push('account');
    else out.error = r?.error || 'sign in to store your key';
  } catch (e) {
    out.error = e?.status === 401 ? 'sign in first — keys are stored with your account' : String(e.message || e);
  }
  if (hasDesktop() && window.anticodexDesktop.saveKeys) {
    try { await window.anticodexDesktop.saveKeys({ [keyEnv]: v }); out.scopes.push('this device'); } catch { /* optional */ }
  }
  out.ok = out.scopes.length > 0;
  return out;
}
export const userKeys = {
  get: () => api('user_keys', { op: 'get' }),
  save: (key_env, value) => api('user_keys', { op: 'save', key_env, value }),
  remove: (key_env) => api('user_keys', { op: 'delete', key_env })
};
export const updateCheck = () => api('update_check', {});
