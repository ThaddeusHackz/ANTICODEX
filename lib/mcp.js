// ANTICODEX MCP engine — real Model Context Protocol client.
// Supports the two live transports: Streamable HTTP (POST + optional SSE
// stream) and the legacy HTTP+SSE pair. Implements the 2025-03-26 / 2025-06-18
// protocol: initialize, tools/list, tools/call, resources/*, prompts/*.
// OAuth follows MCP authorization: RFC 9728 resource metadata discovery,
// RFC 8414 auth-server metadata, RFC 7591 dynamic client registration and
// PKCE (S256) — so clicking Connect opens the provider's own sign-in /
// permissions page in the browser, exactly like chatgpt.com connectors.

import crypto from 'node:crypto';
import { StdioMcpClient } from './mcp-stdio.js';
import { guardedFetch } from './net-guard.js';
import { redactText } from './redact.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ANTICODEX', version: '1.0.0' };

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

class McpError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}
export { McpError };

function parseSse(text) {
  const events = [];
  for (const chunk of text.split(/\n\n/)) {
    const lines = chunk.split('\n');
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
      else if (line.startsWith('data')) data += line.slice(4).trim();
    }
    if (data) {
      try { events.push(JSON.parse(data)); } catch { /* keep-alive */ }
    }
  }
  return events;
}

async function httpJson(url, { method = 'POST', headers = {}, body, timeoutMs = 8000, allowPrivate = false } = {}) {
  const mergedHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  const contentType = String(mergedHeaders['Content-Type'] || mergedHeaders['content-type'] || '');
  const encodedBody = body === undefined
    ? undefined
    : contentType.includes('application/x-www-form-urlencoded')
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
  const res = await guardedFetch(url, {
    method,
    headers: mergedHeaders,
    body: encodedBody
  }, { timeoutMs, allowPrivate });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/** One MCP connection. Stateless per call — sessions tracked via headers. */
export class McpClient {
  constructor(url, { token, headers = {}, session_id, allowPrivate = false } = {}) {
    this.url = url;
    this.token = token;
    this.headers = headers;
    this.session_id = session_id;
    this.allowPrivate = allowPrivate;
    this.nextId = 1;
    this.transport = null; // 'streamable' | 'sse'
    this.sseEndpoint = null;
  }

  authHeaders() {
    const h = { ...this.headers };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.session_id) h['Mcp-Session-Id'] = this.session_id;
    h['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    return h;
  }

  async #post(payload, expectSse = true) {
    const r = await httpJson(this.transport === 'sse' ? this.sseEndpoint : this.url, {
      headers: this.authHeaders(),
      body: payload,
      allowPrivate: this.allowPrivate
    });
    const sid = r.headers.get && r.headers.get('mcp-session-id');
    if (sid) this.session_id = sid;
    if (r.status === 202) return null;
    if (r.status === 404 && this.session_id) throw new McpError('session expired', -32001);
    if (!r.status || r.status >= 400) {
      throw new McpError(`MCP HTTP ${r.status}: ${r.text.slice(0, 200)}`, r.status);
    }
    const ct = (r.headers.get && r.headers.get('content-type')) || '';
    if (ct.includes('text/event-stream') && expectSse) {
      const events = parseSse(r.text);
      return events.find((e) => e.id === payload.id) || events.find((e) => e.result || e.error) || null;
    }
    try { return JSON.parse(r.text); } catch { return null; }
  }

  async #rpc(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const reply = await this.#post(payload);
    if (!reply) throw new McpError(`no reply for ${method}`, -32000);
    if (reply.error) throw new McpError(reply.error.message || method, reply.error.code, reply.error.data);
    return reply.result;
  }

  /** Handshake + transport negotiation. Returns server info. */
  async initialize() {
    // Legacy SSE transport: open the SSE stream first to learn the message URL.
    if (!this.transport) {
      const probe = await httpJson(this.url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: { jsonrpc: '2.0', id: 0, method: 'ping', params: {} },
        allowPrivate: this.allowPrivate
      });
      if (probe.status === 405 || probe.status === 404) {
        // Try SSE GET handshake (legacy)
        const sse = await httpJson(this.url, { method: 'GET', headers: this.authHeaders(), timeoutMs: 8000, allowPrivate: this.allowPrivate });
        const evt = parseSse(sse.text).find((e) => e.method === 'endpoint');
        if (!evt) throw new McpError('not an MCP endpoint (no streamable HTTP, no SSE endpoint event)', sse.status);
        this.transport = 'sse';
        this.sseEndpoint = new URL(evt.params?.data || evt.params?.endpoint || '', this.url).toString();
      } else {
        this.transport = 'streamable';
      }
    }
    const result = await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: CLIENT_INFO
    });
    // notifications/initialized (no id → notification)
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false).catch(() => {});
    return result;
  }

  async listTools() {
    const out = [];
    let cursor;
    do {
      const r = await this.#rpc('tools/list', cursor ? { cursor } : {});
      out.push(...(r.tools || []));
      cursor = r.nextCursor || r.next_cursor;
    } while (cursor);
    return out;
  }

  async callTool(name, args = {}) {
    const r = await this.#rpc('tools/call', { name, arguments: args }, 60000);
    return r;
  }

  async listResources() {
    try { const r = await this.#rpc('resources/list', {}); return r.resources || []; } catch { return []; }
  }

  async listPrompts() {
    try { const r = await this.#rpc('prompts/list', {}); return r.prompts || []; } catch { return []; }
  }

  async close() {
    if (this.session_id && this.transport === 'streamable') {
      await httpJson(this.url, { method: 'DELETE', headers: this.authHeaders(), allowPrivate: this.allowPrivate }).catch(() => {});
    }
  }
}

/**
 * Resolve a `stdio:` / `local:` URL to a launch spec the product already ships.
 * Returns null for anything else (remote HTTP servers, or an id we do not know).
 * This is the only place a child process spec can come from — never a request.
 */
export function stdioSpec(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:stdio|local):([\w.-]+)$/.exec(url.trim());
  if (!m) return null;
  const entry = MCP_CATALOG.find((c) => c.id === m[1] && c.stdio);
  return entry ? { ...entry.stdio, id: entry.id, name: entry.name } : null;
}

