// ANTICODEX Skills engine — make the atlas something a model can *use*, not just browse.
//
// The difference between "a folder of markdown" and "a skill" is the resolution
// step: an agent has to be able to ask for one by something other than an exact
// slug, get the right one, read only what matters, and have that text reach the
// prompt with attribution. That is what this module does.
//
// Three capabilities, all server-side and testable:
//
//   resolve(text)    — hybrid retrieval. Lexical (BM25 over name/description/
//                      tags/body-with-the-query-words), fuzzy substring, tag and
//                      tier boosts, then a deterministic tie-break. 2,000+ skills
//                      retrieved in a few ms without an embedding endpoint, and
//                      it works offline in the desktop build.
//   ground(prompt)   — the block of instructions injected into a chat turn, with
//                      hard budgets so a wiki-sized skill cannot blow the context
//                      window: per-skill slice, total budget, "read the rest with
//                      skill_get" pointer.
//   scan(code, lang) — a real static security scan (rules, not vibes) used by the
//                      SkillUI/VibeSec surfaces and by the sandbox after a run.
//
// The atlas ships as `web/public/skills-atlas/index.json` (metadata) plus
// `bodies/<shard>.json` (bodies). This module reads those, so the website, the
// desktop app and the phone all resolve the exact same corpus.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ATLAS_DIR = path.join(REPO_ROOT, 'web', 'public', 'skills-atlas');
const INDEX_FILE = path.join(ATLAS_DIR, 'index.json');

export const ATLAS_DEFAULTS = Object.freeze({
  per_skill_chars: 6000,
  total_chars: 24000,
  max_skills: 4,
  body_preview: 1600
});

let CACHE = null;

/** Load (and memoise) the atlas. Missing atlas = empty corpus, not a crash: a
 *  build that ships before `build-skill-atlas` still serves every other page. */
export function loadAtlas({ force = false } = {}) {
  if (CACHE && !force) return CACHE;
  let index = { count: 0, skills: [], sources: [], tags: [], tiers: {} };
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch { /* no atlas in this build */ }
  const skills = Array.isArray(index.skills) ? index.skills : [];
  const docs = skills.map((s, i) => {
    const text = `${s.slug} ${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
    return { ...s, _i: i, _lower: text, _tokens: tokenize(text) };
  });
  CACHE = {
    available: skills.length > 0,
    generated_at: index.generated_at || null,
    count: skills.length,
    tiers: index.tiers || {},
    tags: index.tags || [],
    sources: index.sources || [],
    shards: index.shards || [],
    bytes: index.bytes || null,
    skills: docs,
    bySlug: new Map(docs.map((d) => [d.slug, d]))
  };
  return CACHE;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

const STOP = new Set(('a an the and or of for to in on with without your you my me it this that these those '
  + 'is are be been being do does did how what when where which who why can could should would will shall may '
  + 'use using used make made build building write writing create creating get got set let not no yes if then '
  + 'than so as at by from into over under about across per via i we they he she them our their its').split(' '));

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#._-]+/)
    .flatMap((t) => {
      if (!t) return [];
      // keep `c++`, `c#`, `.net`, `react.js`; split snake/kebab into parts too
      const parts = t.split(/[-_.]/).filter(Boolean);
      return [t, ...parts];
    })
    .filter((t) => t.length > 1 && !STOP.has(t))
    .slice(0, 80);
}

function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of new Set(d._tokens)) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, docs.length);
  return { df, N, idf: (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5)) };
}

let IDF = null;

