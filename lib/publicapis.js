// public-apis: the free replacement for the Glasser broker.
//
// Glasser was one line in the toolbelt: "reach for this when a task needs external
// data". It cost money per call and needed a key. public-apis is a catalogue of
// 2,335 free endpoints — 1,136 of them need no auth at all — so the agent can do
// that job with no broker in the middle.
//
// Two operations matter:
//   search   the model asks in words; this ranks 2,335 rows by relevance
//   call     the model asks for one endpoint by id; this performs a GET, with the
//            refusal rules below
//
// Refusal is part of the contract, not an afterthought. A tool that will happily
// fetch `http://` from an arbitrary description is an SSRF gadget, so:
//   * http:// is allowed only when the catalogue says that API has no TLS, and the
//     call is reported as `insecure: true` — never silently upgraded.
//   * private, loopback and link-local hosts are refused outright (a model must not
//     be able to read 169.254.169.254 through a "public API" tool).
//   * bodies are capped, timeouts are enforced, and only GET/HEAD are offered:
//     nothing here can POST a payload or delete a resource.
//   * an apiKey-auth API is refused with the reason and the exact header it wants,
//     because sending an invented key is worse than not calling.
//
// The catalogue is a build artifact (scripts/build-public-apis.mjs) pinned by
// commit, read live from disk so a rebuild is picked up on the next call.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CACHE = { at: 0, data: null };
const MAX_BODY = 400_000;
const TIMEOUT = 15_000;

export function cataloguePath() {
  return path.join(ROOT, 'lib', 'public-apis.json');
}

/** Load the catalogue. Cached per mtime so a rebuild is seen without a restart. */
export function loadCatalogue() {
  const file = cataloguePath();
  try {
    const st = fs.statSync(file);
    if (CACHE.data && CACHE.at === st.mtimeMs) return CACHE.data;
    CACHE.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    CACHE.at = st.mtimeMs;
    return CACHE.data;
  } catch {
    return { available: false, count: 0, entries: [], note: 'The catalogue has not been built. Run `node scripts/build-public-apis.mjs`.' };
  }
}

export function catalogueStats() {
  const c = loadCatalogue();
  return {
    available: c.entries.length > 0,
    count: c.count || 0,
    categories: c.categories || 0,
    by_category: c.by_category || {},
    by_auth: c.by_auth || {},
    tls: c.tls || {},
    cors: c.cors || {},
    no_auth: c.no_auth || (c.entries || []).filter((e) => e.auth === 'none').length,
    source: c.source || null,
    generated_at: c.generated_at || null
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'with', 'api', 'apis', 'get', 'find', 'me', 'some', 'any']);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t));
}

/**
 * Rank the catalogue against a query. Deterministic and dependency-free: an exact
 * name match beats a name prefix, which beats a description hit, which beats a
 * category hit — then a small popularity prior (categories with more entries are
 * broader, so a match inside a narrow category is more specific) breaks ties.
 */
