import { json, readBody } from '../lib/util.js';
import { listProviders, chat, testEndpoint, directoryWithStatus, syncModels, resolveModelRef } from '../lib/providers.js';
import { webSearch } from '../lib/search.js';
import { generateImage } from '../lib/flux.js';
import { startVideo, queryVideo } from '../lib/minimax.js';
import { VERSION, getKey, saveRuntime, CATALOG } from '../lib/keys.js';
import { allKeyEnvs, PROVIDER_DIRECTORY } from '../lib/catalog.js';
import { insert, findOne, find, update, remove, audit, saveUserKey, userKeyMap, deleteUserKey } from '../lib/store.js';
import * as authx from '../lib/authx.js';
import { handleExtras, builtinTools, runBuiltin } from '../lib/extras.js';
import { MCP_CATALOG, McpClient, probeServer, discoverAuth, registerClient, buildAuthorizeUrl, exchangeCode, refreshToken, pkcePair, collectTools, executeTool } from '../lib/mcp.js';
import { sha256, timingSafeEqual, otp6, uid, clientIp } from '../lib/util.js';

// ---------------------------------------------------------------------------
// Everything routes through /api/bridge with {action:...} so the same handlers
// work on Vercel serverless functions and the local Node server.
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const body = await readBody(req).catch(() => ({}));
  const action = body.action || (req.url || '').split('/').pop();
  try {
    switch (action) {
      case 'health': return json(res, 200, { ok: true, version: VERSION, name: 'ANTICODEX', time: new Date().toISOString() });
      case 'config': return json(res, 200, publicConfig());
      case 'models': return json(res, 200, { providers: listProviders(body.keys), directory: directoryWithStatus(body.keys), catalog: CATALOG });
      case 'sync_models': return json(res, 200, await syncModels(body));
      case 'save_provider_key': {
        if (!body.key_env || !['string'].includes(typeof body.key_env)) return json(res, 400, { error: 'key_env required' });
        const patch = {}; patch[body.key_env] = body.value || '';
        saveRuntime(patch);
        return json(res, 200, { ok: true, key_env: body.key_env });
      }
      case 'test_endpoint': return json(res, 200, await testEndpoint(body));
      case 'chat': return await handleChat(body, res, req);
      case 'search': return json(res, 200, await webSearch({ ...body, keys: await mergedKeys(req, body) }));
      case 'image': return json(res, 200, await generateImage({ ...body, keys: await mergedKeys(req, body) }));
      case 'video_start': return json(res, 200, await startVideo({ ...body, keys: await mergedKeys(req, body) }));
      case 'video_status': return json(res, 200, await queryVideo(body.id));
      case 'user_keys': return await handleUserKeys(req, body, res);
      case 'register': return json(res, 200, await authx.register(body));
      case 'verify_code': return json(res, 200, await authx.verifyCode(body));
      case 'login': return json(res, 200, await authx.login(body));
      case 'me': return await handleMe(req, body, res);
      case 'forgot': return json(res, 200, await authx.forgot(body));
      case 'reset': return json(res, 200, await authx.resetPassword({ email: body.email, code: body.code, token_hash: body.token_hash, token: body.token, password: body.new_password || body.password }));
      case 'github_login': return json(res, 200, await authx.githubAuth(body));
      case 'oauth_callback': return json(res, 200, await authx.oauthExchange(body));
      case 'threads': return await handleThreads(req, body, res);
      case 'mcp': return await handleMcp(body, res);
      case 'admin': return await handleAdmin(body, res);
      case 'pair': return await handlePair(body, res);
      case 'extras': return json(res, 200, await handleExtras(body));
      case 'update_check': return await handleUpdateCheck(body, res);
      default: return json(res, 404, { error: `unknown action: ${action}` });
    }
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}

// --- config -----------------------------------------------------------------

