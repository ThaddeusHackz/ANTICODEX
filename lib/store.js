// Persistent store. Talks to Supabase Postgres over PostgREST (plain fetch —
// no dependency) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured,
// so accounts, threads and per-user keys survive across serverless instances.
// Falls back to a JSON file store (data/db.json) for offline/desktop/dev.
// Same collection-style API on both backends.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH, getKey } from './keys.js';

const DB_FILE = path.join(DATA_PATH, 'db.json');

function loadFile() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], threads: [], reset_codes: [], mcp_connections: [], generations: [], sessions: [], audit: [], outbox: [], user_keys: [] }; }
}

function saveFile(db) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- PostgREST client ---------------------------------------------------------

function restConfig() {
  const url = process.env.SUPABASE_URL || getKey('SUPABASE_URL');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || getKey('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

const TIME_FIELDS = ['created_at', 'updated_at', 'expires_at', 'claimed_at', 'connected_at', 'last_test', 'at', 'approved_at', 'used_at'];
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
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  try {
    const payload = Array.isArray(body) ? body.map(normalizeRow) : body ? normalizeRow(body) : undefined;
    const res = await fetch(`${cfg.url}/rest/v1/${collection}${query}`, {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload)
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

export async function insert(collection, row) {
  const r = await rest(collection, {
    method: 'POST', body: row, prefer: 'return=representation'
  });
  if (r && !r.error) return (Array.isArray(r.data) ? r.data[0] : r.data) || row;
  // fallback: JSON store
  const db = loadFile();
  db[collection] = db[collection] || [];
  if (!db[collection].some((x) => x.id === row.id)) db[collection].push(row);
  saveFile(db);
  return row;
}

export async function find(collection, pred = () => true, limit = 1000) {
  const r = await rest(collection, { query: `?select=*&limit=${Math.min(limit * 4, 20000)}` });
  if (r && !r.error && Array.isArray(r.data)) return r.data.filter(pred).slice(0, limit);
  const db = loadFile();
  return (db[collection] || []).filter(pred).slice(0, limit);
}

export async function findOne(collection, pred = () => true) {
  const rows = await find(collection, pred, 1);
  return rows[0] || null;
}

export async function update(collection, pred, patch) {
  const rows = await find(collection, pred, 20000);
  if (!rows.length) return 0;
  const cfg = restConfig();
  if (cfg) {
    let count = 0;
    for (const row of rows) {
      const r = await rest(collection, {
        method: 'PATCH',
        query: `?id=eq.${encodeURIComponent(row.id)}`,
        body: { ...patch, updated_at: new Date().toISOString() },
        prefer: 'return=representation'
      });
      if (r && !r.error) count++;
      else {
        // row missing in DB (ids-only local) — fall through to JSON below
        const db = loadFile();
        db[collection] = (db[collection] || []).map((x) => (x.id === row.id ? { ...x, ...patch } : x));
        saveFile(db);
        count++;
      }
    }
    return count;
  }
  const db = loadFile();
  db[collection] = db[collection] || [];
  let count = 0;
  db[collection] = db[collection].map((row) => {
    if (pred(row)) { count++; return { ...row, ...patch, updated_at: new Date().toISOString() }; }
    return row;
  });
  saveFile(db);
  return count;
}

export async function remove(collection, pred) {
  const rows = await find(collection, pred, 20000);
  if (!rows.length) return 0;
  const cfg = restConfig();
  if (cfg) {
    let count = 0;
    for (const row of rows) {
      const r = await rest(collection, { method: 'DELETE', query: `?id=eq.${encodeURIComponent(row.id)}` });
      if (r && !r.error) count++;
    }
    if (count) return count;
  }
  const db = loadFile();
  const before = (db[collection] || []).length;
  db[collection] = (db[collection] || []).filter((row) => !pred(row));
  saveFile(db);
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
