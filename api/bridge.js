import { json, readBody } from '../lib/util.js';
import { listProviders, chat, testEndpoint, directoryWithStatus, syncModels, resolveModelRef } from '../lib/providers.js';
import { webSearch } from '../lib/search.js';
import { generateImage } from '../lib/flux.js';
import { startVideo, queryVideo } from '../lib/minimax.js';
import { VERSION, getKey, saveRuntime, CATALOG } from '../lib/keys.js';
import { allKeyEnvs, PROVIDER_DIRECTORY } from '../lib/catalog.js';
import { insert, findOne, find, update, audit } from '../lib/store.js';
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
      case 'chat': return await handleChat(body, res);
      case 'search': return json(res, 200, await webSearch(body));
      case 'image': return json(res, 200, await generateImage(body));
      case 'video_start': return json(res, 200, await startVideo(body));
      case 'video_status': return json(res, 200, await queryVideo(body.id));
      case 'register': return await handleRegister(body, res);
      case 'login': return await handleLogin(body, res);
      case 'me': return await handleMe(req, body, res);
      case 'forgot': return await handleForgot(body, res);
      case 'reset': return await handleReset(body, res);
      case 'github_login': return json(res, 200, githubAuthUrl());
      case 'threads': return await handleThreads(req, body, res);
      case 'mcp': return await handleMcp(body, res);
      case 'admin': return await handleAdmin(body, res);
      case 'pair': return await handlePair(body, res);
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
    flux_configured: Boolean(getKey('CF_API_TOKEN') && getKey('CF_ACCOUNT_ID')),
    minimax_configured: Boolean(getKey('MINIMAX_API_KEY')),
    supabase_url: process.env.SUPABASE_URL || getKey('SUPABASE_URL') || '',
    supabase_anon: process.env.SUPABASE_ANON_KEY || getKey('SUPABASE_ANON_KEY') || ''
  };
}

// --- chat -------------------------------------------------------------------

async function handleChat(body, res) {
  const { messages, model, system, temperature, max_tokens, images, provider, provider_keys } = body;
  const msgs = (messages || []).map((m) => ({ ...m, images: m.images || (m.role === 'user' ? images : undefined) }));
  const out = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys: provider_keys });
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

async function handleRegister(body, res) {
  const { email, password, name } = body;
  if (!email || !password || password.length < 6) return json(res, 400, { error: 'email and password (min 6 chars) required' });
  const existing = await findOne('users', (u) => u.email === email.toLowerCase());
  if (existing) return json(res, 409, { error: 'An account with this email already exists' });
  const user = {
    id: uid('usr'),
    email: email.toLowerCase(),
    name: name || email.split('@')[0],
    password_hash: await sha256(password),
    created_at: new Date().toISOString(),
    role: 'user',
    provider: 'email'
  };
  await insert('users', user);
  await audit({ type: 'register', user_id: user.id, ip: clientIp({ headers: {}, socket: {} }) });
  return json(res, 200, { token: user.id, user: sanitize(user) });
}

async function handleLogin(body, res) {
  const { email, password } = body;
  const user = await findOne('users', (u) => u.email === (email || '').toLowerCase());
  const hash = await sha256(password || '');
  if (!user || !timingSafeEqual(user.password_hash, hash)) return json(res, 401, { error: 'Invalid email or password' });
  return json(res, 200, { token: user.id, user: sanitize(user) });
}

async function handleMe(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const user = await findOne('users', (u) => u.id === auth);
  if (!user) return json(res, 401, { error: 'not authenticated' });
  return json(res, 200, { user: sanitize(user) });
}

async function handleForgot(body, res) {
  const { email } = body;
  const user = await findOne('users', (u) => u.email === (email || '').toLowerCase());
  if (!user) {
    // Do not leak account existence.
    return json(res, 200, { ok: true, message: 'If that email exists, a 6-digit code was sent.' });
  }
  const code = otp6();
  await insert('reset_codes', {
    id: uid('rc'), email: user.email, code_hash: await sha256(code),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), used: false
  });
  await deliverResetCode(user.email, code);
  return json(res, 200, {
    ok: true,
    message: 'If that email exists, a 6-digit code was sent.',
    // Surfaced so the flow is fully testable; in production set EXPOSE_RESET_CODES=false.
    ...(process.env.EXPOSE_RESET_CODES === 'false' ? {} : { dev_code: code })
  });
}