function publicConfig() {
  return {
    name: 'ANTICODEX',
    version: VERSION,
    admin_username: getKey('ADMIN_USERNAME') || 'Thaddeusadmin',
    features: {
      chat: true, codex: true, claude_agent: true, images: true, video: true,
      mcp: true, computer_use: true, github_login: Boolean(process.env.GITHUB_CLIENT_ID || getKey('GITHUB_CLIENT_ID')),
      email_reset: true
    },
    providers: listProviders().map((p) => ({ id: p.id, name: p.name, configured: p.configured, kind: p.kind })),
    provider_count: PROVIDER_DIRECTORY.length,
    search_configured: Boolean(getKey('TAVILY_API_KEY') || getKey('EXA_API_KEY')),
    extras: {
      elevenlabs: Boolean(getKey('ELEVENLABS_API_KEY')), whisper: Boolean(getKey('OPENAI_API_KEY')),
      unsplash: Boolean(getKey('UNSPLASH_ACCESS_KEY')), openweather: Boolean(getKey('OPENWEATHER_API_KEY')),
      windy: Boolean(getKey('WINDY_API_KEY')), opensky: Boolean(getKey('OPENSKY_CLIENT_ID')),
      youtube: Boolean(getKey('YOUTUBE_API_KEY')), groq: Boolean(getKey('GROQ_API_KEY'))
    },
    flux_configured: Boolean(getKey('CF_API_TOKEN') && getKey('CF_ACCOUNT_ID')),
    minimax_configured: Boolean(getKey('MINIMAX_API_KEY')),
    supabase_url: process.env.SUPABASE_URL || getKey('SUPABASE_URL') || '',
    supabase_anon: process.env.SUPABASE_ANON_KEY || getKey('SUPABASE_ANON_KEY') || ''
  };
}

// --- chat -------------------------------------------------------------------

// Resolve the keychain for a request: the account's own keys REPLACE the
// built-in defaults automatically; explicit per-call keys win overall.
async function mergedKeys(req, body) {
  const auth = (req?.headers?.authorization || '').replace(/^Bearer\s+/i, '') || body?.token;
  const user = auth ? await authx.findByToken(auth) : null;
  const uKeys = user ? await userKeyMap(user.email) : {};
  return { ...uKeys, ...(body?.provider_keys || {}) };
}

async function handleUserKeys(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const user = await authx.findByToken(auth);
  if (!user) return json(res, 401, { error: 'sign in to manage your API keys' });
  const op = body.op || 'get';
  if (op === 'get') {
    const map = await userKeyMap(user.email);
    const masked = {};
    for (const [k, v] of Object.entries(map)) masked[k] = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '•••';
    return json(res, 200, { ok: true, keys: masked, count: Object.keys(map).length, email: user.email });
  }
  if (op === 'save') {
    if (!body.key_env || typeof body.value !== 'string' || !body.value.trim()) return json(res, 400, { error: 'key_env and value required' });
    await saveUserKey(user.email, String(body.key_env), String(body.value).trim());
    return json(res, 200, { ok: true, key_env: body.key_env, message: 'Your key now replaces the built-in default for your account.' });
  }
  if (op === 'delete') {
    await deleteUserKey(user.email, String(body.key_env));
    return json(res, 200, { ok: true, message: 'Reverted to the built-in default.' });
  }
  return json(res, 400, { error: 'unknown user_keys op' });
}

async function handleChat(body, res, req) {
  const { messages, model, system, temperature, max_tokens, images, provider, use_mcp } = body;
  let msgs = (messages || []).map((m) => ({ ...m, images: m.images || (m.role === 'user' ? images : undefined) }));
  const keys = await mergedKeys(req, body);

  if (use_mcp !== false) {
    const conns = (await find('mcp_connections', (c) => c.status === 'connected' && c.enabled !== false, 50)).slice(0, 12);
    const builtins = builtinTools();
    if (conns.length || builtins.length) {
      const tools = [...builtins, ...(await collectTools(conns)).filter((t) => !t._error)].slice(0, 40);
      if (tools.length) {
        const out = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys, tools });
        // Tool-call loop (max 4 rounds) — the assistant can drive connected MCPs.
        let rounds = 0;
        while (out.tool_calls?.length && rounds < 4) {
          rounds++;
          msgs = [...msgs, { role: 'assistant', content: out.content || '', tool_calls: out.tool_calls }];
          for (const tc of out.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
            let result;
            try {
              const fname = tc.function?.name || '';
              result = builtins.some((b) => b.function.name === fname)
                ? await runBuiltin(fname, args)
                : await executeTool(conns, fname, args);
            } catch (e) { result = { error: String(e.message || e) }; }
            msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: JSON.stringify(result).slice(0, 12000) });
          }
          const next = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys, tools });
          Object.assign(out, next);
          if (!next.tool_calls?.length) break;
        }
        return json(res, 200, out);
      }
    }
  }
  const out = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys });
  return json(res, 200, out);
}

