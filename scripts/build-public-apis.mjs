#!/usr/bin/env node
// Build the public-apis catalogue that replaces Glasser.
//
// Glasser was a paid broker: "reach for this when a task needs external data".
// public-apis (MIT, 497k stars) is the same shelf for free: 2,300+ real endpoints
// with their auth model, HTTPS support and CORS policy. Two things are produced:
//
//   lib/public-apis.json          — the machine-readable catalogue (the agent reads
//                                   this; `publicapi op=search` queries it)
//   web/public/public-apis.json   — the same file for the browser, so the catalogue
//                                   page works from a static deployment too
//
// The README is the only source of truth, and it is pinned by commit: a catalogue
// that silently changes under the agent is worse than one that is a year old.
// `scripts/README-DATA.md` documents the columns; nothing here guesses a URL —
// every row's href is exactly what upstream published.
//
// Run: node scripts/build-public-apis.mjs [--refresh]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CACHE = path.join(ROOT, 'vendor', 'public-apis-README.md');
const OUT_LIB = path.join(ROOT, 'lib', 'public-apis.json');
const OUT_WEB = path.join(ROOT, 'web', 'public', 'public-apis.json');

// Pinned, and re-resolved only with --refresh, so the file the agent searches and
// the file a test asserts on are the same bytes.
const SOURCE = {
  repo: 'public-apis/public-apis',
  path: 'README.md',
  // The default branch is `master`. It said `main` and every fetch 404'd — which
  // the pinned-copy path hid, so the catalogue built from a file nobody had
  // verified. A wrong branch is now a hard failure, not a silent fallback.
  branch: 'master',
  license: 'MIT',
  url: 'https://github.com/public-apis/public-apis'
};

async function fetchReadme() {
  const api = `https://api.github.com/repos/${SOURCE.repo}/contents/${SOURCE.path}?ref=${SOURCE.branch}`;
  const res = await fetch(api, {
    headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'anticodex-build' }
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${SOURCE.repo}/${SOURCE.path}`);
  const text = await res.text();
  // The commit is recorded so the catalogue can say exactly which revision it is.
  let commit = null;
  try {
    const meta = await fetch(`https://api.github.com/repos/${SOURCE.repo}/commits?sha=${SOURCE.branch}&per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anticodex-build' }
    });
    if (meta.ok) {
      const list = await meta.json();
      commit = Array.isArray(list) ? (list[0]?.sha || null) : null;
    }
  } catch { /* the catalogue is still usable without a pinned sha */ }
  if (!commit) console.warn('  ! could not resolve a commit sha; the catalogue will say "unpinned"');
  return { text, commit };
}

/** A markdown table cell → plain text. Links become their label, entities decode. */
function cell(raw) {
  let t = String(raw || '').trim();
  const link = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) t = link[1];
  else t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // The badge/image cells in this README are HTML; they are not data.
  t = t.replace(/<[^>]+>/g, '').trim();
  return t
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

/** Pull the outbound href from the API-name cell. Only an absolute http(s) URL is
 *  accepted — a catalogue row with no reachable address is not callable, and the
 *  agent must not be handed a guess. */
function href(raw) {
  const m = String(raw || '').match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  return m ? m[1] : null;
}

// An empty cell is "the catalogue does not say", which is a different fact from a
// cell that says `No`. Both used to collapse into a value, so the agent was told a
// confident "no auth needed" about 1,100 APIs whose auth column is simply blank.
const UNKNOWN = 'unknown';

function normaliseAuth(s) {
  const t = cell(s).toLowerCase().replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return UNKNOWN;
  if (t === 'no' || t === 'none' || t === 'no auth') return 'none';
  if (t.includes('oauth')) return 'oauth';
  if (t.includes('user-agent')) return 'user-agent';
  if (t.includes('api key') || t.includes('apikey') || t === 'x-mashape-key') return 'apiKey';
  if (t.includes('calendar') || t.includes('token') || t.includes('cookie')) return t;
  return t || UNKNOWN;
}

