// Persistent store. Uses Supabase Postgres when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// are configured; otherwise a JSON file store (data/db.json) so everything works
// standalone. Same collection-style API either way.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH, getKey } from './keys.js';

const DB_FILE = path.join(DATA_PATH, 'db.json');

function loadFile() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], threads: [], reset_codes: [], mcp_connections: [], generations: [], sessions: [], audit: [] }; }
}

function saveFile(db) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let supabase = null;
async function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL || getKey('SUPABASE_URL');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || getKey('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) { supabase = false; return supabase; }
  try {
    // Lazy import so the file store works without the dependency installed.
    const mod = await import('@supabase/supabase-js');
    supabase = mod.createClient(url, key, { auth: { persistSession: false } });
  } catch {
    supabase = false;
  }
  return supabase;
}

// --- Collection API ---------------------------------------------------------

export async function insert(collection, row) {
  const sb = await getSupabase();
  if (sb) {
    const { data, error } = await sb.from(collection).insert(row).select().single();
    if (!error) return data;
  }
  const db = loadFile();
  db[collection] = db[collection] || [];
  db[collection].push(row);
  saveFile(db);
  return row;
}

export async function find(collection, pred = () => true, limit = 1000) {
  const sb = await getSupabase();
  if (sb) {
    const { data, error } = await sb.from(collection).select('*').limit(limit);
    if (!error && Array.isArray(data)) return data.filter(pred).slice(0, limit);
  }
  const db = loadFile();
  return (db[collection] || []).filter(pred).slice(0, limit);
}

export async function findOne(collection, pred = () => true) {
  const rows = await find(collection, pred, 1);
  return rows[0] || null;
}

export async function update(collection, pred, patch) {
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
  const db = loadFile();
  const before = (db[collection] || []).length;
  db[collection] = (db[collection] || []).filter((row) => !pred(row));
  saveFile(db);
  return before - db[collection].length;
}

export async function audit(entry) {
  return insert('audit', { id: `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry });
}