// --- auth -------------------------------------------------------------------

function githubAuthUrl() {
  const clientId = process.env.GITHUB_CLIENT_ID || getKey('GITHUB_CLIENT_ID');
  if (!clientId) return { configured: false, url: '', note: 'Set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (Supabase Auth → Providers → GitHub) to enable one-click GitHub login.' };
  const redirect = process.env.AUTH_REDIRECT || getKey('AUTH_REDIRECT') || 'http://localhost:8787/auth/callback';
  return {
    configured: true,
    url: `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=read:user user:email`
  };
}

async function handleMe(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const user = await authx.findByToken(auth) || await findOne('users', (u) => u.id === auth);
  if (!user) return json(res, 401, { error: 'not authenticated' });
  return json(res, 200, { user: authx.sanitizeUser(user) });
}

// --- threads ----------------------------------------------------------------

async function handleThreads(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const op = body.op || 'list';
  if (op === 'list') {
    return json(res, 200, { threads: await find('threads', (t) => t.user_id === auth, 500) });
  }
  if (op === 'save') {
    const t = body.thread;
    if (!t?.id) return json(res, 400, { error: 'thread.id required' });
    const existing = await findOne('threads', (x) => x.id === t.id);
    const row = { ...t, user_id: auth, updated_at: new Date().toISOString() };
    if (existing) await update('threads', (x) => x.id === t.id, row);
    else await insert('threads', row);
    return json(res, 200, { ok: true, thread: row });
  }
  if (op === 'delete') {
    const { remove } = await import('../lib/store.js');
    await remove('threads', (t) => t.id === body.id && t.user_id === auth);
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'unknown threads op' });
}

// --- MCP (real Model Context Protocol) --------------------------------------