/** BM25 over the metadata field, with exact-name and substring boosts. */
function scoreDoc(d, qTokens, qRaw, idf, avgLen) {
  const k1 = 1.4;
  const b = 0.72;
  const tf = new Map();
  for (const t of d._tokens) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  for (const q of qTokens) {
    const f = tf.get(q) || 0;
    if (!f) continue;
    score += idf.idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d._tokens.length / avgLen))));
  }
  const slug = d.slug.toLowerCase();
  const name = (d.name || '').toLowerCase();
  const q = qRaw.toLowerCase().trim();
  if (q) {
    if (slug === q || name === q) score += 14;
    else if (slug.startsWith(q) || name.startsWith(q)) score += 6;
    else if (slug.includes(q) || name.includes(q)) score += 3.2;
    if ((d.description || '').toLowerCase().includes(q)) score += 1.6;
  }
  for (const t of qTokens) {
    if ((d.tags || []).includes(t)) score += 2.4;
    if (slug.split('-').includes(t)) score += 1.5;
  }
  // tiers: bundled skills ship with the app and are the ones we stand behind
  if (d.tier === 'bundled') score += 2.2;
  else if (d.tier === 'curated') score += 0.9;
  // a safety-flagged skill never wins a tie-break silently
  if ((d.flags || []).length) score -= 0.6;
  return score;
}

/**
 * Find the skills a request is asking for.
 *
 * Returns `{ ok, query, matched:[{...meta, score, why}] }`. An empty query with no
 * explicit slugs returns nothing rather than the whole corpus — injection is a
 * decision the caller makes, never a default.
 */
export function resolveSkills(query, opts = {}) {
  let atlas = loadAtlas();
  if (opts.include_local) {
    // Your installed skills join the corpus for this query. They are marked
    // `tier: local` and outrank nothing by default — they are yours, not curated.
    try {
      const local = localCorpus();
      if (local.length) {
        const docs = local.map((s, i) => {
          const text = `${s.slug} ${s.description}`.toLowerCase();
          return { ...s, _i: atlas.skills.length + i, _lower: text, _tokens: tokenize(text) };
        });
        atlas = { ...atlas, skills: [...atlas.skills, ...docs], bySlug: new Map([...atlas.bySlug, ...docs.map((d) => [d.slug, d])]), count: atlas.count + docs.length };
      }
    } catch { /* a broken local root must not break retrieval */ }
  }
  const qRaw = String(query || '').trim().slice(0, 4000);
  const limit = Math.min(Math.max(Number(opts.limit) || 3, 1), 12);
  const explicit = Array.isArray(opts.slugs) ? opts.slugs.filter((s) => typeof s === 'string') : [];
  const tiers = Array.isArray(opts.tiers) && opts.tiers.length ? new Set(opts.tiers) : null;

  const chosen = new Map();
  for (const slug of explicit) {
    const d = atlas.bySlug.get(String(slug).toLowerCase());
    if (d && (!tiers || tiers.has(d.tier))) chosen.set(d.slug, { ...meta(d), score: 100, why: 'explicit' });
  }

  if (qRaw) {
    const qTokens = [...new Set(tokenize(qRaw))].slice(0, 24);
    if (!IDF) IDF = buildIdf(atlas.skills);
    const avgLen = atlas.skills.reduce((n, d) => n + d._tokens.length, 0) / Math.max(1, atlas.skills.length) || 1;
    const scored = [];
    for (const d of atlas.skills) {
      if (tiers && !tiers.has(d.tier)) continue;
      const score = scoreDoc(d, qTokens, qRaw, IDF, avgLen);
      if (score > 0.4) scored.push({ d, score });
    }
    scored.sort((a, b) => b.score - a.score || a.d.slug.localeCompare(b.d.slug));
    // An explicit pick always outranks a lexical guess.
    for (const { d, score } of scored) {
      if (chosen.size >= limit) break;
      if (chosen.has(d.slug)) continue;
      chosen.set(d.slug, { ...meta(d), score: Math.round(score * 100) / 100, why: whyFor(d, qTokens) });
    }
  }

  return {
    ok: true,
    atlas: { available: atlas.available, count: atlas.count, generated_at: atlas.generated_at },
    query: qRaw,
    matched: [...chosen.values()].slice(0, limit)
  };
}

function whyFor(d, qTokens) {
  const hits = qTokens.filter((t) => d._lower.includes(t)).slice(0, 4);
  if (!hits.length) return 'body match';
  return `matched ${hits.join(', ')}`;
}

