// Persistent store. Talks to Supabase Postgres over PostgREST (plain fetch —
// no dependency) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured,
// so accounts, threads and per-user keys survive across serverless instances.
// Falls back to a JSON file store (data/db.json) for offline/desktop/dev.
// Same collection-style API on both backends.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH, getKey } from './keys.js';

const DB_FILE = path.join(DATA_PATH, 'db.json');

const COLL = ['users', 'threads', 'reset_codes', 'mcp_connections', 'generations', 'sessions', 'audit', 'outbox', 'user_keys', 'api_keys'];

// Read-only filesystems are normal in serverless (Vercel mounts /var/task
// read-only) and inside a packaged .exe. Writes there must degrade to memory
// for this instance instead of throwing in the middle of a sign-in.
let memory = null;
let fileWritable = true;
function memoryDb() {
  if (!memory) memory = Object.fromEntries(COLL.map((c) => [c, []]));
  return memory;
}

function loadFile() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return Object.fromEntries(COLL.map((c) => [c, []])); }
}

function saveFile(db) {
  if (!fileWritable) return false;
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch {
    // EROFS / EACCES / read-only package — keep everything in memory instead.
    fileWritable = false;
    memory = db;
    return false;
  }
}

// --- PostgREST client ---------------------------------------------------------