function yesNo(s, { unknownWhenAbsent = true } = {}) {
  const t = cell(s).toLowerCase().replace(/`/g, '').trim();
  if (t === 'yes') return true;
  if (t === 'no') return false;
  if (!t && !unknownWhenAbsent) return false;
  return null;                                        // unknown, never a confident false
}

function parse(readme) {
  const lines = readme.split('\n');
  const rows = [];
  let category = null;
  let inIndex = false;
  const indexStart = lines.findIndex((l) => /^##\s+Index\s*$/.test(l));
  for (const line of indexStart >= 0 ? lines.slice(indexStart + 1) : lines) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      const name = cell(h[1]);
      inIndex = false;
      category = name;
      continue;
    }
    if (/^##\s+/.test(line)) { inIndex = false; category = null; continue; }   // ## APILayer APIs, ## MCP Servers…
    if (inIndex || !category) continue;
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cols.length < 5) continue;
    if (/^[:\- ]+$/.test(cols[0])) continue;                  // the |:---| separator
    if (/^api$/i.test(cell(cols[0]))) continue;               // the header row
    const url = href(cols[0]);
    const name = cell(cols[0]);
    if (!name || !url) continue;
    rows.push({
      name,
      description: cell(cols[1]),
      auth: normaliseAuth(cols[2]),
      https: yesNo(cols[3]),
      cors: yesNo(cols[4]),
      category,
      url
    });
  }
  // The README repeats names (Cat Facts twice, Dogs twice). Two different services
  // are allowed to share a name; the id disambiguates by host, so a lookup never
  // silently picks one.
  const seen = new Map();
  for (const r of rows) {
    const host = (() => { try { return new URL(r.url).host.replace(/^www\./, ''); } catch { return 'invalid'; } })();
    const base = `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}@${host}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    r.id = n === 1 ? base : `${base}#${n}`;
    r.host = host;
  }
  // Promotion sections (the `### APIs Covered Under APILayer Suite!` block and the
  // `## MCP Servers` block) use the same table shape, so they parse as "categories"
  // unless the run is ended. Everything before `## Index` is promotion, never data —
  // and a customer list sold as a category is exactly the kind of thing the agent
  // must not treat as a free API.
  return rows.filter((r) => !/APILayer|MCP Server/i.test(r.category || ''));
}

const refresh = process.argv.includes('--refresh');
let text; let commit = null;

if (!refresh && fs.existsSync(CACHE)) {
  text = fs.readFileSync(CACHE, 'utf8');
  try { commit = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'public-apis-meta.json'), 'utf8')).commit; } catch { /* unknown */ }
  console.log(`→ using the pinned copy (${(text.length / 1024).toFixed(0)} KB, commit ${commit ? commit.slice(0, 8) : 'unknown'})`);
} else {
  console.log('→ fetching the README from api.github.com…');
  ({ text, commit } = await fetchReadme());
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, text);
  fs.writeFileSync(path.join(ROOT, 'vendor', 'public-apis-meta.json'), JSON.stringify({ ...SOURCE, commit, fetched_at: new Date().toISOString() }, null, 2) + '\n');
}

const entries = parse(text);
if (entries.length < 1000) {
  console.error(`✗ only ${entries.length} entries parsed — the README layout changed. Refusing to write a catalogue this small.`);
  process.exit(1);
}

const byCategory = {};
const byAuth = {};
for (const e of entries) {
  byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  byAuth[e.auth] = (byAuth[e.auth] || 0) + 1;
}

const catalogue = {
  generated_at: new Date().toISOString(),
  source: { ...SOURCE, commit, notes: 'Rows are transcribed from the upstream README table. No URL is invented and no endpoint is called at build time.' },
  count: entries.length,
  categories: Object.keys(byCategory).length,
  by_category: byCategory,
  by_auth: byAuth,
  tls: {
    https: entries.filter((e) => e.https === true).length,
    plain_http: entries.filter((e) => e.https === false).length,
    unknown: entries.filter((e) => e.https === null).length
  },
  cors: {
    allows_browser: entries.filter((e) => e.cors === true).length,
    no_cors: entries.filter((e) => e.cors === false).length,
    unknown: entries.filter((e) => e.cors === null).length
  },
  no_auth: entries.filter((e) => e.auth === 'none').length,
  entries
};

fs.writeFileSync(OUT_LIB, JSON.stringify(catalogue));
fs.mkdirSync(path.dirname(OUT_WEB), { recursive: true });
// The browser copy is the same data; it is written minified because it is shipped.
fs.writeFileSync(OUT_WEB, JSON.stringify(catalogue));
fs.writeFileSync(path.join(ROOT, 'vendor', 'public-apis-meta.json'), JSON.stringify({
  ...SOURCE, commit,
  generated_at: catalogue.generated_at,
  count: catalogue.count
}, null, 2) + '\n');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`✓ ${entries.length} APIs in ${catalogue.categories} categories`);
console.log(`  auth: ${Object.entries(byAuth).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  https: ${catalogue.tls.https} yes / ${catalogue.tls.plain_http} no / ${catalogue.tls.unknown} unknown`);
console.log(`  cors:  ${catalogue.cors.allows_browser} yes / ${catalogue.cors.no_cors} no`);
console.log(`  → ${path.relative(ROOT, OUT_LIB)} (${kb(fs.statSync(OUT_LIB).size)}), ${path.relative(ROOT, OUT_WEB)} (${kb(fs.statSync(OUT_WEB).size)})`);