function meta(d) {
  return {
    slug: d.slug,
    name: d.name,
    display: d.display,
    description: d.description,
    tier: d.tier,
    tags: d.tags || [],
    source: d.source,
    bytes: d.bytes,
    truncated: Boolean(d.truncated),
    resource_count: d.resource_count ?? (d.resources || []).length,
    flags: d.flags || [],
    shard: d.shard
  };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const bodyCache = new Map();

/** The full `SKILL.md` text for one skill, from its shard. */
export function skillBody(slug) {
  const atlas = loadAtlas();
  let d = atlas.bySlug.get(String(slug || '').toLowerCase());
  if (!d) {
    // Not in the pinned atlas — it may be a skill installed on this machine
    // (Qoder's own, or one the user wrote). Read it directly.
    try {
      const local = installedSkills().installed.find((s) => s.name === String(slug || '').toLowerCase());
      if (local) {
        const body = fs.readFileSync(local.path, 'utf8');
        return {
          slug: local.name, name: local.name, display: local.name.replace(/-/g, ' '),
          description: local.description, tier: 'local', tags: [], bytes: local.bytes,
          truncated: false, resource_count: 0, flags: [], body, files: [],
          source: { id: local.root, label: `${local.root} (installed)`, repo: null, path: local.path, url: null, commit: null, license: 'local' }
        };
      }
    } catch { /* fall through */ }
    return null;
  }
  const shard = d.shard || (/^[a-z]/.test(d.slug) ? d.slug[0] : '_');
  if (!bodyCache.has(shard)) {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(path.join(ATLAS_DIR, 'bodies', `${shard}.json`), 'utf8')); } catch { map = {}; }
    bodyCache.set(shard, map);
  }
  const body = bodyCache.get(shard)[d.slug] || '';
  return { ...meta(d), body, files: d.resources || [] };
}

// ---------------------------------------------------------------------------
// Grounding — turning skills into prompt text
// ---------------------------------------------------------------------------

/**
 * Compose the system block for a turn.
 *
 * Budgets, in order of who gets cut first: skills beyond `max_skills`, then each
 * skill's body beyond `per_skill_chars`, then the whole block beyond
 * `total_chars`. Cut text is replaced by an explicit marker with the instructions
 * to fetch the remainder (`op: "skill_get"`), so the model knows it is looking at
 * an excerpt — silently truncating instructions is how an agent ends up
 * confidently wrong.
 */
export function groundSkills(query, opts = {}) {
  const per = Math.min(Math.max(Number(opts.per_skill_chars) || ATLAS_DEFAULTS.per_skill_chars, 800), 40000);
  const total = Math.min(Math.max(Number(opts.total_chars) || ATLAS_DEFAULTS.total_chars, 2000), 120000);
  const max = Math.min(Math.max(Number(opts.max_skills) || ATLAS_DEFAULTS.max_skills, 1), 8);
  const found = resolveSkills(query, { limit: max, slugs: opts.slugs || (opts.slug ? [opts.slug] : undefined), tiers: opts.tiers, include_local: opts.include_local });

  const parts = [];
  let used = 0;
  const injected = [];
  const omitted = [];

  for (const m of found.matched) {
    const one = skillBody(m.slug);
    if (!one) continue;
    let body = one.body.trim();
    if (body.length > per) body = body.slice(0, per).trimEnd() + `\n\n[… excerpt: ${one.body.length - per} more characters. Read them with op:"skill_get", slug:"${one.slug}".]`;
    const header = `### Skill: ${one.slug} (${one.tier})\n${one.description}\nSource: ${one.source?.url || one.source?.label || 'ANTICODEX'}`;
    const block = `${header}\n\n${body}`;
    if (used + block.length > total) { omitted.push(one.slug); continue; }
    parts.push(block);
    used += block.length;
    injected.push({ slug: one.slug, tier: one.tier, chars: used, why: m.why, flags: one.flags || [] });
  }

  if (!parts.length) return { ok: true, text: '', injected: [], omitted, query: found.query, atlas: found.atlas };

  const flagged = injected.filter((s) => s.flags.length).map((s) => s.slug);
  const text = [
    '## Skills for this turn',
    '',
    `The user's workspace carries ${found.atlas.count.toLocaleString()} installed skills. The following were selected for this request and are instructions you should be able to carry out.`,
    '',
    ...parts,
    '',
    'Follow these skills where they apply. Where a skill names a file or script that is not quoted above, say which one you need instead of inventing its contents.',
    flagged.length ? `Skills flagged by the safety scan (review before executing anything they propose): ${flagged.join(', ')}.` : '',
    omitted.length ? `Not included for budget reasons: ${omitted.join(', ')} — available via op:"skill_get".` : ''
  ].filter(Boolean).join('\n');

  return { ok: true, text, injected, omitted, query: found.query, atlas: found.atlas, chars: text.length };
}

