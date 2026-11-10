// The Library — one place that answers "what did this workspace produce?".
//
// Every generator (Flux images, Hailuo video, the sandbox's written files, the
// Codex workspace, an exported skill, a document built from a template) writes a
// record here: kind, title, where the bytes live, what made it, and when. The
// record is what the Library page lists and filters, so a generated image is not
// lost the moment the page that made it is closed.
//
// Kinds are closed on purpose. An unknown kind is a bug in the caller, not a new
// feature, and the API says so instead of inventing an icon.
//
// Storage: `data/library/<account>.json` (DATA_PATH rules — desktop userData,
// server data dir, read-only in serverless, where records are simply not kept and
// the caller is told).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH } from './keys.js';

export const ARTIFACT_CATALOG = Object.freeze({
  image: { label: 'Image', icon: '▦', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] },
  video: { label: 'Video', icon: '▶', extensions: ['mp4', 'webm', 'mov'] },
  audio: { label: 'Audio', icon: '♪', extensions: ['mp3', 'wav', 'ogg', 'm4a'] },
  document: { label: 'Document', icon: '▤', extensions: ['md', 'txt', 'pdf', 'docx'] },
  presentation: { label: 'Presentation', icon: '◫', extensions: ['pptx', 'key'] },
  spreadsheet: { label: 'Spreadsheet', icon: '▥', extensions: ['xlsx', 'csv', 'tsv'] },
  code: { label: 'Code', icon: '⌘', extensions: [] },
  skill: { label: 'Skill', icon: '✦', extensions: ['md'] },
  dataset: { label: 'Dataset', icon: '⛁', extensions: ['json', 'jsonl', 'parquet'] },
  archive: { label: 'Archive', icon: '🗜', extensions: ['zip', 'tar', 'gz'] }
});

const ROOT = path.join(path.resolve(DATA_PATH), 'library');
const MAX_PER_ACCOUNT = 2000;
const MAX_TITLE = 160;

const safe = (k) => (/^[\w.-]{1,40}$/.test(String(k || '')) ? String(k) : 'default');

function fileFor(account) {
  return path.join(ROOT, `${safe(account)}.json`);
}

export function readLibrary(account) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(account), 'utf8'));
    return Array.isArray(data.items) ? data : { items: [], updated_at: null };
  } catch {
    return { items: [], updated_at: null };
  }
}

/** Add one record. Returns `{ ok, item, persisted }` — `persisted: false` on a
 *  read-only disk is an honest answer, not a failure to save silently. */
export function recordArtifact(account, item = {}) {
  const kind = String(item.kind || '');
  if (!ARTIFACT_CATALOG[kind]) {
    return { ok: false, error: `Unknown artifact kind "${kind}". Known: ${Object.keys(ARTIFACT_CATALOG).join(', ')}.` };
  }
  const record = {
    id: String(item.id || `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`),
    kind,
    title: String(item.title || ARTIFACT_CATALOG[kind].label).slice(0, MAX_TITLE),
    source: String(item.source || 'workspace').slice(0, 60),
    mime: item.mime || null,
    url: item.url || null,
    path: item.path || null,
    thumb: item.thumb || null,
    bytes: Number(item.bytes) || null,
    meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
    thread_id: item.thread_id || null,
    created_at: item.created_at || new Date().toISOString()
  };
  const lib = readLibrary(account);
  const items = [record, ...lib.items.filter((x) => x.id !== record.id)].slice(0, MAX_PER_ACCOUNT);
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(fileFor(account), JSON.stringify({ items, updated_at: record.created_at }, null, 2));
    return { ok: true, item: record, persisted: true };
  } catch (e) {
    return { ok: true, item: record, persisted: false, note: `This disk is read-only, so the record was returned but not kept (${String(e.code || e.message).slice(0, 60)}).` };
  }
}

export function listLibrary(account, { kind, q, limit = 120, since } = {}) {
  const lib = readLibrary(account);
  let items = lib.items;
  if (kind && ARTIFACT_CATALOG[kind]) items = items.filter((x) => x.kind === kind);
  if (since) items = items.filter((x) => String(x.created_at) >= String(since));
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    items = items.filter((x) => `${x.title} ${x.kind} ${x.source}`.toLowerCase().includes(query));
  }
  const n = Math.min(Math.max(Number(limit) || 120, 1), 500);
  return {
    ok: true,
    updated_at: lib.updated_at,
    total: items.length,
    kinds: Object.entries(ARTIFACT_CATALOG).map(([id, v]) => ({
      id, label: v.label, icon: v.icon, extensions: v.extensions,
      count: lib.items.filter((x) => x.kind === id).length
    })),
    items: items.slice(0, n)
  };
}

export function librarySummary(account) {
  const lib = readLibrary(account);
  const byKind = {};
  for (const it of lib.items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  return {
    ok: true,
    total: lib.items.length,
    by_kind: byKind,
    bytes: lib.items.reduce((n, it) => n + (it.bytes || 0), 0),
    updated_at: lib.updated_at,
    newest: lib.items.slice(0, 6)
  };
}