async function handleMcp(body, res) {
  const op = body.op || 'list';
  if (op === 'catalog') return json(res, 200, { catalog: MCP_CATALOG, gateways: MCP_CATALOG.filter((c) => c.gateway) });

  if (op === 'list') return json(res, 200, { connections: await find('mcp_connections', () => true, 500) });

  if (op === 'save') {
    const c = { ...body.connection, id: body.connection?.id || uid('mcp'), updated_at: new Date().toISOString() };
    const existing = await findOne('mcp_connections', (x) => x.id === c.id);
    if (existing) await update('mcp_connections', (x) => x.id === c.id, c);
    else await insert('mcp_connections', { status: 'disconnected', enabled: true, permissions: { tools: true, resources: true, prompts: true, read: true, write: false }, ...c });
    return json(res, 200, { ok: true, connection: c });
  }

  if (op === 'delete') {
    await remove('mcp_connections', (x) => x.id === body.id);
    return json(res, 200, { ok: true });
  }

  if (op === 'probe') {
    // Live handshake — initialize + tools/list against the real server.
    try {
      const result = await probeServer(body.url, body.token);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'connect_begin') {
    // Start the browser OAuth dance. Returns the provider's authorization URL
    // (the sign-in / permissions page) to open in the user's browser.
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    const url = body.url || conn?.url;
    if (!url) return json(res, 400, { error: 'url or connection_id required' });
    const meta = await discoverAuth(url);
    const redirectUri = body.redirect_uri || `${getKey('SITE_URL') || 'http://localhost:8787'}/mcp/callback`;
    const state = uid('st');
    const { verifier, challenge } = pkcePair();
    if (meta?.authorization_endpoint) {
      const client = await registerClient(meta, { redirectUris: [redirectUri] }) || {};
      const clientId = client.client_id || body.client_id;
      if (!clientId) {
        return json(res, 200, {
          ok: true, needs_key: true,
          message: 'This server needs OAuth. Its authorization server has no dynamic registration — paste a client id from the provider’s developer page, or use the managed gateway link.'
        });
      }
      await insert('sessions', {
        id: state, kind: 'mcp-oauth', connection_id: body.connection_id, url,
        verifier, client_id: clientId, client_secret: client.client_secret, meta,
        redirect_uri: redirectUri, created_at: Date.now()
      });
      const authorize_url = buildAuthorizeUrl(meta, {
        clientId, redirectUri, scope: body.scope || meta.scopes_supported?.slice(0, 8).join(' '),
        state, codeChallenge: challenge
      });
      return json(res, 200, { ok: true, authorize_url, state, requires_browser: true });
    }
    // Public / tokenless server — connect directly.
    try {
      const probe = await probeServer(url, body.token);
      const row = {
        id: body.connection_id || uid('mcp'), name: probe.server?.name || url, url, status: 'connected',
        enabled: true, token: body.token || null, tools: probe.tools, connected_at: Date.now()
      };
      const existing = await findOne('mcp_connections', (x) => x.id === row.id);
      if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
      else await insert('mcp_connections', row);
      return json(res, 200, { ok: true, connected: true, connection: row });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'connect_callback') {
    const s = await findOne('sessions', (x) => x.id === body.state && x.kind === 'mcp-oauth');
    if (!s) return json(res, 404, { error: 'unknown OAuth state — start Connect again' });
    const tokens = await exchangeCode(s.meta, {
      code: body.code, redirectUri: s.redirect_uri,
      codeVerifier: s.verifier, clientId: s.client_id, clientSecret: s.client_secret
    });
    const probe = await probeServer(s.url, tokens.access_token);
    const row = {
      id: s.connection_id || uid('mcp'), name: probe.server?.name || s.url, url: s.url, status: 'connected',
      enabled: true, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      tools: probe.tools, connected_at: Date.now()
    };
    const existing = await findOne('mcp_connections', (x) => x.id === row.id);
    if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
    else await insert('mcp_connections', row);
    await update('sessions', (x) => x.id === s.id, { used: true });
    return json(res, 200, { ok: true, connection: row });
  }

  if (op === 'test') {
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    if (!conn) return json(res, 404, { error: 'connection not found' });
    try {
      const probe = await probeServer(conn.url, conn.access_token || conn.token);
      await update('mcp_connections', (x) => x.id === conn.id, { tools: probe.tools, last_test: Date.now(), last_error: null });
      return json(res, 200, { ok: true, ...probe });
    } catch (e) {
      await update('mcp_connections', (x) => x.id === conn.id, { last_error: String(e.message || e) });
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'call') {
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    if (!conn) return json(res, 404, { error: 'connection not found' });
    try {
      const client = new McpClient(conn.url, { token: conn.access_token || conn.token });
      await client.initialize();
      const result = await client.callTool(body.tool, body.args || {});
      await client.close();
      return json(res, 200, { ok: true, tool: body.tool, result });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  return json(res, 400, { error: 'unknown mcp op' });
}

// --- admin ------------------------------------------------------------------

function adminToken(user) {
  return `adm_${sha256 ? '' : ''}${user}`;
}

async function handleAdmin(body, res) {
  const op = body.op || 'login';
  const expectedUser = getKey('ADMIN_USERNAME') || 'Thaddeusadmin';
  const expectedPass = getKey('ADMIN_PASSWORD') || 'Thaddeusk12';

  if (op === 'login') {
    const ok = timingSafeEqual(body.username || '', expectedUser) && timingSafeEqual(body.password || '', expectedPass);
    if (!ok) return json(res, 401, { error: 'Invalid admin credentials' });
    const token = `adm_${await sha256(expectedUser + ':' + expectedPass + ':anticodex')}`;
    await audit({ type: 'admin_login', ip: 'admin' });
    return json(res, 200, { ok: true, token });
  }

  const token = body.token || '';
  const valid = token === `adm_${await sha256(expectedUser + ':' + expectedPass + ':anticodex')}`;
  if (!valid) return json(res, 401, { error: 'admin token required' });

  if (op === 'stats') {
    const users = await find('users', () => true, 10000);
    const threads = await find('threads', () => true, 10000);
    const mcp = await find('mcp_connections', () => true, 10000);
    return json(res, 200, {
      users: users.length,
      threads: threads.length,
      mcp_connections: mcp.length,
      versions: { app: VERSION },
      providers: listProviders().map((p) => ({ id: p.id, name: p.name, configured: p.configured })),
      recent: (await find('audit', () => true, 50)).reverse()
    });
  }
  if (op === 'users') return json(res, 200, { users: (await find('users', () => true, 10000)).map(authx.sanitizeUser) });
  if (op === 'set_keys') {
    const allowed = allKeyEnvs();
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    saveRuntime(patch);
    await audit({ type: 'admin_set_keys', keys: Object.keys(patch) });
    return json(res, 200, { ok: true, saved: Object.keys(patch) });
  }
  if (op === 'get_keys') {
    const keys = {};
    for (const k of allKeyEnvs()) {
      const v = getKey(k);
      keys[k] = v ? `${v.slice(0, 4)}…${v.slice(-3)} (${v.length} chars)` : '(not set)';
    }
    return json(res, 200, { keys });
  }
  if (op === 'broadcast') {
    await insert('audit', { id: uid('bc'), type: 'broadcast', message: body.message, at: new Date().toISOString() });
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'unknown admin op' });
}

// --- desktop pairing & updates ----------------------------------------------

async function handlePair(body, res) {
  const op = body.op || 'create';
  if (op === 'create') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await insert('sessions', {
      id: uid('pair'), kind: 'desktop-pair', code, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false
    });
    return json(res, 200, { code, expires_in: 600 });
  }
  if (op === 'claim') {
    // Called by the website after the user signs in (email or GitHub).
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code && !x.used && new Date(x.expires_at) > new Date());
    if (!s) return json(res, 400, { error: 'Invalid or expired pairing code' });
    await update('sessions', (x) => x.id === s.id, {
      used: true, claimed_by: body.user_id || 'desktop',
      linked_token: body.user_token || null, linked_user: body.user || null,
      claimed_at: new Date().toISOString()
    });
    return json(res, 200, { ok: true, token: body.user_token || `dsk_${s.id}` });
  }
  if (op === 'status') {
    // Desktop polls this until the website claims the code. Once claimed, the
    // desktop receives the service keychain so it works identically to the site.
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code);
    if (!s) return json(res, 404, { error: 'unknown code' });
    if (!s.used) return json(res, 200, { ok: true, claimed: false, expires_in: Math.max(0, Math.round((new Date(s.expires_at) - new Date()) / 1000)) });
    const service_keys = {};
    for (const k of allKeyEnvs()) {
      const v = getKey(k);
      if (v && !String(k).startsWith('ADMIN_')) service_keys[k] = v;
    }
    // The account's own keys replace the built-ins for this user.
    const ownKeys = await userKeyMap(s.linked_user?.email);
    Object.assign(service_keys, ownKeys);
    return json(res, 200, { ok: true, claimed: true, token: s.linked_token, user: s.linked_user, user_id: s.claimed_by, service_keys });
  }
  return json(res, 400, { error: 'unknown pair op' });
}

async function handleUpdateCheck(body, res) {
  try {
    const r = await fetch('https://api.github.com/repos/ThaddeusHackz/ANTICODEX/releases/latest', {
      headers: { 'User-Agent': 'ANTICODEX-Updater', Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) return json(res, 200, { ok: false, error: `github ${r.status}` });
    const rel = await r.json();
    return json(res, 200, {
      ok: true,
      version: (rel.tag_name || '').replace(/^v/, ''),
      notes: rel.body || '',
      published_at: rel.published_at,
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
    });
  } catch (e) {
    return json(res, 200, { ok: false, error: String(e.message || e) });
  }
}
