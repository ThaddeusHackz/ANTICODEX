// ANTICODEX API client — talks to /api/bridge (or the desktop bridge when present).

const hasDesktop = () => typeof window !== 'undefined' && window.anticodexDesktop;

export async function api(action, payload = {}) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  };
  const token = localStorage.getItem('acx_token');
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  const adminToken = localStorage.getItem('acx_admin_token');
  if (adminToken) opts.headers['X-Admin-Token'] = adminToken;

  // Desktop app can proxy provider calls without CORS limits.
  if (hasDesktop() && ['chat', 'search', 'image', 'video_start', 'video_status'].includes(action)) {
    try {
      return await window.anticodexDesktop.api(action, payload);
    } catch { /* fall through to network */ }
  }

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
export const config = () => api('config');
export const testEndpoint = (payload) => api('test_endpoint', payload);

export const auth = {
  register: (p) => api('register', p),
  verifyCode: (p) => api('verify_code', p),
  login: (p) => api('login', p),
  me: () => api('me'),
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
  claim: (code, user_id) => api('pair', { op: 'claim', code, user_id })
};

export const updateCheck = () => api('update_check', {});