/** True when a URL needs a local child process (desktop / self-hosted only). */
export function isLocalMcp(url) { return Boolean(stdioSpec(url)); }

/**
 * One client for any transport. Callers use this instead of `new McpClient` so
 * a connection row does not have to care whether the server is local or remote.
 */
export function createClient(connOrUrl, { token } = {}) {
  const conn = typeof connOrUrl === 'string' ? { url: connOrUrl, token } : (connOrUrl || {});
  const spec = stdioSpec(conn.url);
  if (spec) {
    return new StdioMcpClient(spec.command, spec.args, {
      env: { ...(spec.env || {}), ...(conn.env || {}) },
      cwd: conn.cwd || spec.cwd,
      label: spec.name || spec.id
    });
  }
  // Imported from the user's own desktop config (`[mcp_servers.*]` in a Codex
  // config.toml). The bridge only reaches this branch when the request came
  // from loopback on a machine that can spawn processes, so an imported command
  // is never launched on a hosted deployment's behalf.
  if (conn.stdio && typeof conn.stdio.command === 'string' && /^(stdio|local):/.test(conn.url || '')) {
    return new StdioMcpClient(conn.stdio.command, Array.isArray(conn.stdio.args) ? conn.stdio.args : [], {
      env: conn.stdio.env,
      cwd: conn.stdio.cwd,
      label: conn.name || conn.id || conn.stdio.command
    });
  }
  if (typeof conn.url === 'string' && /^(stdio|local):/.test(conn.url)) {
    throw new McpError(`${conn.url} has no launch spec in this build of ANTICODEX`, -32601);
  }
  return new McpClient(conn.url, {
    token: conn.access_token || conn.token || token,
    headers: conn.headers || {},
    allowPrivate: conn.allow_private === true
  });
}

/** Connect + initialize + fetch tool inventory. Used by the bridge and tests. */
export async function probeServer(url, token, { allowPrivate = false, headers = {} } = {}) {
  const client = createClient({ url, token, headers, allow_private: allowPrivate });
  const prompts = [];
  let info; let tools;
  try {
    info = await client.initialize();
    tools = await client.listTools();
    prompts.push(...(await client.listPrompts().catch(() => [])));
  } finally {
    // A local server is a child process: leaving it running would keep the
    // request (and any Node process hosting it) alive.
    if (client.transport === 'stdio') await client.close();
  }
  return {
    ok: true,
    transport: client.transport,
    local: client.transport === 'stdio',
    server: info.serverInfo || info.server || { name: 'unknown' },
    protocolVersion: info.protocolVersion || client.protocolVersion,
    capabilities: info.capabilities || {},
    tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} })),
    prompts: prompts.map((p) => ({ name: p.name, description: p.description || '' })),
    ...(client.transport === 'stdio' && client.lastStderr && client.lastStderr()
      ? { stderr: client.lastStderr().slice(-2000) } : {})
  };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 (MCP authorization) — discovery, registration, PKCE, exchange