export function search(query, { limit = 20, category, auth, https: wantHttps, cors, page = 1, per } = {}) {
  const c = loadCatalogue();
  const entries = c.entries || [];
  const size = Math.max(1, Math.min(Number(per) || limit || 20, 100));
  const p = Math.max(1, Number(page) || 1);
  const qs = tokens(query);

  let pool = entries;
  if (category) pool = pool.filter((e) => String(e.category).toLowerCase() === String(category).toLowerCase());
  if (auth) pool = pool.filter((e) => e.auth === auth);
  if (wantHttps === true) pool = pool.filter((e) => e.https === true);
  if (cors === true) pool = pool.filter((e) => e.cors === true);

  if (!qs.length) {
    // A browse, not a search: still deterministic (alphabetical by name).
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const total = sorted.length;
    return {
      ok: true, query: query || '', total, page: p, per: size,
      entries: sorted.slice((p - 1) * size, p * size).map(brief),
      note: `Browsing ${total} of ${entries.length} catalogue entries.`
    };
  }

  const scored = [];
  for (const e of pool) {
    const name = String(e.name).toLowerCase();
    const desc = String(e.description || '').toLowerCase();
    const cat = String(e.category || '').toLowerCase();
    const host = String(e.host || '').toLowerCase();
    let score = 0;
    const why = [];
    for (const t of qs) {
      if (name === t) { score += 100; why.push('name'); }
      else if (name.startsWith(t)) { score += 60; why.push('name'); }
      else if (new RegExp(`\\b${escapeRe(t)}`).test(name)) { score += 40; why.push('name'); }
      if (desc.includes(t)) { score += 12; why.push('description'); }
      if (cat.includes(t)) { score += 18; why.push('category'); }
      if (host.includes(t)) { score += 8; why.push('host'); }
    }
    if (!score) continue;
    // Whole-query-in-name is a strong signal ("cat facts" → Cat Facts).
    const whole = qs.join(' ');
    if (name.includes(whole)) score += 50;
    // Free-to-call APIs are more useful than ones that will be refused for a key.
    if (e.auth === 'none') score += 6;
    if (e.https === true) score += 2;
    if (e.cors === true) score += 1;
    scored.push({ e, score, why: [...new Set(why)] });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  const total = scored.length;
  return {
    ok: true, query, total, page: p, per: size,
    entries: scored.slice((p - 1) * size, p * size).map((s) => ({ ...brief(s.e), score: s.score, matched: s.why }))
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function brief(e) {
  return {
    id: e.id, name: e.name, description: e.description, category: e.category,
    auth: e.auth, https: e.https, cors: e.cors, url: e.url
  };
}

export function getEntry(id) {
  const c = loadCatalogue();
  return (c.entries || []).find((e) => e.id === id) || null;
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

const PRIVATE_V4 = [
  [/^10\./, 'private range 10/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local (cloud metadata lives here)'],
  [/^192\.168\./, 'private range 192.168/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private range 172.16/12'],
  [/^0\./, 'unspecified'],
  [/^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, 'carrier-grade NAT']
];

/** Why a URL must not be fetched by a model, or null if it is fine. */
export function blockedTarget(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'not a valid URL'; }
  if (!/^https?:$/.test(u.protocol)) return `scheme ${u.protocol} is not allowed (GET/HEAD over http or https only)`;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback hostname';
  if (host.endsWith('.internal') || host.endsWith('.local')) return 'internal hostname';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const hit = PRIVATE_V4.find(([re]) => re.test(host));
    if (hit) return hit[1];
  }
  if (host === '[::1]' || host === '::1') return 'loopback IPv6';
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'unique-local IPv6';
  if (/^fe80:/i.test(host)) return 'link-local IPv6';
  return null;
}

/**
 * GET one catalogue entry's endpoint.
 *
 * `path` is appended to the entry's URL (query strings included). The result says
 * where it went, what came back, and — when it refuses — exactly why, because a
 * model that is told "404" learns nothing while "this API wants ?api_key=… and you
 * supplied none" teaches it what to do next.
 */
export async function callApi(id, { path: sub = '', headers = {}, timeoutMs = TIMEOUT, method = 'GET' } = {}) {
  const entry = getEntry(id);
  if (!entry) {
    const near = search(id, { limit: 3 }).entries;
    return {
      ok: false, error: `No catalogue entry with id "${id}".`,
      hint: 'Search first (`publicapi op=search q=…`) and pass the exact `id` it returns.',
      did_you_mean: near.map((e) => e.id)
    };
  }
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) {
    return { ok: false, error: 'Only GET and HEAD are offered — this tool cannot write to a third-party service.' };
  }
  if (entry.auth === 'apiKey') {
    return {
      ok: false, entry: brief(entry), refused: 'auth_required',
      error: `${entry.name} needs an API key, so it is not callable with no credentials.`,
      hint: `Add the key to the request headers yourself (usually a header like "X-Api-Key" or a query parameter) — this tool never invents one. Docs: ${entry.url}`,
      alternative: `APIs in "${entry.category}" that need no key: ` +
        search('', { category: entry.category, auth: 'none', limit: 3 }).entries.map((e) => e.id).join(', ')
    };
  }
  if (entry.auth === 'oauth') {
    return {
      ok: false, entry: brief(entry), refused: 'auth_required',
      error: `${entry.name} uses OAuth, which needs a user-authorised token this tool does not hold.`,
      hint: `Complete the OAuth flow and pass the bearer token in headers. Docs: ${entry.url}`
    };
  }

  let target;
  try {
    const base = new URL(entry.url);
    if (sub) {
      // `sub` is a path/query fragment, not a second URL: anything absolute is
      // refused rather than re-pointing the request at another host.
      if (/^[a-z]+:\/\//i.test(sub)) return { ok: false, error: '`path` must be a path or query, not a full URL.' };
      const u = new URL(sub.startsWith('?') ? base + sub : (base.pathname.endsWith('/') ? base : new URL(base.href.replace(/\/?$/, '/'))) + sub.replace(/^\//, ''));
      if (u.host !== base.host) return { ok: false, error: '`path` must stay on the entry\'s host.' };
      target = u.href;
    } else {
      target = base.href;
    }
  } catch (e) {
    return { ok: false, error: `Could not build a request URL: ${String(e.message || e)}` };
  }

  const blocked = blockedTarget(target);
  if (blocked) return { ok: false, entry: brief(entry), refused: 'blocked_target', error: `Refusing to fetch ${target}: ${blocked}.` };

  if (entry.https === false && target.startsWith('http://')) {
    // Allowed by the catalogue, but never quietly: the caller is told the traffic
    // is in the clear and can decide not to use this API.
    // (No upgrade attempt — some of these hosts have no TLS at all.)
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(Number(timeoutMs) || TIMEOUT, 30_000)));
  const started = Date.now();
  const sent = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'ANTICODEX/1 public-apis-tool (+https://github.com/ThaddeusHackz/ANTICODEX)' };
  for (const [k, v] of Object.entries(headers || {}).slice(0, 10)) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(k)) continue;      // header-name sanity
    if (String(v).length > 2000) continue;
    sent[String(k).toLowerCase()] = String(v);
  }

  try {
    const res = await fetch(target, { method: String(method).toUpperCase(), headers: sent, redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    const raw = await res.text();
    const truncated = raw.length > MAX_BODY;
    const body = truncated ? raw.slice(0, MAX_BODY) : raw;
    let parsed = null;
    if (/json/.test(type)) { try { parsed = JSON.parse(body); } catch { /* malformed json is still a result */ } }
    return {
      ok: res.ok,
      status: res.status,
      entry: brief(entry),
      url: target,
      insecure: target.startsWith('http://'),
      content_type: type,
      bytes: raw.length,
      truncated,
      duration_ms: Date.now() - started,
      // JSON is handed over parsed so the model does not have to re-parse a string;
      // anything else is text, capped.
      body: parsed !== null ? parsed : body,
      hint: res.ok ? undefined
        : res.status === 401 || res.status === 403 ? 'The endpoint refused anonymously — it may need a key even though the catalogue says otherwise; try headers.'
        : res.status === 429 ? 'Rate limited. Wait, or pick another endpoint.'
        : res.status === 404 ? 'The catalogue URL may be a documentation page rather than the API root; try a `path` under the documented base.'
        : undefined
    };
  } catch (e) {
    const timedOut = /abort/i.test(String(e.name || e.message));
    return {
      ok: false, entry: brief(entry), url: target,
      error: timedOut ? `No answer within ${Math.round((Date.now() - started) / 1000)}s.` : String(e.message || e),
      hint: timedOut ? 'The host may be down or unreachable from this machine. Try another catalogue entry in the same category.'
        : 'Check the host is reachable from this machine (some free APIs disappear).'
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool surface for the agent
// ---------------------------------------------------------------------------

/** The OpenAI-style tool definition the agent loop hands to a model. */
export function publicApiTools() {
  const c = loadCatalogue();
  if (!c.entries?.length) return [];
  return [{
    type: 'function',
    function: {
      name: 'public_api',
      description:
        `Search ${c.count} free public APIs (public-apis catalogue: ${Object.keys(c.by_category || {}).length} categories, ` +
        `${(c.entries || []).filter((e) => e.auth === 'none').length} need no auth) and call one with a GET. ` +
        'Use this for external data — weather, countries, currency, geocoding, dictionaries, package versions, ' +
        'science, government datasets — instead of guessing at an endpoint. Search first, then call with the exact id.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['search', 'call', 'categories'], description: 'search the catalogue, call one entry, or list categories' },
          q: { type: 'string', description: 'search words, e.g. "currency exchange rates"' },
          id: { type: 'string', description: 'exact catalogue id from a previous search, e.g. "cat-facts@catfact.ninja"' },
          path: { type: 'string', description: 'path or query appended to the entry URL, e.g. "/v1/latest?base=USD"' },
          headers: { type: 'object', description: 'extra request headers, for an API that needs a key you were given' },
          category: { type: 'string', description: 'restrict a search to one category' },
          auth: { type: 'string', enum: ['none', 'apiKey', 'oauth'], description: 'restrict a search by auth model' },
          limit: { type: 'number', description: 'how many results (default 20, max 100)' }
        },
        required: ['op']
      }
    },
    _builtin: 'public_api'
  }];
}

/** Execute one `public_api` tool call. Always resolves. */
export async function runPublicApi(args = {}) {
  const op = String(args.op || 'search');
  if (op === 'search') return search(args.q || '', { limit: args.limit, category: args.category, auth: args.auth });
  if (op === 'call') return callApi(String(args.id || ''), { path: args.path, headers: args.headers, timeoutMs: args.timeout_ms });
  if (op === 'categories') {
    const c = loadCatalogue();
    return {
      ok: true, count: c.count || 0,
      categories: Object.entries(c.by_category || {}).map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count)
    };
  }
  return { ok: false, error: `unknown public_api op "${op}" (search | call | categories)` };
}

/** A compact prompt line so a model knows the catalogue exists before it calls. */
export function publicApiPrompt() {
  const c = loadCatalogue();
  if (!c.entries?.length) return '';
  const free = (c.entries || []).filter((e) => e.auth === 'none').length;
  return `External data: a catalogue of ${c.count} free public APIs is available through the \`public_api\` tool ` +
    `(${free} need no auth). Search it with plain words, then call the exact id it returns. Prefer http-free (https) ` +
    `endpoints, and never invent a key — if an entry needs one, say so.`;
}

export const PUBLIC_API_LIMITS = Object.freeze({
  max_body: MAX_BODY,
  timeout_ms: TIMEOUT,
  methods: ['GET', 'HEAD'],
  host_policy: 'public http(s) only — loopback, private, link-local and metadata addresses are refused'
});
