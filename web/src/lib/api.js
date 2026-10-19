// ANTICODEX API client — talks to /api/bridge (or the desktop bridge when present).

const hasDesktop = () => typeof window !== 'undefined' && window.anticodexDesktop;

// Actions the desktop main process runs itself (no CORS, keychain keys attached).
const DESKTOP_PROXY = ['chat', 'search', 'image', 'video_start', 'video_status'];
// Listing / testing / syncing models must also see the desktop keychain, or the
// app shows "needs key" for a key that is actually installed on this machine.
const DESKTOP_KEYS = ['models', 'sync_models', 'test_endpoint', 'config'];

export async function api(action, payload = {}) {
  const body = { action, ...payload };
  const token = localStorage.getItem('acx_token');
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
export const search = (payload) => api('search', payload);
export const image = (payload) => api('image', payload);
export const videoStart = (payload) => api('video_start', payload);
export const videoStatus = (id) => api('video_status', { id });
export const models = () => api('models');
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
