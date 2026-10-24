// Tool discovery is the slowest thing in the chat path, and it used to be on the
// critical path of every single message.
//
// A connected MCP server is a child process: `collectTools()` spawns it, waits for
// its initialize handshake, asks for its tool list and kills it again. That is
// ~4 s for REA's 207 tools before the model is even contacted — measured on this
// machine, with `use_mcp:true` costing 4.35 s against 0.05 s without it — and it
// happened again on the next message, and the next.
//
// What the chat call actually needs is the tool *schemas*, which change when the
// server is reinstalled, not when a message is sent. So they are cached here per
// connection fingerprint (in memory, and on disk so a restart does not pay for it
// again), and a cold cache never blocks the answer: the model call goes out with
// the tools we already have and the cache is warmed in the background for the
// next turn.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH } from './keys.js';
import { collectTools } from './mcp.js';

const TTL_MS = 10 * 60 * 1000;      // a server's tool list, not its state
const STALE_MS = 60 * 60 * 1000;    // still usable while it warms again
const ROOT = path.resolve(DATA_PATH);
const FILE = path.join(ROOT, 'mcp-tools.json');

let db = null;
const inflight = new Map();

function load() {
  if (db) return db;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = raw && raw.v === 1 && raw.entries && typeof raw.entries === 'object' ? raw : { v: 1, entries: {} };
  } catch {
    db = { v: 1, entries: {} };
  }
  return db;
}

function save() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  } catch { /* read-only filesystem: the memory copy still helps this process */ }
}

/** What makes two requests need the same tools: which servers, at which version. */
export function connectionKey(conns = []) {
  return conns
    .map((c) => `${c.id}@${c.updated_at || c.connected_at || 'na'}:${c.enabled === false ? 0 : 1}`)
    .sort()
    .join('|');
}

/** Cached tools for these connections, or null when there is nothing usable. */
export function cachedTools(conns, { now = Date.now(), allowStale = true } = {}) {
  const key = connectionKey(conns);
  if (!key) return null;
  const entry = load().entries[key];
  if (!entry || !Array.isArray(entry.tools)) return null;
  const age = now - entry.at;
  if (age > (allowStale ? STALE_MS : TTL_MS)) return null;
  return { tools: entry.tools, age_ms: age, stale: age > TTL_MS, key };
}

/** Refresh the cache for these connections. Concurrent callers share one spawn. */
export function warmTools(conns) {
  const key = connectionKey(conns);
  if (!key) return Promise.resolve({ tools: [], key: null });
  const running = inflight.get(key);
  if (running) return running;
  const run = (async () => {
    const listed = await collectTools(conns);
    const tools = listed.filter((t) => !t._error);
    // A server that failed to answer is recorded, not swallowed: "no tools" and
    // "the server did not start" are different things for the person debugging it.
    const errors = listed.filter((t) => t._error).map((t) => ({ connId: t._error.connId, error: t._error.error }));
    const next = { at: Date.now(), tools, errors };
    load().entries[key] = next;
    // Keep the file from growing forever: drop entries nobody has asked for in a day.
    const entries = db.entries;
    for (const [k, v] of Object.entries(entries)) {
      if (Date.now() - (v.at || 0) > 24 * 60 * 60 * 1000) delete entries[k];
    }
    save();
    return { tools, key, at: next.at };
  })().catch(() => ({ tools: [], key, error: true })).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/**
 * Tools for this request, without ever making the user wait for a cold cache.
 *
 * `waitMs` is the whole budget: a warm cache answers instantly, a cold one gets a
 * short head start (enough for a quick server) and then the answer goes out
 * without tools while the handshake finishes in the background. The next message
 * is a tool turn; this one is an answer, which is what was asked for.
 */
export async function toolsFor(conns = [], { waitMs = 200 } = {}) {
  const hit = cachedTools(conns);
  if (hit && !hit.stale) return { tools: hit.tools, from: 'cache', age_ms: hit.age_ms };

  const warm = warmTools(conns);
  const started = Date.now();
  const raced = await Promise.race([
    warm,
    new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, waitMs)))
  ]);
  if (raced && Array.isArray(raced.tools)) return { tools: raced.tools, from: 'fresh', ms: Date.now() - started };
  // Cold and slow: answer now, and let the handshake land for the next turn.
  if (hit) return { tools: hit.tools, from: 'stale', age_ms: hit.age_ms, warming: true };
  return { tools: [], from: 'warming', warming: true };
}

/** Forget one connection set (after a save/delete/reconnect). */
export function forgetTools(conns = null) {
  const entries = load().entries;
  if (!conns) { db.entries = {}; save(); return 0; }
  const key = connectionKey(conns);
  const had = Boolean(entries[key]);
  delete entries[key];
  if (had) save();
  return had ? 1 : 0;
}

export function toolCacheSummary() {
  const entries = load().entries;
  return Object.entries(entries).map(([key, v]) => ({
    key, tools: (v.tools || []).length, at: v.at || null, age_ms: Date.now() - (v.at || 0)
  }));
}

// Re-exported so the bridge can warm without importing mcp.js twice.
export { TTL_MS as TOOL_TTL_MS };
