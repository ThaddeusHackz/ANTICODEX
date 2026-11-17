#!/usr/bin/env node
// Build the ANTICODEX skill atlas — one searchable index of every SKILL.md we
// can legally ship, from a fixed allowlist of permissively licensed sources.
//
// Why a build script and not a live feed: a skill is instructions an agent will
// follow, so the corpus has to be pinned, reviewable in the diff, and identical
// on the website, the desktop app and the phone. `sources.md` records the commit
// each skill came from; re-running this script is the only way to change it.
//
// Outputs:
//   data/skills-atlas/                 full corpus (git-ignored, build input)
//   web/public/skills-atlas/index.json  the shipped index (metadata + body text)
//
// Usage:
//   node scripts/build-skill-atlas.mjs            # harvest from ~/.cache clones
//   node scripts/build-skill-atlas.mjs --no-clone # rebuild from what is there
//   node scripts/build-skill-atlas.mjs --repo owner/name   # one ad-hoc source

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data', 'skills-atlas');
const OUT = path.join(ROOT, 'web', 'public', 'skills-atlas');
const CLONES = process.env.SKILL_CLONES || path.join(os.homedir(), '.cache', 'anticodex-skill-sources');

// The allowlist. `tier` is what the UI shows next to a skill: `bundled` ships in
// this repository, `curated` is a reviewed third-party collection, `extra` is a
// larger collection we index but mark as unreviewed prose.
export const SOURCES = [
  { id: 'anticodex', repo: null, dir: path.join(ROOT, 'skills'), license: 'Apache-2.0', tier: 'bundled', label: 'ANTICODEX / REA', homepage: 'https://github.com/morluto/rea' },
  { id: 'anthropic', repo: 'anthropics/skills', sub: 'skills', license: 'Apache-2.0', tier: 'curated', label: 'Anthropic Agent Skills' },
  { id: 'superpowers', repo: 'obra/superpowers', sub: 'skills', license: 'MIT', tier: 'curated', label: 'Superpowers' },
  { id: 'wshobson', repo: 'wshobson/agents', sub: '', license: 'MIT', tier: 'curated', label: 'wshobson/agents' },
  { id: 'composio', repo: 'ComposioHQ/awesome-claude-skills', sub: '', license: 'MIT', tier: 'extra', label: 'Awesome Claude Skills' },
  { id: 'alirezarezvani', repo: 'alirezarezvani/claude-skills', sub: '', license: 'MIT', tier: 'extra', label: 'alirezarezvani/claude-skills' },
  { id: 'davila7', repo: 'davila7/claude-code-templates', sub: '', license: 'MIT', tier: 'extra', label: 'claude-code-templates' }
];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESC = 1024;
const INDEX_DESC = 340;       // what the shipped index carries; the body has the rest
const MAX_SKILL_BYTES = 60 * 1024;        // body kept in the shipped index
const MAX_RESOURCE_BYTES = 160 * 1024;    // per side-file, kept on disk only
const MAX_RESOURCES = 40;                 // per skill
const MAX_TOTAL = 64 * 1024 * 1024;

const log = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// frontmatter — the same subset `lib/skills.js` parses, so what we index here is
// what the runtime will accept.
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return { yaml: '', body: src };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
  }
  return { yaml: '', body: src };
}

/** Enough YAML for frontmatter: `key: value`, folded/literal blocks, nesting. */
export function parseYamlLite(yaml) {
  const out = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) continue;                       // nested — handled by the parent
    const m = raw.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    const block = /^[|>][-+]?\s*$/.test(value);
    if (block || value === '') {
      const indent = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || !lines[j].trim())) { indent.push(lines[j]); j++; }
      i = j - 1;
      const folded = indent.map((l) => l.trim()).join(block ? ' ' : '\n').trim();
      value = folded || (value === '' ? '' : value);
      if (!value && /^[|>]/.test(m[2])) value = '';
      if (!value) {
        // an empty value may introduce a mapping — keep the raw children too
        out[key] = {};
        continue;
      }
    }
    if (/^["'].*["']$/s.test(value.trim())) value = value.trim().slice(1, -1);
    out[key] = value.trim();
  }
  return out;
}