// ---------------------------------------------------------------------------

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function wellKnownUrls(resourceUrl) {
  const u = new URL(resourceUrl);
  const origin = u.origin;
  return [
    `${origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`,
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`,
    `${origin}/.well-known/oauth-authorization-server`
  ];
}

/** Discover the authorization server for an MCP resource (RFC 9728 + 8414). */
export async function discoverAuth(resourceUrl, { allowPrivate = false } = {}) {
  const tried = new Set();
  for (const url of wellKnownUrls(resourceUrl)) {
    if (tried.has(url)) continue; tried.add(url);
    try {
      const r = await httpJson(url, { method: 'GET', timeoutMs: 8000, allowPrivate });
      if (r.status !== 200) continue;
      const meta = JSON.parse(r.text);
      // oauth-protected-resource points at the auth server
      const asUrl = meta.authorization_servers?.[0] || (meta.authorization_endpoint ? url : null);
      if (meta.authorization_endpoint && meta.token_endpoint) return meta;
      if (asUrl && asUrl !== url) {
        const authMeta = await discoverAuth(asUrl, { allowPrivate });
        if (authMeta) return { ...meta, ...authMeta };
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Dynamic client registration (RFC 7591). Many MCP servers require this. */
export async function registerClient(meta, { redirectUris, clientName = 'ANTICODEX', allowPrivate = false } = {}) {
  const endpoint = meta.registration_endpoint;
  if (!endpoint) return null;
  try {
    const r = await httpJson(endpoint, {
      headers: { Accept: 'application/json' },
      body: {
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native'
      },
      timeoutMs: 8000,
      allowPrivate
    });
    if (r.status >= 200 && r.status < 300) return JSON.parse(r.text);
    // Some servers want client_secret_post after first registration
    return null;
  } catch { return null; }
}

export function buildAuthorizeUrl(meta, { clientId, redirectUri, scope, state, codeChallenge }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

export async function exchangeCode(meta, { code, redirectUri, codeVerifier, clientId, clientSecret, allowPrivate = false }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await httpJson(meta.token_endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: Object.fromEntries(body),
    timeoutMs: 8000,
    allowPrivate
  });
  const data = JSON.parse(r.text || '{}');
  if (!data.access_token) throw new McpError(data.error_description || data.error || 'token exchange failed', 400);
  return data;
}

export async function refreshToken(meta, { refreshToken, clientId, clientSecret, allowPrivate = false }) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await httpJson(meta.token_endpoint, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: Object.fromEntries(body),
    timeoutMs: 8000,
    allowPrivate
  });
  return JSON.parse(r.text || '{}');
}

// ---------------------------------------------------------------------------
// Curated catalog — remote MCP servers users can actually connect today.
// Sources: mcpservers.org directory + each provider's official MCP endpoint.
// Managed gateways (Zapier / Composio / Pipedream) are the free hosted way to
// connect Google Drive, Gmail, GitHub, Slack, Dropbox, Notion… via OAuth.
// ---------------------------------------------------------------------------

export const MCP_CATALOG = [
  // --- Managed gateways: one sign-in page → connect 100s of apps -------------
  {
    id: 'zapier', name: 'Zapier (Google Drive, Gmail, GitHub, Slack…)', vendor: 'Zapier',
    url: 'https://mcp.zapier.com/api/mcp/servers/REPLACE-YOUR-ENDPOINT/mcp',
    oauth: true, gateway: 'https://zapier.com/app/mcp',
    tags: ['google-drive', 'gmail', 'github', 'slack', 'dropbox', 'sheets', 'notion', 'jira', 'hubspot', 'salesforce'],
    description: 'Free hosted MCP gateway. Open the gateway link, sign in, tick Google Drive / GitHub / Gmail / anything — then paste your personal MCP endpoint URL here. This is the free website where users connect their own Google, GitHub, Microsoft accounts.'
  },
  {
    id: 'composio', name: 'Composio (Google Drive, GitHub, Notion…)', vendor: 'Composio',
    url: 'https://mcp.composio.dev/REPLACE-YOUR-ENDPOINT/mcp',
    oauth: true, gateway: 'https://mcp.composio.dev',
    tags: ['google-drive', 'github', 'notion', 'slack', 'linear', 'discord'],
    description: 'Free managed MCP gateway with per-tool permissions. Sign in with Google/GitHub, approve the apps you want, paste the MCP URL. Users can edit permissions any time on the gateway page.'
  },
  {
    id: 'pipedream', name: 'Pipedream (thousands of APIs)', vendor: 'Pipedream',
    url: 'https://mcp.pipedream.net/REPLACE-YOUR-ENDPOINT',
    oauth: true, gateway: 'https://pipedream.com/mcp',
    tags: ['google-drive', 'gmail', 'github', 'slack', 'airtable', 'stripe'],
    description: 'Free hosted MCP with connect-links per app. The connect page opens in the browser where the user signs in and edits permissions.'
  },
  // --- First-party remote MCP servers (OAuth, connect page in browser) ------
  {
    id: 'notion', name: 'Notion', vendor: 'Notion', url: 'https://mcp.notion.com/mcp',
    oauth: true, tags: ['docs', 'wiki', 'databases'],
    description: 'Official Notion MCP. Connect opens Notion’s authorization page — search, read, create and comment on pages.'
  },
  {
    id: 'linear', name: 'Linear', vendor: 'Linear', url: 'https://mcp.linear.app/sse',
    oauth: true, tags: ['issues', 'projects'],
    description: 'Official Linear MCP. Sign in on linear.app to grant issue/project tools.'
  },
  {
    id: 'github', name: 'GitHub', vendor: 'GitHub', url: 'https://api.githubcopilot.com/mcp/',
    oauth: true, tags: ['repos', 'issues', 'prs', 'code'],
    description: 'Official GitHub remote MCP (Copilot endpoint). OAuth via github.com — repos, issues, pull requests, code search.'
  },
  {
    id: 'supabase', name: 'Supabase', vendor: 'Supabase', url: 'https://mcp.supabase.com/mcp?project_ref=YOUR-PROJECT-REF',
    oauth: true, tags: ['database', 'tables', 'sql'],
    description: 'Official Supabase MCP — inspect schemas, run queries, manage your project.'
  },
  {
    id: 'cloudflare', name: 'Cloudflare', vendor: 'Cloudflare', url: 'https://mcp.cloudflare.com/sse',
    oauth: true, tags: ['dns', 'workers', 'cdn'],
    description: 'Official Cloudflare MCP for account resources and Workers.'
  },
  {
    id: 'sentry', name: 'Sentry', vendor: 'Sentry', url: 'https://mcp.sentry.dev/sse',
    oauth: true, tags: ['errors', 'monitoring'],
    description: 'Official Sentry MCP — issue search, project health.'
  },
  {
    id: 'paypal', name: 'PayPal', vendor: 'PayPal', url: 'https://mcp.paypal.com/sse',
    oauth: true, tags: ['payments'], description: 'Official PayPal MCP.'
  },
  {
    id: 'stripe', name: 'Stripe', vendor: 'Stripe', url: 'https://mcp.stripe.com/sse',
    oauth: true, tags: ['payments', 'billing'], description: 'Official Stripe MCP (agent toolkit).'
  },
  {
    id: 'asana', name: 'Asana', vendor: 'Asana', url: 'https://mcp.asana.com/sse',
    oauth: true, tags: ['tasks', 'projects'], description: 'Official Asana MCP.'
  },
  {
    id: 'intercom', name: 'Intercom', vendor: 'Intercom', url: 'https://mcp.intercom.com/sse',
    oauth: true, tags: ['support'], description: 'Official Intercom MCP.'
  },
  {
    id: 'vercel', name: 'Vercel', vendor: 'Vercel', url: 'https://mcp.vercel.com/sse',
    oauth: true, tags: ['deploy', 'projects'], description: 'Official Vercel MCP.'
  },
  {
    id: 'deepwiki', name: 'DeepWiki (any GitHub repo)', vendor: 'Devin', url: 'https://mcp.deepwiki.com/sse',
    oauth: false, tags: ['code', 'docs', 'free'],
    description: 'Free, no sign-in. Ask questions about any public GitHub repo — great for exploring codex / claude-code.'
  },
  {
    id: 'context7', name: 'Context7 (up-to-date docs)', vendor: 'Upstash', url: 'https://mcp.context7.com/mcp',
    oauth: false, tags: ['docs', 'free'], description: 'Free library docs MCP — pulls current documentation for any package.'
  },
  {
    id: 'memory', name: 'Memory (knowledge graph)', vendor: 'Official MCP servers', url: 'https://memory.mcp.anticodex.ai/mcp',
    oauth: false, tags: ['memory', 'free'], description: 'Knowledge-graph memory server (mcp-server-memory). Records facts across chats.'
  },
  {
    id: 'fetch', name: 'Fetch (read any webpage)', vendor: 'Official MCP servers', url: 'https://fetch.mcp.anticodex.ai/mcp',
    oauth: false, tags: ['web', 'free'], description: 'Fetches URLs and converts them to markdown for the model.'
  },
  {
    id: 'rea', name: 'REA — Reverse Engineer Anything', vendor: 'morluto/rea (MIT)',
    url: 'stdio:rea', oauth: false, local: true,
    stdio: { command: 'npx', args: ['-y', 'rea-agents@6.7.0', 'mcp'] },
    version: '6.7.0',
    // 207 tools x full JSON Schema on every chat turn is not a feature, it is a
    // bill. Chat/agent gets the analysis surface; the Connectors page and
    // `mcp op:"call"` still reach all 207 (`all_tools: true` opts back in).
    suggested_tools: [
      'analyze_javascript_application', 'inspect_artifact', 'open_binary',
      'inspect_sqlite_database', 'inspect_plist', 'inspect_electron_fuses',
      'inspect_pe_resources', 'inspect_go_binary', 'inspect_rust_binary',
      'inspect_binary_layout', 'inspect_managed_artifact', 'inspect_android_package',
      'trace_application_feature', 'find_changed_behavior', 'compare_artifacts',
      'list_unknowns'
    ],
    tags: ['reverse-engineering', 'asar', 'electron', 'decompile', 'apk', 'sqlite', 'firmware', 'local'],
    description: 'Local MCP server with 207 tools: static JavaScript/Electron reconstruction, ASAR + artifact inventory, APK/managed/firmware inspection, SQLite + plist readers, Evidence bundles, version comparison. Runs on this machine — desktop app or a local server, never a serverless deployment.'
  },
  {
    id: 'filesystem', name: 'Filesystem', vendor: 'Official MCP servers', url: 'local:filesystem',
    oauth: false, tags: ['files', 'desktop'], description: 'Desktop only — read/write folders the user selects (stdio, bundled with the app).'
  },
  {
    id: 'postgres', name: 'PostgreSQL', vendor: 'Official MCP servers', url: 'local:postgres',
    oauth: false, tags: ['database', 'desktop'], description: 'Desktop only — connect a Postgres/Supabase connection string (stdio).'
  }
];

/**
 * Which of a server's tools go into the model's tool list.
 *
 * A server can advertise hundreds of tools; sending all of them on every turn is
 * both slow and expensive. A connection may name its own `tool_allowlist`, and a
 * catalogue entry may ship a `suggested_tools` default. `all_tools: true` (set
 * deliberately) or `max_tools` overrides the suggestion — it never silently
 * hides a tool from the Connectors page, only from the chat turn.
 */
export function selectTools(conn, list) {
  const catalog = MCP_CATALOG.find((c) => conn?.url === `stdio:${c.id}` || conn?.id === c.id);
  const allow = Array.isArray(conn?.tool_allowlist) && conn.tool_allowlist.length
    ? conn.tool_allowlist
    : (conn?.all_tools === true ? null : catalog?.suggested_tools);
  let out = Array.isArray(allow) && allow.length ? list.filter((t) => allow.includes(t.name)) : list;
  const cap = Number(conn?.max_tools || 0);
  if (cap > 0) out = out.slice(0, cap);
  return out;
}

/** Build the chat tool list from a user's connected MCP servers. */
export async function collectTools(connections) {
  const tools = [];
  for (const conn of connections) {
    if (!conn.enabled) continue;
    try {
      const client = createClient(conn);
      await client.initialize();
      const list = selectTools(conn, await client.listTools());
      for (const t of list) {
        tools.push({
          type: 'function',
          function: {
            name: `mcp__${conn.id}__${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64),
            description: `[${conn.name}] ${t.description || t.name}`.slice(0, 1024),
            parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} }
          },
          _mcp: { connId: conn.id, toolName: t.name }
        });
      }
      await client.close();
    } catch (e) {
      tools.push({ _error: { connId: conn.id, error: redactText(e.message || e) } });
    }
  }
  return tools;
}

/** Execute one MCP tool call from the chat tool-loop. */
export async function executeTool(connections, mangledName, args) {
  const t = await (async () => {
    for (const conn of connections) {
      if (!conn.enabled) continue;
      const client = createClient(conn);
      await client.initialize();
      const list = await client.listTools();
      for (const t of list) {
        const mangled = `mcp__${conn.id}__${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64);
        if (mangled === mangledName) {
          const result = await client.callTool(t.name, args);
          await client.close();
          return result;
        }
      }
      await client.close();
    }
    return null;
  })();
  if (!t) return { error: `tool ${mangledName} not found in connected MCP servers` };
  return t;
}