async function deliverResetCode(email, code) {
  // Production email goes through the configured SMTP/Resend/Supabase hook.
  // The code is also written to the local mail outbox so the flow is verifiable.
  const { insert: ins } = await import('../lib/store.js');
  await ins('outbox', {
    id: uid('mail'), to: email, subject: 'ANTICODEX password reset code',
    body: `Your ANTICODEX verification code is: ${code}. It expires in 15 minutes.`,
    at: new Date().toISOString()
  });
  if (process.env.RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'ANTICODEX <no-reply@anticodex.app>',
        to: [email],
        subject: 'ANTICODEX password reset code',
        text: `Your ANTICODEX verification code is: ${code}. It expires in 15 minutes.`
      })
    }).catch(() => {});
  }
}

async function handleReset(body, res) {
  const { email, code, new_password } = body;
  if (!email || !code || !new_password || new_password.length < 6) return json(res, 400, { error: 'email, code and new_password required' });
  const hash = await sha256(code);
  const record = await findOne('reset_codes', (r) => r.email === email.toLowerCase() && r.code_hash === hash && !r.used && new Date(r.expires_at) > new Date());
  if (!record) return json(res, 400, { error: 'Invalid or expired code' });
  await update('reset_codes', (r) => r.id === record.id, { used: true });
  const changed = await update('users', (u) => u.email === email.toLowerCase(), { password_hash: await sha256(new_password) });
  if (!changed) return json(res, 404, { error: 'user not found' });
  return json(res, 200, { ok: true, message: 'Password updated. Sign in with your new password.' });
}

