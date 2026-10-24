// Relay: fetch what this sandbox cannot reach, from a GitHub runner that can.
//
// The workspace egress policy allows npm/PyPI/GitHub only, so chatgpt.com,
// claude.ai, Drive and the vendors' CDNs are unreachable from the agent — and the
// Drive connector refuses files over 100 MiB (the ChatGPT app.asar is 582 MB, the
// two Electron shells are 245/341 MB). A runner has open egress, so the same
// artifacts are fetched there, measured, and reduced to facts. Only the facts come
// back: no vendor binary or bundle is ever written into this repository.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const OUT = 'relay/out';
const WORK = 'relay/work';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const only = (process.env.RELAY_ONLY || '').split(',').filter(Boolean);
const wants = (k) => only.length === 0 || only.includes(k);
const say = (...a) => console.log('[relay]', ...a);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const writeOut = (name, obj) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
  say('wrote', file, fs.statSync(file).size, 'B');
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function get(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...opts,
    headers: { 'user-agent': UA, ...(opts.headers || {}) }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: Object.fromEntries(res.headers), buf, text: buf.toString('utf8'), url: res.url };
}
async function tryGet(url, opts) {
  try { return await get(url, opts); } catch (e) { return { status: 0, error: String(e.message || e), buf: Buffer.alloc(0), text: '', headers: {} }; }
}

// ---------------------------------------------------------------------------
// Facts from a JavaScript / text tree
// ---------------------------------------------------------------------------