/** 26 shards, by first letter of the slug — stable, cheap, no manifest needed. */
export const shardOf = (slug) => (/^[a-z]/.test(slug) ? slug[0] : '_');

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function slugify(raw, fallback = 'skill') {
  const base = oneLine(raw)
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return NAME_RE.test(base) ? base : fallback;
}

// ---------------------------------------------------------------------------
// safety scan — flags, never silently drops, and never executes anything.
// ---------------------------------------------------------------------------

const RISKY = [
  ['curl|bash', /curl[^\n|]{0,120}\|\s*(?:sudo\s+)?(?:ba)?sh/i],
  ['wget|sh', /wget[^\n|]{0,120}\|\s*(?:sudo\s+)?(?:ba)?sh/i],
  ['remote eval', /\beval\s*\(\s*(?:await\s+)?(?:fetch|atob|base64)/i],
  ['base64 blob', /[A-Za-z0-9+/]{600,}={0,2}/],
  ['reverse shell', /\bnc\s+-e\b|\/dev\/tcp\/|bash\s+-i\s+>&/i],
  ['credential read', /(?:^|\s)(?:cat|less|head)\s+[^\n]*\.(?:ssh\/id_|aws\/credentials|netrc|npmrc)/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];

export function scanText(text) {
  const flags = [];
  for (const [label, re] of RISKY) if (re.test(text)) flags.push(label);
  return flags;
}

// ---------------------------------------------------------------------------
// harvesting
// ---------------------------------------------------------------------------

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cloneIfNeeded(src, { clone = true } = {}) {
  if (src.dir) return fs.existsSync(src.dir) ? src.dir : null;
  const dest = path.join(CLONES, src.id);
  if (clone && !fs.existsSync(path.join(dest, '.git'))) {
    fs.mkdirSync(CLONES, { recursive: true });
    log(`· cloning ${src.repo} → ${dest}`);
    try {
      execFileSync('git', ['clone', '--depth', '1', '-q', `https://github.com/${src.repo}.git`, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      log(`! clone failed for ${src.repo}: ${String(e.message).slice(0, 200)}`);
      return null;
    }
  }
  return fs.existsSync(dest) ? dest : null;
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}

/** Everything in a skill directory that is small enough to be worth keeping. */
async function resourcesFor(dir, relFiles) {
  const kept = [];
  let bytes = 0;
  for (const rel of relFiles.slice(0, MAX_RESOURCES * 3)) {
    if (kept.length >= MAX_RESOURCES) break;
    const abs = path.join(dir, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_RESOURCE_BYTES) continue;
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|so|dll|exe|bin|pyc)$/i.test(rel)) { kept.push({ path: rel, bytes: st.size, skipped: 'binary' }); continue; }
    try {
      const text = await fsp.readFile(abs, 'utf8');
      if (text.includes('\u0000')) continue;
      kept.push({ path: rel, bytes: st.size, text });
      bytes += st.size;
    } catch { /* unreadable */ }
  }
  return { files: kept, bytes };
}

async function harvestSource(src, opts) {
  const root = cloneIfNeeded(src, opts);
  if (!root) return { skills: [], meta: { ...src, commit: null, found: 0 } };
  const commit = (() => { try { return git(root, ['rev-parse', 'HEAD']); } catch { return null; } })();
  const scanRoot = src.sub ? path.join(root, src.sub) : root;
  if (!fs.existsSync(scanRoot)) return { skills: [], meta: { ...src, commit, found: 0 } };

  const all = walk(scanRoot);
  const skillFiles = all.filter((p) => path.basename(p) === 'SKILL.md');
  const skills = [];

  for (const rel of skillFiles) {
    const dirRel = path.dirname(rel);
    const abs = path.join(scanRoot, rel);
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
    if (text.length > 400 * 1024) continue;
    const { yaml, body } = splitFrontmatter(text);
    const fm = parseYamlLite(yaml);
    const dirName = path.basename(dirRel) === '.' ? (src.id) : path.basename(dirRel);
    const rawName = oneLine(fm.name || dirName);
    const name = slugify(rawName, slugify(dirName, src.id));
    let description = oneLine(fm.description || fm['short-description'] || '');
    if (!description) {
      // fall back to the first real paragraph so the card is not empty
      description = oneLine(body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || '');
    }
    if (description.length > MAX_DESC) {
      let cut = description.slice(0, MAX_DESC - 1);
      const at = cut.lastIndexOf('. ');
      description = (at > 200 ? cut.slice(0, at + 1) : cut).trim();
    }
    const res = await resourcesFor(path.join(scanRoot, dirRel), all.filter((p) => p.startsWith(dirRel === '.' ? '' : dirRel + path.sep) && path.basename(p) !== 'SKILL.md').map((p) => path.relative(dirRel, p)));
    const head = text.slice(0, MAX_SKILL_BYTES);
    skills.push({
      slug: name,
      name: rawName,
      display: rawName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description,
      tier: src.tier,
      source: {
        id: src.id,
        label: src.label || src.repo,
        repo: src.repo,
        path: path.relative(root, abs).split(path.sep).join('/'),
        url: src.repo ? `https://github.com/${src.repo}/blob/${commit || 'HEAD'}/${path.relative(root, abs).split(path.sep).join('/')}` : null,
        commit,
        license: src.license
      },
      bytes: Buffer.byteLength(text),
      truncated: text.length > MAX_SKILL_BYTES,
      body: head,
      resources: res.files.map((f) => ({ path: f.path, bytes: f.bytes, ...(f.skipped ? { skipped: f.skipped } : {}) })),
      resource_bytes: res.bytes,
      flags: scanText(text),
      tags: tagsFor(name, description)
    });
  }
  return { skills, meta: { ...src, commit, found: skillFiles.length } };
}

const TAG_RULES = [
  ['frontend', /\b(react|vue|svelte|css|tailwind|html|frontend|ui|design system|component)\b/i],
  ['backend', /\b(api|server|express|fastapi|django|rails|graphql|endpoint)\b/i],
  ['data', /\b(sql|database|postgres|sqlite|pandas|etl|warehouse|analytics)\b/i],
  ['security', /\b(security|auth|owasp|xss|csrf|vulnerab|pentest|audit)\b/i],
  ['devops', /\b(docker|kubernetes|ci\/cd|deploy|terraform|aws|vercel|infrastructure)\b/i],
  ['mobile', /\b(ios|swift|android|kotlin|react native|flutter)\b/i],
  ['ai', /\b(llm|prompt|agent|model|rag|embedding|fine-tun)\b/i],
  ['docs', /\b(document|docx|pdf|pptx|xlsx|slide|spreadsheet|markdown|report)\b/i],
  ['testing', /\b(test|pytest|jest|vitest|playwright|cypress|coverage)\b/i],
  ['research', /\b(research|search|reverse|forensic|analysis|investigat)\b/i],
  ['finance', /\b(finance|invoice|budget|accounting|valuation|stock)\b/i],
  ['growth', /\b(marketing|seo|content|social|copywriting|sales|brand)\b/i]
];

function tagsFor(name, description) {
  const hay = `${name} ${description}`;
  const tags = [];
  for (const [tag, re] of TAG_RULES) if (re.test(hay)) tags.push(tag);
  return tags.slice(0, 4);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const clone = !argv.includes('--no-clone');
  const extraRepo = (() => {
    const i = argv.indexOf('--repo');
    return i >= 0 ? argv[i + 1] : null;
  })();

  const sources = [...SOURCES];
  if (extraRepo) {
    sources.push({ id: slugify(extraRepo.split('/').pop()), repo: extraRepo, sub: '', license: 'NOASSERTION', tier: 'extra', label: extraRepo });
  }

  await fsp.mkdir(DATA, { recursive: true });
  await fsp.mkdir(OUT, { recursive: true });

  const bySlug = new Map();
  const metas = [];
  const originals = new Map();    // slug -> [sources] for honest dedupe reporting
  let total = 0;

  for (const src of sources) {
    const { skills, meta } = await harvestSource(src, { clone });
    metas.push({ id: meta.id, repo: meta.repo, label: meta.label || meta.repo, license: meta.license, tier: meta.tier, commit: meta.commit, found: meta.found });
    log(`· ${src.id}: ${skills.length} skills`);
    for (const s of skills) {
      const dir = path.join(DATA, 'skills', s.slug);
      if (!bySlug.has(s.slug)) {
        originals.set(s.slug, []);
        bySlug.set(s.slug, s);
        // the full body + side files live on disk for the CLI/MCP to read
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'SKILL.md'), s.body);
        await fsp.writeFile(path.join(dir, 'skill.json'), JSON.stringify({ ...s, body: undefined }, null, 2));
      }
      originals.get(s.slug).push({ id: s.source.id, repo: s.source.repo, path: s.source.path, tier: s.tier });
      total += s.bytes;
      if (total > MAX_TOTAL) { log('! size cap reached, stopping'); break; }
    }
  }

  const skills = [...bySlug.values()]
    .map((s) => ({ ...s, also: (originals.get(s.slug) || []).slice(1) }))
    .sort((a, b) => (a.tier === b.tier ? a.slug.localeCompare(b.slug) : a.tier.localeCompare(b.tier)));

  const tierCount = skills.reduce((acc, s) => ({ ...acc, [s.tier]: (acc[s.tier] || 0) + 1 }), {});
  const index = {
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-skill-atlas.mjs',
    count: skills.length,
    duplicates: [...bySlug.keys()].reduce((n, k) => n + Math.max(0, (originals.get(k) || []).length - 1), 0),
    tiers: tierCount,
    sources: metas,
    tags: [...new Set(skills.flatMap((s) => s.tags))].sort(),
    skills: skills.map((s) => ({
      slug: s.slug,
      name: s.name,
      display: s.display,
      description: s.description.length > INDEX_DESC ? s.description.slice(0, INDEX_DESC).replace(/\s+\S*$/, '') + '…' : s.description,
      tier: s.tier,
      tags: s.tags,
      source: s.source,
      bytes: s.bytes,
      truncated: s.truncated,
      resources: s.resources.slice(0, 8),
      resource_count: s.resources.length,
      flags: s.flags,
      also: s.also,
      body: s.body
    }))
  };

  // Shard the bodies: the browser loads `index.json` (metadata only) to paint
  // 2,000+ cards, and fetches one shard when a skill is opened or invoked.
  const bodiesDir = path.join(OUT, 'bodies');
  await fsp.rm(bodiesDir, { recursive: true, force: true });
  await fsp.mkdir(bodiesDir, { recursive: true });
  const shards = {};
  for (const s of index.skills) {
    const key = shardOf(s.slug);
    (shards[key] ||= {})[s.slug] = s.body;
  }
  let bodiesBytes = 0;
  for (const [key, map] of Object.entries(shards)) {
    const text = JSON.stringify(map);
    bodiesBytes += Buffer.byteLength(text);
    await fsp.writeFile(path.join(bodiesDir, `${key}.json`), text);
  }
  const lean = { ...index, bodies_bytes: bodiesBytes, shards: Object.keys(shards).sort(), skills: index.skills.map(({ body, ...rest }) => ({ ...rest, shard: shardOf(rest.slug) })) };
  await fsp.writeFile(path.join(OUT, 'index.json'), JSON.stringify(lean));
  await fsp.writeFile(path.join(DATA, 'sources.json'), JSON.stringify({ generated_at: index.generated_at, sources: metas, count: skills.length }, null, 2));

  const md = [
    '# Skill atlas',
    '',
    `Generated ${index.generated_at} by \`scripts/build-skill-atlas.mjs\`. ${index.count} skills.`,
    '',
    '| source | repo | license | skills | commit |',
    '| --- | --- | --- | --- | --- |',
    ...metas.map((m) => `| ${m.label} | ${m.repo || 'this repository'} | ${m.license} | ${skills.filter((s) => s.source.id === m.id).length} | \`${(m.commit || 'n/a').slice(0, 12)}\` |`),
    '',
    'Every `SKILL.md` is copied verbatim (frontmatter is normalised only where Qoder/runtime rules require it:',
    'lowercase `name`, single-line `description` ≤ 1024 chars). Each skill keeps its source URL and commit above.',
    'Skills flagged by the safety scan are marked in the UI and never auto-invoked.'
  ].join('\n');
  await fsp.writeFile(path.join(OUT, 'README.md'), md);

  const bytes = fs.statSync(path.join(OUT, 'index.json')).size;
  log(`  index ${(bytes / 1024 / 1024).toFixed(2)} MB · bodies ${(bodiesBytes / 1024 / 1024).toFixed(2)} MB in ${Object.keys(shards).length} shards`);
  log(`\n✓ ${index.count} skills · ${(bytes / 1024 / 1024).toFixed(2)} MB index · ${index.duplicates} duplicates merged`);
  log(`  ${OUT}/index.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