// ---------------------------------------------------------------------------
// Scanning — rules, not vibes
// ---------------------------------------------------------------------------

const RULES = [
  // id, severity, pattern, message, languages
  ['sql-injection', 'critical', /(?:query|execute|exec|raw)\s*\(\s*[`"'][^`"']{0,200}?\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,200}?(?:\$\{|\+\s*(?:req|request|params|body|query|input|args))/i, 'SQL built by string interpolation with request data — use a parameterised query.', ['js', 'ts', 'py']],
  ['cmd-injection', 'critical', /\b(?:exec|execSync|spawnSync|system|popen)\s*\(\s*(?:`[^`]*\$\{|[^,)]*\+\s*(?:req|request|params|body|query|input|argv))/i, 'Shell command built from request data — pass an argument list, never a string.', ['js', 'ts', 'py']],
  ['eval', 'high', /(?:^|[^.\w])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.runInNewContext\b/, 'Dynamic code evaluation — an attacker who reaches this string runs code.', ['js', 'ts']],
  ['xss-innerhtml', 'high', /\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/, 'HTML sink — sanitise or render as text.', ['js', 'ts', 'jsx', 'tsx']],
  ['hardcoded-secret', 'high', /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-/+.]{16,}['"]/i, 'A credential literal is in the source. Move it to the environment.', ['js', 'ts', 'py', 'sh']],
  ['aws-key', 'critical', /\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id in source.', ['*']],
  ['openai-key', 'critical', /\bsk-[A-Za-z0-9]{32,}\b/, 'Provider API key in source.', ['*']],
  ['private-key', 'critical', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'Private key material in source.', ['*']],
  ['jwt-none', 'high', /alg\s*[:=]\s*['"]none['"]/i, 'JWT "none" algorithm accepted — tokens can be forged.', ['js', 'ts', 'py']],
  ['weak-hash', 'medium', /\b(?:md5|sha1)\s*\(/i, 'MD5/SHA-1 for security purposes — use SHA-256 or better (or argon2/bcrypt for passwords).', ['js', 'ts', 'py']],
  ['insecure-random', 'medium', /Math\.random\(\)\s*(?:\.toString\(36\)|\*\s*\d)/, 'Math.random for a token/id — use crypto.randomUUID / secrets.', ['js', 'ts']],
  ['cors-wildcard', 'medium', /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/, 'Wildcard CORS with credentials is not a boundary.', ['js', 'ts']],
  ['no-tls-verify', 'high', /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/i, 'TLS verification disabled.', ['js', 'ts', 'py']],
  ['path-traversal', 'high', /(?:readFile|readFileSync|createReadStream|open)\s*\(\s*(?:path\.)?join\([^)]*(?:req|params|body|query)/, 'A file path is built from request data — resolve and contain it.', ['js', 'ts', 'py']],
  ['proto-pollution', 'high', /(?:Object\.assign|merge|extend)\s*\(\s*(?:target|obj|config|\{\})\s*,\s*(?:req|body|params)/, 'Merging request data into an object can set __proto__ — allowlist keys.', ['js', 'ts']],
  ['debug-on', 'low', /\bDEBUG\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True/, 'Debug mode enabled — the Werkzeug console is remote code execution.', ['py']],
  ['except-pass', 'low', /except\s+Exception\s*:\s*\n\s*pass/, 'A bare except swallowing everything hides failures you need to see.', ['py']],
  ['http-url', 'low', /['"]http:\/\/[a-z0-9.-]+/i, 'Plaintext http URL.', ['*']],
  ['todo-security', 'info', /(?:TODO|FIXME|XXX)[^\n]{0,60}(?:auth|security|validate|sanitiz)/i, 'A security TODO is still open.', ['*']]
];

const LANG_EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', py: 'py', sh: 'sh', bash: 'sh', rb: 'rb', go: 'go', rs: 'rs', html: 'html', php: 'php' };

export function languageOf(name, code) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (LANG_EXT[ext]) return LANG_EXT[ext];
  const src = String(code || '');
  if (/^\s*(?:def |import |from \w+ import|class \w+:)/m.test(src)) return 'py';
  if (/^\s*#!.*\b(?:bash|sh)\b/.test(src)) return 'sh';
  return 'js';
}

/**
 * Scan code. Deterministic, offline, and honest about what it is: pattern rules
 * with line numbers and fixes, not a proof of safety. `vibesec` (the Python
 * scanner) is a separate, deeper engine exposed through MCP; this one runs
 * everywhere, including the browser-side preview.
 */
export function scanCode(code, { language, filename } = {}) {
  const src = String(code ?? '');
  if (!src.trim()) return { ok: true, findings: [], summary: emptySummary(), language: language || 'unknown' };
  const lang = language || languageOf(filename, src);
  const lines = src.split(/\r?\n/);
  const findings = [];
  for (const [id, severity, re, message, langs] of RULES) {
    if (!langs.includes('*') && !langs.includes(lang)) continue;
    const flags = [...re.flags.includes('g') ? re.flags : re.flags + 'g'];
    const rx = new RegExp(re.source, flags.join(''));
    let m;
    let guard = 0;
    while ((m = rx.exec(src)) && guard++ < 50) {
      const upto = src.slice(0, m.index);
      const line = upto.split(/\r?\n/).length;
      const text = lines[line - 1] || '';
      findings.push({
        id,
        severity,
        line,
        column: m.index - upto.lastIndexOf('\n'),
        excerpt: text.trim().slice(0, 160),
        message,
        fix: FIXES[id] || null
      });
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
  }
  // stable order: severity, then position
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.line - b.line || a.id.localeCompare(b.id));
  const summary = emptySummary();
  for (const f of findings) summary[f.severity]++;
  summary.total = findings.length;
  summary.verdict = summary.critical ? 'block' : summary.high ? 'review' : summary.medium ? 'review' : 'pass';
  return {
    ok: true,
    language: lang,
    lines: lines.length,
    findings: findings.slice(0, 200),
    summary,
    note: 'Pattern rules with line numbers — a fast first pass, not a proof of safety. VibeSec (MCP) runs a deeper taint analysis.'
  };
}

function emptySummary() { return { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0, verdict: 'pass' }; }

const FIXES = {
  'sql-injection': 'db.query("SELECT * FROM t WHERE id = $1", [id])',
  'cmd-injection': 'execFile("git", ["log", "-1"]) — never a composed string',
  'eval': 'Parse the data (JSON.parse) or dispatch on an allowlisted operation name.',
  'xss-innerhtml': 'element.textContent = value, or sanitise with DOMPurify first.',
  'hardcoded-secret': 'process.env.PROVIDER_KEY — and rotate the leaked value.',
  'aws-key': 'Rotate the key in IAM, then read it from the environment.',
  'openai-key': 'Rotate the key with the provider, then read it from the environment.',
  'private-key': 'Rotate the key pair; keep the private half out of the repo.',
  'jwt-none': 'Reject `alg: none` explicitly and pin the accepted algorithms.',
  'weak-hash': 'crypto.createHash("sha256"), or argon2id for passwords.',
  'insecure-random': 'crypto.randomUUID() / secrets.token_hex(32).',
  'cors-wildcard': 'Echo an allowlisted origin instead of "*".',
  'no-tls-verify': 'Remove the flag and fix the certificate chain.',
  'path-traversal': 'Resolve inside a root and refuse anything that escapes it.',
  'proto-pollution': 'Copy an allowlist of keys: {name, email} not {...body}.',
  'debug-on': 'debug=False, and serve with a real WSGI/ASGI server.',
  'except-pass': 'Log it and re-raise, or catch the specific exception.',
  'http-url': 'https:// — and set HSTS.',
  'todo-security': 'Resolve it or file it with an owner.'
};

// ---------------------------------------------------------------------------
// Catalog helpers for the UI
// ---------------------------------------------------------------------------

/** Filter/sort the atlas for the Skills page — server-side so the 2 MB index is
 *  never re-downloaded just to type in a search box. */
export function listSkills({ q = '', tag = '', tier = '', source = '', sort = 'relevance', page = 1, per = 60 } = {}) {
  const atlas = loadAtlas();
  let list = atlas.skills;
  if (tier) list = list.filter((d) => d.tier === tier);
  if (source) list = list.filter((d) => d.source?.id === source);
  if (tag) list = list.filter((d) => (d.tags || []).includes(tag));
  const query = String(q || '').trim();
  if (query) {
    if (!IDF) IDF = buildIdf(atlas.skills);
    const qTokens = [...new Set(tokenize(query))].slice(0, 16);
    const avgLen = atlas.skills.reduce((n, d) => n + d._tokens.length, 0) / Math.max(1, atlas.skills.length) || 1;
    list = list
      .map((d) => ({ d, s: scoreDoc(d, qTokens, query, IDF, avgLen) }))
      .filter((x) => x.s > 0.4)
      .sort((a, b) => b.s - a.s)
      .map(({ d, s }) => ({ ...d, score: Math.round(s * 100) / 100 }));
  } else if (sort === 'az') {
    list = [...list].sort((a, b) => a.slug.localeCompare(b.slug));
  } else if (sort === 'newest') {
    list = [...list].sort((a, b) => String(b.slug).localeCompare(String(a.slug)));
  }
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(Math.max(Number(per) || 60, 1), 200);
  const total = list.length;
  return {
    ok: true,
    total,
    page: p,
    pages: Math.max(1, Math.ceil(total / n)),
    tiers: atlas.tiers,
    tags: atlas.tags,
    sources: atlas.sources,
    available: atlas.available,
    generated_at: atlas.generated_at,
    skills: list.slice((p - 1) * n, (p - 1) * n + n).map((d) => ({ ...meta(d), score: d.score }))
  };
}

/** Counts for the dashboard tiles — one pass, no per-page fetch. */
export function skillStats() {
  const atlas = loadAtlas();
  const flagged = atlas.skills.filter((d) => (d.flags || []).length).length;
  const byTag = new Map();
  for (const d of atlas.skills) for (const t of d.tags || []) byTag.set(t, (byTag.get(t) || 0) + 1);
  return {
    available: atlas.available,
    count: atlas.count,
    tiers: atlas.tiers,
    sources: atlas.sources.length,
    flagged,
    tags: [...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
    bytes: atlas.skills.reduce((n, d) => n + (d.bytes || 0), 0),
    generated_at: atlas.generated_at
  };
}

/** Write a skill into a machine's skill root (`~/.qoder/skills`, `~/.codex/skills`,
 *  `~/.claude/skills`). The body comes from the atlas, so an install is the same
 *  text the model would have been given. */
export function exportSkill(slug, destDir, { overwrite = false } = {}) {
  const one = skillBody(slug);
  if (!one) return { ok: false, error: `No skill named "${slug}" in this atlas.` };
  const dir = path.join(destDir, one.slug);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !overwrite) return { ok: false, error: `${file} already exists — pass overwrite to replace it.`, file };
  fs.mkdirSync(dir, { recursive: true });
  const front = [
    '---',
    `name: ${one.slug}`,
    `description: ${JSON.stringify(String(one.description || '').slice(0, 1000))}`,
    '---',
    ''
  ].join('\n');
  // The atlas body already contains frontmatter; normalise it rather than nest it.
  const bodyOnly = one.body.replace(/^---[\s\S]*?\n---\n?/, '');
  fs.writeFileSync(file, front + bodyOnly);
  return { ok: true, slug: one.slug, file, bytes: fs.statSync(file).size, tier: one.tier, source: one.source };
}

// ---------------------------------------------------------------------------
// Skills on this machine
// ---------------------------------------------------------------------------

export const SKILL_ROOTS = [
  { id: 'qoder', label: 'Qoder', dir: ['.qoder', 'skills'] },
  { id: 'codex', label: 'Codex', dir: ['.codex', 'skills'] },
  { id: 'claude', label: 'Claude', dir: ['.claude', 'skills'] }
];

const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Read every skill root on this machine, and say what was refused.
 *
 * A skill is *read*, never executed, and the rules are the ones Qoder and Codex
 * enforce, so a skill that would be rejected by the runtime is reported here with
 * the reason instead of appearing to work: `name` must be lowercase letters,
 * digits and hyphens (≤ 64 chars), and `description` must exist and be ≤ 1024.
 * Duplicates across roots are listed — an earlier root wins, which is the same
 * shadowing rule the registry uses.
 */
export function installedSkills() {
  const roots = [];
  const accepted = [];
  const refused = [];
  const byName = new Map();

  for (const spec of SKILL_ROOTS) {
    const dir = path.join(os.homedir(), ...spec.dir);
    let entries = [];
    const exists = fs.existsSync(dir);
    if (exists) {
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
        refused.push({ root: spec.id, path: dir, name: null, reason: `cannot list: ${String(e.code || e.message).slice(0, 80)}` });
      }
    }
    roots.push({ id: spec.id, label: spec.label, path: dir, exists, count: 0 });

    for (const entry of entries.slice(0, 1000)) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch {
        refused.push({ root: spec.id, path: path.join(dir, entry.name), name: entry.name, reason: 'no readable SKILL.md' });
        continue;
      }
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) {
        refused.push({ root: spec.id, path: file, name: entry.name, reason: 'no YAML frontmatter — the runtime will not load it' });
        continue;
      }
      const field = (key) => {
        const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
      };
      const name = (field('name') || entry.name).toLowerCase();
      const description = field('description');
      if (!VALID_NAME.test(name)) {
        refused.push({ root: spec.id, path: file, name, reason: 'name must be lowercase letters, digits and hyphens (max 64)' });
        continue;
      }
      if (!description) {
        refused.push({ root: spec.id, path: file, name, reason: 'description is required' });
        continue;
      }
      if (description.length > 1024) {
        refused.push({ root: spec.id, path: file, name, reason: `description is ${description.length} chars (max 1024)` });
        continue;
      }
      const record = { root: spec.id, dir: entry.name, path: file, name, description: description.slice(0, 300), bytes: text.length };
      if (byName.has(name)) {
        record.shadowed_by = byName.get(name).root;
        refused.push({ root: spec.id, path: file, name, reason: `shadowed by ${byName.get(name).root} (${byName.get(name).path})` });
        continue;
      }
      byName.set(name, record);
      accepted.push(record);
      const r = roots.find((x) => x.id === spec.id);
      if (r) r.count += 1;
    }
  }

  return {
    ok: true,
    roots,
    installed: accepted,
    refused,
    duplicates: refused.filter((r) => /shadowed by/.test(r.reason)).length,
    total: accepted.length,
    // Read live, so it changes the moment something is installed — this is where
    // a skill Qoder shipped shows up for the retrieval engine.
    note: accepted.length
      ? `${accepted.length} skill${accepted.length === 1 ? '' : 's'} on this machine are resolvable alongside the pinned atlas.`
      : 'No skills installed under ~/.qoder, ~/.codex or ~/.claude yet.'
  };
}

/** Skills already installed here are also resolvable — merge them into the corpus
 *  view so "whatever the model is connected to can use them" includes yours. */
export function localCorpus() {
  const local = installedSkills();
  return local.installed.map((s) => ({
    slug: s.name,
    name: s.name,
    display: s.name.replace(/-/g, ' '),
    description: s.description,
    tier: 'local',
    tags: [],
    source: { id: s.root, label: `${s.root} (installed)`, repo: null, path: s.path, url: null, commit: null, license: 'local' },
    bytes: s.bytes,
    truncated: false,
    resource_count: 0,
    flags: [],
    path: s.path,
    local: true
  }));
}