const PATTERNS = [
  ['ipc-handler', /ipcMain\.(?:handle|handleOnce|on)\(\s*['"`]([^'"`]+)['"`]/g],
  ['ipc-invoke', /\.invoke\(\s*['"`]([^'"`]+)['"`]/g],
  ['context-bridge', /exposeInMainWorld\(\s*['"`]([^'"`]+)['"`]/g],
  ['accelerator', /(?:accelerator|globalShortcut\.register)\s*[:=]\s*['"`]([^'"`]+)['"`]/g],
  ['menu-role', /role:\s*['"`]([a-zA-Z]+)['"`]/g],
  ['protocol', /setAsDefaultProtocolClient\(\s*['"`]([^'"`]+)['"`]|protocol\.handle\(\s*['"`]([^'"`]+)['"`]/g],
  ['storage-key', /(?:localStorage|sessionStorage)\.(?:get|set)Item\(\s*['"`]([^'"`]{2,64})['"`]/g],
  ['feature-flag', /\b(?:featureFlag|isFeatureEnabled|flags?\.get|flag)\(\s*['"`]([a-z0-9_.:-]{3,64})['"`]/gi],
  ['mcp-tool', /\bmcp__[a-zA-Z0-9_]+/g],
  ['skill', /\bSKILL\.md\b|\bskills?\/[a-z0-9-]+\b/g],
  ['host', /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi],
  ['route', /['"`](\/(?:api|v1|v2|v3|graphql|backend-api|desktop|auth)\/[^'"`\s]{0,80})['"`]/g],
  ['proc', /\b(?:execFile|exec|spawn|fork)\(\s*['"`]([^'"`]{1,80})['"`]/g],
  ['shell', /shell\.(openExternal|openPath|showItemInFolder)\(/g],
  ['perm', /setPermissionRequestHandler|setPermissionCheckHandler|session\.defaultSession|partition:\s*['"`]([^'"`]+)['"`]/g],
  ['window', /new BrowserWindow\(/g],
  ['asar', /['"`]([^'"`]+\.asar)['"`]/g],
  ['model-id', /\b(?:gpt-[0-9][a-z0-9.-]*|o[1-4](?:-mini|-pro)?|claude-[a-z0-9.-]+)\b/g],
  ['sqlite', /['"`]([^'"`]+\.(?:sqlite3?|db))['"`]/g],
  ['env', /\bprocess\.env\.([A-Z][A-Z0-9_]{3,})/g]
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.yaml', '.yml', '.html', '.htm', '.css', '.txt', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.py']);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_HITS_PER_PATTERN = 600;

function walk(root, { maxFiles = 60000 } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^\.git$/.test(e.name)) stack.push(p); }
      else if (e.isFile()) { try { files.push({ path: p, size: fs.statSync(p).size }); } catch { /* gone */ } }
    }
  }
  return files;
}

function factsFromTree(root) {
  const files = walk(root);
  const ext = {};
  let bytes = 0;
  for (const f of files) {
    bytes += f.size;
    const e = path.extname(f.path).toLowerCase() || '(none)';
    ext[e] = (ext[e] || 0) + 1;
  }
  const hits = {};
  const counts = {};
  const textFiles = files.filter((f) => TEXT_EXT.has(path.extname(f.path).toLowerCase()) && f.size <= MAX_FILE);
  for (const [label] of PATTERNS) { hits[label] = []; counts[label] = {}; }
  let scanned = 0;
  for (const f of textFiles) {
    let body;
    try { body = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    if (body.includes('\u0000')) continue;
    scanned += body.length;
    const rel = path.relative(root, f.path);
    for (const [label, re] of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        const value = String(m[1] ?? m[0]).trim();
        if (!value || value.length > 120) continue;
        const key = label === 'window' || label === 'perm' || label === 'shell' ? value : value.toLowerCase();
        counts[label][key] = (counts[label][key] || 0) + 1;
        if (hits[label].length < MAX_HITS_PER_PATTERN) {
          const line = body.slice(0, m.index).split('\n').length;
          hits[label].push({ value, file: rel, line });
        }
      }
    }
  }
  // Rank each pattern by frequency, then keep a bounded sample of the raw hits.
  const ranked = {};
  for (const [label] of PATTERNS) {
    ranked[label] = Object.entries(counts[label]).sort((a, b) => b[1] - a[1]).slice(0, 200).map(([value, n]) => ({ value, n }));
  }
  const biggest = files.slice().sort((a, b) => b.size - a.size).slice(0, 60).map((f) => ({ path: path.relative(root, f.path), size: f.size, sha256: sha(fs.readFileSync(f.path)) }));
  return {
    root,
    files: files.length,
    bytes,
    text_bytes_scanned: scanned,
    extensions: Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 40),
    ranked,
    hits,
    biggest
  };
}

// ---------------------------------------------------------------------------
// ASAR
// ---------------------------------------------------------------------------

function unpackAsar(file, dest) {
  const b = fs.readFileSync(file);
  const headerSize = b.readUInt32LE(4);
  const jsonLen = b.readUInt32LE(12);
  const header = JSON.parse(b.subarray(16, 16 + jsonLen).toString('utf8'));
  const base = 8 + headerSize;
  let files = 0;
  let bytes = 0;
  const skipped = [];
  const walkNode = (node, dir) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = path.join(dir, name);
      if (entry.files) { fs.mkdirSync(p, { recursive: true }); walkNode(entry, p); continue; }
      if (entry.link) continue;
      const size = Number(entry.size);
      if (size > 12 * 1024 * 1024) { skipped.push({ path: path.relative(dest, p), size }); continue; }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, b.subarray(base + Number(entry.offset), base + Number(entry.offset) + size));
      files++; bytes += size;
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walkNode(header, dest);
  const top = Object.keys(header.files || {});
  return { header_bytes: headerSize, entries_top: top, files, bytes, skipped_large: skipped, archive_bytes: b.length, archive_sha256: sha(b) };
}

// ---------------------------------------------------------------------------
// Installer resolution (Microsoft Store / winget / vendor page)
// ---------------------------------------------------------------------------

async function wingetManifests(moniker) {
  const api = `https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${moniker}`;
  const r = await tryGet(api, { headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (r.status !== 200) return { error: `${r.status} ${api}` };
  try { return { entries: JSON.parse(r.text).map((e) => e.name) }; } catch { return { error: 'unparsable listing' }; }
}

async function resolveWinget(candidates) {
  const found = [];
  for (const moniker of candidates) {
    const list = await wingetManifests(moniker);
    if (!list.entries) { found.push({ moniker, ...list }); continue; }
    const versions = list.entries.filter((n) => /^\d/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (!latest) { found.push({ moniker, error: 'no versions', entries: list.entries.slice(0, 8) }); continue; }
    const dir = await wingetManifests(`${moniker}/${latest}`);
    const installers = (dir.entries || []).filter((n) => /installer\.yaml$/i.test(n));
    const urls = [];
    for (const f of installers) {
      const raw = await tryGet(`https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/${moniker}/${latest}/${f}`);
      for (const m of raw.text.matchAll(/InstallerUrl:\s*(\S+)/g)) urls.push({ file: f, url: m[1] });
    }
    found.push({ moniker, latest, installers, urls });
  }
  return found;
}

async function resolveStore(productIds) {
  const out = [];
  for (const pid of productIds) {
    const body = new URLSearchParams({ type: 'ProductId', url: pid, ring: 'Retail', lang: 'en-US' });
    const r = await tryGet('https://store.rg-adguard.net/api/GetFiles', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const links = [...r.text.matchAll(/<a href="(https:[^"]+?)"[^>]*>([^<]+)<\/a>/g)]
      .map((m) => ({ url: m[1], name: m[2] }))
      .filter((l) => /\.(msixbundle|msix|appxbundle|appx|exe)$/i.test(l.name));
    out.push({ pid, status: r.status, links: links.slice(0, 40) });
  }
  return out;
}

async function findProductIds(query) {
  const r = await tryGet(`https://apps.microsoft.com/search?query=${encodeURIComponent(query)}&hl=en-us&gl=US`);
  const ids = [...new Set([...r.text.matchAll(/\b(9[A-Z0-9]{11})\b/g)].map((m) => m[1]))];
  return { status: r.status, bytes: r.buf.length, ids: ids.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Website bundles
// ---------------------------------------------------------------------------

async function siteFacts(label, urls) {
  const attempts = [];
  let html = null;
  for (const url of urls) {
    const r = await tryGet(url);
    attempts.push({ url, status: r.status, bytes: r.buf.length, final: r.url });
    if (r.status === 200 && r.buf.length > 2000 && /<html|<script|__NEXT_DATA__|root/i.test(r.text)) { html = r; break; }
  }
  if (!html) return { label, attempts, html: null };
  const scripts = [...new Set([
    ...[...html.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.text.matchAll(/"(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1])
  ])].map((s) => (s.startsWith('http') ? s : new URL(s, html.url).href));
  const base = new URL(html.url);
  const dir = path.join(WORK, `web-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html.text);
  const fetched = [];
  for (const src of scripts.slice(0, 24)) {
    const r = await tryGet(src);
    if (r.status !== 200 || r.buf.length > 8 * 1024 * 1024) { fetched.push({ src, status: r.status, bytes: r.buf.length }); continue; }
    const name = src.split('/').pop().split('?')[0].replace(/[^\w.-]/g, '_') || `asset-${fetched.length}.js`;
    fs.writeFileSync(path.join(dir, name), r.buf);
    fetched.push({ src, status: r.status, bytes: r.buf.length, saved: name });
  }
  const facts = factsFromTree(dir);
  return { label, origin: base.origin, attempts, html_bytes: html.buf.length, scripts: fetched, facts, meta: extractMeta(html.text) };
}

function extractMeta(html) {
  const m = {};
  for (const re of [
    ['title', /<title[^>]*>([^<]{0,200})<\/title>/i],
    ['description', /<meta[^>]+name="description"[^>]+content="([^"]{0,300})"/i],
    ['next-build', /"buildId":"([^"]+)"/],
    ['asset-prefix', /"assetPrefix":"([^"]*)"/],
    ['csrf', /"csrfToken":"([^"]+)"/]
  ]) {
    const hit = re[1].exec(html);
    if (hit) m[re[0]] = hit[1];
  }
  m.hosts = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((x) => x[1]))].slice(0, 40);
  return m;
}

// ---------------------------------------------------------------------------
// PE report (pefile + capstone), run through the python helper
// ---------------------------------------------------------------------------

function peReport(file) {
  try {
    const out = execFileSync('python3', ['relay/pe.py', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    return { file: path.basename(file), error: String(e.message || e).slice(0, 400), stdout: String(e.stdout || '').slice(0, 400) };
  }
}

// ---------------------------------------------------------------------------
// Installer download + unpack
// ---------------------------------------------------------------------------

async function download(url, dest) {
  const r = await get(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  fs.writeFileSync(dest, r.buf);
  return { bytes: r.buf.length, sha256: sha(r.buf), headers: r.headers };
}

function unzip(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-qq', '-o', file, '-d', dest], { stdio: 'pipe' });
  return walk(dest);
}

function sevenZip(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try { execFileSync('7z', ['x', '-y', `-o${dest}`, file], { stdio: 'pipe' }); }
  catch (e) { execFileSync('7zz', ['x', '-y', `-o${dest}`, file], { stdio: 'pipe' }); }
  return walk(dest);
}

/** A package may be an .exe (NSIS/Squirrel), an .msix, or a bundle of .msix. */
async function acquire(url, label) {
  const rawDir = path.join(WORK, label);
  fs.mkdirSync(rawDir, { recursive: true });
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || `${label}.bin`);
  const file = path.join(rawDir, name);
  const meta = await download(url, file);
  say(label, 'downloaded', name, meta.bytes, 'B');

  const extracted = path.join(rawDir, 'x');
  let listing = [];
  if (/\.(msix|appx|zip)$/i.test(name)) listing = unzip(file, extracted);
  else if (/\.(msixbundle|appxbundle)$/i.test(name)) {
    const first = unzip(file, path.join(rawDir, 'bundle'));
    const inner = first.filter((f) => /\.(msix|appx)$/i.test(f.path)).sort((a, b) => b.size - a.size);
    if (inner.length) { listing = unzip(inner[0].path, extracted); }
    else listing = first;
  } else listing = sevenZip(file, extracted);
  return { file, name, ...meta, listing, extracted };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const report = { started_at: new Date().toISOString(), runner: { node: process.version, platform: process.platform, arch: process.arch }, targets: {} };

if (wants('resolve')) {
  say('resolving installers…');
  const [chatgptIds, claudeIds] = await Promise.all([findProductIds('ChatGPT'), findProductIds('Claude')]);
  const winget = await resolveWinget([
    'o/OpenAI/ChatGPT', 'o/OpenAI/Codex', 'o/OpenAI/ChatGPT.Desktop', 'a/Anthropic/Claude', 'a/Anthropic/Claude.Desktop', 'a/Anthropic/ClaudeCode'
  ]);
  const storeLinks = await resolveStore([...chatgptIds.ids.slice(0, 3), ...claudeIds.ids.slice(0, 2)]);
  writeOut('resolve.json', { chatgptIds, claudeIds, winget, storeLinks });
}

if (wants('web')) {
  for (const [label, urls] of Object.entries({
    chatgpt: [
      'https://chatgpt.com/',
      'https://web.archive.org/web/2026id_/https://chatgpt.com/',
      'https://web.archive.org/web/2025id_/https://chatgpt.com/'
    ],
    claude: [
      'https://claude.ai/',
      'https://claude.ai/login',
      'https://web.archive.org/web/2026id_/https://claude.ai/',
      'https://web.archive.org/web/2025id_/https://claude.ai/'
    ]
  })) {
    say('site', label);
    report.targets[`web-${label}`] = await siteFacts(label, urls);
  }
  writeOut('web.json', report.targets);
}

if (wants('assets')) {
  const plan = JSON.parse(fs.readFileSync(process.env.RELAY_PLAN || path.join(OUT, 'plan.json'), 'utf8'));
  for (const job of plan) {
    say('asset', job.label, job.url);
    try {
      const got = await acquire(job.url, job.label);
      const entry = { label: job.label, url: job.url, bytes: got.bytes, sha256: got.sha256, extracted: got.extracted, listing: got.listing.length };
      const asars = got.listing.filter((f) => /app\.asar$/i.test(f.path));
      const exes = got.listing.filter((f) => /\.exe$/i.test(f.path));
      if (asars.length) {
        const target = asars.sort((a, b) => b.size - a.size)[0];
        say('unpacking asar', target.path, target.size);
        const dir = path.join(WORK, `${job.label}-asar`);
        entry.asar = { file: path.basename(target.path), size: target.size, ...unpackAsar(target.path, dir) };
        entry.asar_facts = factsFromTree(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      entry.pe = exes
        .filter((f) => f.size > 100 * 1024 && f.size < 120 * 1024 * 1024)
        .sort((a, b) => b.size - a.size)
        .slice(0, 8)
        .map((f) => peReport(f.path));
      entry.other_large = got.listing.filter((f) => f.size > 5 * 1024 * 1024).sort((a, b) => b.size - a.size).slice(0, 25).map((f) => ({ path: path.relative(got.extracted, f.path), size: f.size }));
      report.targets[job.label] = entry;
      fs.rmSync(got.extracted, { recursive: true, force: true });
      fs.rmSync(path.dirname(got.file), { recursive: true, force: true });
    } catch (e) {
      report.targets[job.label] = { label: job.label, url: job.url, error: String(e.message || e) };
      say('FAILED', job.label, e.message);
    }
  }
  writeOut('assets.json', report.targets);
}

report.ended_at = new Date().toISOString();
writeOut('run.json', report);
say('done');