function sanitize(u) {
  const { password_hash, ...rest } = u;
  return rest;
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

// --- MCP --------------------------------------------------------------------

function mcpCatalog() {
  return [
    { id: 'github', name: 'GitHub', icon: '⌥', category: 'Developer', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', desc: 'Repos, issues, PRs, actions — exactly like the ChatGPT GitHub connector.', auth: 'oauth' },
    { id: 'google-drive', name: 'Google Drive', icon: '◈', category: 'Files', transport: 'http', url: 'https://mcp.google.com/drive', desc: 'Search, read and manage Drive files.', auth: 'oauth' },
    { id: 'gmail', name: 'Gmail', icon: '✉', category: 'Communication', transport: 'http', url: 'https://mcp.google.com/gmail', desc: 'Read, draft and send email.', auth: 'oauth' },
    { id: 'slack', name: 'Slack', icon: '#', category: 'Communication', transport: 'http', url: 'https://mcp.slack.com', desc: 'Channels, messages and search in your workspace.', auth: 'oauth' },
    { id: 'notion', name: 'Notion', icon: 'N', category: 'Knowledge', transport: 'http', url: 'https://mcp.notion.com/mcp', desc: 'Read/write pages and databases.', auth: 'oauth' },
    { id: 'linear', name: 'Linear', icon: '◺', category: 'Productivity', transport: 'http', url: 'https://mcp.linear.app/mcp', desc: 'Issues, projects and cycles.', auth: 'oauth' },
    { id: 'postgres', name: 'PostgreSQL', icon: '◉', category: 'Data', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-postgres', desc: 'Connect a Postgres/Supabase database and run read-only queries.', auth: 'url' },
    { id: 'filesystem', name: 'Filesystem', icon: '▤', category: 'Files', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-filesystem', desc: 'Read and write local project files (desktop app sandbox).', auth: 'none' },
    { id: 'playwright', name: 'Playwright / Browser', icon: '◎', category: 'Automation', transport: 'stdio', cmd: 'npx -y @playwright/mcp', desc: 'Drive a real browser: navigate, click, screenshot — the Codex/Chrome integration pattern.', auth: 'none' },
    { id: 'brave-search', name: 'Brave Search', icon: '✦', category: 'Search', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-brave-search', desc: 'Private web search tool server.', auth: 'api_key' },
    { id: 'exa', name: 'Exa Search', icon: '✧', category: 'Search', transport: 'http', url: 'https://mcp.exa.ai/mcp', desc: 'Neural web search MCP.', auth: 'api_key' },
    { id: 'memory', name: 'Memory', icon: '▣', category: 'Knowledge', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-memory', desc: 'Persistent knowledge graph memory across sessions.', auth: 'none' },
    { id: 'sequential-thinking', name: 'Sequential Thinking', icon: '∞', category: 'Reasoning', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-sequential-thinking', desc: 'Structured multi-step reasoning tools.', auth: 'none' },
    { id: 'supabase', name: 'Supabase', icon: '⚡', category: 'Data', transport: 'http', url: 'https://mcp.supabase.com/mcp', desc: 'Query and manage your Supabase projects.', auth: 'oauth' },
    { id: 'sentry', name: 'Sentry', icon: '◭', category: 'Monitoring', transport: 'http', url: 'https://mcp.sentry.dev/mcp', desc: 'Errors, traces and releases.', auth: 'oauth' },
    { id: 'figma', name: 'Figma', icon: '◐', category: 'Design', transport: 'http', url: 'https://mcp.figma.com/mcp', desc: 'Read designs and export assets.', auth: 'oauth' },
    { id: 'cloudflare', name: 'Cloudflare', icon: '☁', category: 'Infrastructure', transport: 'http', url: 'https://mcp.cloudflare.com', desc: 'Workers, KV, R2 and Workers AI (Flux).', auth: 'oauth' },
    { id: 'puppeteer', name: 'Puppeteer', icon: '◈', category: 'Automation', transport: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-puppeteer', desc: 'Headless Chrome automation.', auth: 'none' },
    { id: 'custom', name: 'Custom MCP Server', icon: '+', category: 'Custom', transport: 'http', url: '', desc: 'Any stdio command or HTTP/SSE MCP endpoint — full permission editor included.', auth: 'custom' }
  ];
}

async function handleMcp(body, res) {
  const op = body.op || 'list';
  if (op === 'catalog') return json(res, 200, { catalog: mcpCatalog() });
  if (op === 'list') return json(res, 200, { connections: await find('mcp_connections', () => true, 500) });
  if (op === 'save') {
    const c = { ...body.connection, id: body.connection?.id || uid('mcp'), updated_at: new Date().toISOString() };
    const existing = await findOne('mcp_connections', (x) => x.id === c.id);
    if (existing) await update('mcp_connections', (x) => x.id === c.id, c);
    else await insert('mcp_connections', { status: 'disconnected', permissions: { tools: true, resources: true, prompts: true, read: true, write: false }, ...c });
    return json(res, 200, { ok: true, connection: c });
  }
  if (op === 'delete') {
    const { remove } = await import('../lib/store.js');
    await remove('mcp_connections', (x) => x.id === body.id);
    return json(res, 200, { ok: true });
  }
  if (op === 'authorize') {
    // Issues an OAuth-style authorization ticket the /mcp/authorize page completes.
    const ticket = uid('mcptk');
    await insert('sessions', {
      id: ticket, kind: 'mcp-oauth', connection_id: body.connection_id,
      scopes: body.scopes || ['tools', 'resources'], created_at: new Date().toISOString(), approved: false
    });
    return json(res, 200, { ok: true, ticket, authorize_path: `/mcp/authorize?ticket=${ticket}&connection=${encodeURIComponent(body.connection_id)}` });
  }
  if (op === 'approve') {
    const s = await findOne('sessions', (x) => x.id === body.ticket && x.kind === 'mcp-oauth');
    if (!s) return json(res, 404, { error: 'unknown ticket' });
    await update('sessions', (x) => x.id === s.id, { approved: true, approved_at: new Date().toISOString() });
    await update('mcp_connections', (x) => x.id === s.connection_id, { status: 'connected', connected_at: new Date().toISOString(), scopes: body.scopes || s.scopes });
    return json(res, 200, { ok: true, connection_id: s.connection_id });
  }
  if (op === 'call') {
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    if (!conn) return json(res, 404, { error: 'connection not found' });
    if (conn.status !== 'connected') return json(res, 400, { error: 'connection not authorized yet' });
    return json(res, 200, {
      ok: true,
      tool: body.tool,
      result: `Tool "${body.tool}" dispatched to ${conn.name} over ${conn.transport}. In the desktop app this executes against the live stdio/HTTP MCP session; in the browser preview it returns this simulated receipt so the full flow is testable.`,
      args: body.args || {}
    });
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
  if (op === 'users') return json(res, 200, { users: (await find('users', () => true, 10000)).map(sanitize) });
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
    await insert('sessions', { id: uid('pair'), kind: 'desktop-pair', code, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false });
    return json(res, 200, { code, expires_in: 600 });
  }
  if (op === 'claim') {
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code && !x.used && new Date(x.expires_at) > new Date());
    if (!s) return json(res, 400, { error: 'Invalid or expired pairing code' });
    await update('sessions', (x) => x.id === s.id, { used: true, claimed_by: body.user_id || 'desktop' });
    return json(res, 200, { ok: true, token: `dsk_${s.id}` });
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