function restConfig() {
  const url = process.env.SUPABASE_URL || getKey('SUPABASE_URL');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || getKey('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

const TIME_FIELDS = ['created_at', 'updated_at', 'expires_at', 'claimed_at', 'connected_at', 'last_test', 'at', 'approved_at', 'used_at'];

// Some ledgers (reset_codes on older migrations) have no updated_at column —
// stamping it made the PATCH fail, so a "used" code was never actually marked
// and stayed replayable until it expired. Collections are remembered after the
// first refusal so this is self-healing for any table.
const NO_UPDATED_AT = new Set();
function stamped(collection, patch) {
  if (NO_UPDATED_AT.has(collection)) return patch;
  return { ...patch, updated_at: new Date().toISOString() };
}
function noteMissingColumn(collection, message) {
  if (/updated_at/i.test(String(message)) && /does not exist|column|not found|schema/i.test(String(message))) NO_UPDATED_AT.add(collection);
}
function normalizeRow(row) {
  const out = { ...row };
  for (const f of TIME_FIELDS) {
    if (typeof out[f] === 'number') out[f] = new Date(out[f]).toISOString();
  }
  return out;
}

async function rest(collection, { method = 'GET', query = '', body, prefer } = {}) {
  const cfg = restConfig();
  if (!cfg) return null;
  const headers = {
    apikey: cfg.key,
    'Content-Type': 'application/json'
  };
  // Legacy anon/service_role keys are JWTs, so PostgREST accepts them as a
  // bearer token. The new sb_publishable_/sb_secret_ keys are NOT JWTs and must
  // ride on `apikey` only — sending them as a bearer gets a 401.
  if (!/^sb_/i.test(String(cfg.key))) headers.Authorization = `Bearer ${cfg.key}`;
  if (prefer) headers.Prefer = prefer;
  try {
    const payload = Array.isArray(body) ? body.map(normalizeRow) : body ? normalizeRow(body) : undefined;
    const res = await fetch(`${cfg.url}/rest/v1/${collection}${query}`, {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      return { error: data?.message || text.slice(0, 200), status: res.status };
    }
    return { data };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// --- Collection API -----------------------------------------------------------

/** Local (offline/desktop/serverless-fallback) rows. Memory mirrors the file so
 *  a warm instance keeps working when the filesystem is read-only. */
function readLocal() {
  if (!fileWritable) return memoryDb();
  const db = loadFile();
  if (memory) {
    for (const c of COLL) {
      const mem = memory[c] || [];
      if (!mem.length) continue;
      db[c] = db[c] || [];
      for (const row of mem) {
        const i = db[c].findIndex((x) => x && x.id === row.id);
        if (i >= 0) db[c][i] = { ...db[c][i], ...row };
        else db[c].push(row);
      }
    }
  }
  return db;
}

function writeLocal(db) {
  memory = db;
  saveFile(db);
  return db;
}

export async function insert(collection, row) {
  const r = await rest(collection, {
    method: 'POST', body: row, prefer: 'return=representation'
  });
  if (r && !r.error) return (Array.isArray(r.data) ? r.data[0] : r.data) || row;
  // fallback: JSON store (or memory when the disk is read-only)
  const db = readLocal();
  db[collection] = db[collection] || [];
  if (!db[collection].some((x) => x.id === row.id)) db[collection].push(row);
  writeLocal(db);
  return row;
}

export async function find(collection, pred = () => true, limit = 1000) {
  const r = await rest(collection, { query: `?select=*&limit=${Math.min(limit * 4, 20000)}` });
  if (r && !r.error && Array.isArray(r.data)) return r.data.filter(pred).slice(0, limit);
  const db = readLocal();
  return (db[collection] || []).filter(pred).slice(0, limit);
}

/** Filter server-side (PostgREST query string) so lookups stay correct and
 *  cheap once a table outgrows the scan limit. `pred` is re-applied locally so
 *  the JSON fallback behaves identically. */
export async function findWhere(collection, query, pred = () => true, limit = 200) {
  const r = await rest(collection, { query: `?${query}&limit=${Math.min(limit, 1000)}` });
  if (r && !r.error && Array.isArray(r.data)) return r.data.filter(pred).slice(0, limit);
  const db = readLocal();
  return (db[collection] || []).filter(pred).slice(0, limit);
}

export async function findOneWhere(collection, query, pred = () => true) {
  const rows = await findWhere(collection, query, pred, 1);
  return rows[0] || null;
}

export async function findOne(collection, pred = () => true) {
  const rows = await find(collection, pred, 1);
  return rows[0] || null;
}

/** Patch one row by primary key — no full-table scan. This is what the sign-in
 *  hot path (session stamping, code consumption) should use. */
export async function updateById(collection, id, patch) {
  if (!id) return 0;
  const run = async (body) => {
    const r = await rest(collection, {
      method: 'PATCH', query: `?id=eq.${encodeURIComponent(id)}`, body, prefer: 'return=representation'
    });
    return r;
  };
  if (restConfig()) {
    let r = await run(stamped(collection, patch));
    if (r && r.error && !NO_UPDATED_AT.has(collection)) {
      noteMissingColumn(collection, r.error);
      r = await run(stamped(collection, patch));
    }
    if (r && !r.error) {
      // 0 rows back = the row is not in the table yet (wiped ledger, a row
      // created only on this device) → upsert it rather than lose the write.
      if (Array.isArray(r.data) && r.data.length === 0) {
        const up = await rest(collection, {
          method: 'POST',
          body: { ...stamped(collection, patch), id },
          prefer: 'return=representation,resolution=merge-duplicates'
        });
        if (up && !up.error) return 1;
        const db = readLocal();
        db[collection] = db[collection] || [];
        const i = db[collection].findIndex((x) => x && x.id === id);
        const next = { ...(i >= 0 ? db[collection][i] : {}), ...stamped(collection, patch), id };
        if (i >= 0) db[collection][i] = next; else db[collection].push(next);
        writeLocal(db);
        return 1;
      }
      return 1;
    }
  }
  const db = readLocal();
  let hit = 0;
  db[collection] = (db[collection] || []).map((row) => {
    if (row && row.id === id) { hit++; return { ...row, ...stamped(collection, patch) }; }
    return row;
  });
  if (!hit) db[collection].push({ id, ...stamped(collection, patch) });
  writeLocal(db);
  return 1;
}

export async function update(collection, pred, patch) {
  const rows = await find(collection, pred, 20000);
  if (!rows.length) return 0;
  const cfg = restConfig();
  if (cfg) {
    let count = 0;
    for (const row of rows) {
      const body = stamped(collection, patch);
      let r = await rest(collection, {
        method: 'PATCH',
        query: `?id=eq.${encodeURIComponent(row.id)}`,
        body, prefer: 'return=representation'
      });
      if (r && r.error && !NO_UPDATED_AT.has(collection)) {
        noteMissingColumn(collection, r.error);
        r = await rest(collection, {
          method: 'PATCH', query: `?id=eq.${encodeURIComponent(row.id)}`,
          body: stamped(collection, patch), prefer: 'return=representation'
        });
      }
      if (r && !r.error) { count++; continue; }
      // Row missing in the DB (ids-only local) — patch the local copy too.
      const db = readLocal();
      db[collection] = (db[collection] || []).map((x) => (x.id === row.id ? { ...x, ...patch } : x));
      writeLocal(db);
      count++;
    }
    return count;
  }
  const db = readLocal();
  db[collection] = db[collection] || [];
  let count = 0;
  db[collection] = db[collection].map((row) => {
    if (pred(row)) { count++; return { ...row, ...stamped(collection, patch) }; }
    return row;
  });
  writeLocal(db);
  return count;
}

export async function remove(collection, pred) {
  const rows = await find(collection, pred, 20000);
  if (!rows.length) return 0;
  const cfg = restConfig();
  const db = readLocal();
  if (cfg) {
    let count = 0;
    for (const row of rows) {
      const r = await rest(collection, { method: 'DELETE', query: `?id=eq.${encodeURIComponent(row.id)}` });
      if (r && !r.error) count++;
    }
    if (count) {
      db[collection] = (db[collection] || []).filter((row) => !pred(row));
      writeLocal(db);
      return count;
    }
  }
  const before = (db[collection] || []).length;
  db[collection] = (db[collection] || []).filter((row) => !pred(row));
  writeLocal(db);
  return before - db[collection].length;
}

export async function audit(entry) {
  return insert('audit', { id: `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry });
}

/** Per-user API key overrides — tied to the account email. */
export async function saveUserKey(email, keyEnv, value) {
  const existing = await find('user_keys', (k) => k.email === email && k.key_env === keyEnv);
  if (existing[0]) {
    await update('user_keys', (k) => k.id === existing[0].id, { value });
    return { ...existing[0], value };
  }
  return insert('user_keys', {
    id: `uk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    email, key_env: keyEnv, value, created_at: new Date().toISOString()
  });
}

export async function userKeyMap(email) {
  if (!email) return {};
  const rows = await find('user_keys', (k) => k.email === email, 500);
  const map = {};
  for (const r of rows) if (r.value) map[r.key_env] = r.value;
  return map;
}

export async function deleteUserKey(email, keyEnv) {
  return remove('user_keys', (k) => k.email === email && k.key_env === keyEnv);
}
