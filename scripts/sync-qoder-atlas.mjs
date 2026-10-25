#!/usr/bin/env node
// Re-read the QoderAI repositories and refresh lib/qoder-repos.js.
//
// What this updates: stars, size, language, and the summary fallback (the
// repository's own description). What it never touches: the curated `summary`
// and `use` notes, and `integrated` — those are judgements about this app, not
// facts from the API, so a refresh cannot quietly rewrite them.
//
//   node scripts/sync-qoder-atlas.mjs            # update the file
//   node scripts/sync-qoder-atlas.mjs --check    # exit 1 if it would change

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'lib', 'qoder-repos.js');
const check = process.argv.includes('--check');

const toFileUrl = (p) => new URL(`file://${p}`);
const existing = (await import(`${toFileUrl(target)}?t=${Date.now()}`)).QODER_REPOS;
const byName = new Map(existing.map((r) => [r.name, r]));

// `gh` when it is there (it paginates and authenticates itself), plain fetch
// otherwise. Two paths because a machine behind a TLS-inspecting proxy breaks
// `fetch` in ways that have nothing to do with this survey.
async function fetchViaGh() {
  try {
    const { stdout } = await run('gh', ['api', 'users/qoderAI/repos?per_page=100', '--paginate', '--jq', '.[] | @json'], { maxBuffer: 32 * 1024 * 1024 });
    // `--jq '.[] | @json'` emits one JSON value per line, unquoted.
    const rows = stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    return rows.length ? rows : null;
  } catch { return null; }
}

async function fetchViaHttp() {
  const out = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`https://api.github.com/users/qoderAI/repos?per_page=100&page=${page}`, {
      headers: { 'User-Agent': 'ANTICODEX-atlas', Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for page ${page}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function fetchAll() {
  return (await fetchViaGh()) || fetchViaHttp();
}

const repos = await fetchAll();
if (!repos.length) throw new Error('GitHub returned no repositories');

const rows = repos
  .map((r) => {
    const prior = byName.get(r.name) || {};
    return {
      name: r.name,
      // Canonical owner spelling used everywhere in this repo (GitHub is
      // case-insensitive, but a survey should read consistently).
      url: `https://github.com/qoderAI/${r.name}`,
      kind: prior.kind || 'unknown',
      language: r.language || null,
      stars: r.stargazers_count || 0,
      size_kb: r.size || 0,
      summary: prior.summary || (r.description || '').trim() || 'No description.',
      use: prior.use || 'Not integrated.',
      tags: prior.tags || [],
      integrated: Boolean(prior.integrated)
    };
  })
  .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));

const added = rows.filter((r) => !byName.has(r.name)).map((r) => r.name);
const removed = existing.filter((r) => !rows.some((x) => x.name === r.name)).map((r) => r.name);

const header = fs.readFileSync(target, 'utf8').split('export const QODER_OWNER')[0];
const footer = `export const QODER_OWNER = 'qoderAI';

/** @type {{name:string,url:string,kind:string,language:string|null,stars:number,size_kb:number,summary:string,use:string,tags:string[],integrated:boolean}[]} */
export const QODER_REPOS = ${JSON.stringify(rows, null, 2)};

/** Kinds, in the order the page shows them. */
export const QODER_KINDS = ${JSON.stringify(['sdk', 'demo', 'action', 'app', 'tool', 'cli', 'eval', 'bench', 'docs', 'changelog', 'empty', 'unknown'])};

/** Counts by kind, and how many repositories this app actually builds on. */
export function atlasTally(repos = QODER_REPOS) {
  const byKind = {};
  for (const r of repos) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return {
    total: repos.length,
    integrated: repos.filter((r) => r.integrated).length,
    empty: byKind.empty || 0,
    byKind
  };
}
`;

const next = header + footer;
const current = fs.readFileSync(target, 'utf8');

if (added.length) console.log(`new repositories: ${added.join(', ')} — add a note for each in this script's curated table`);
if (removed.length) console.log(`gone from GitHub: ${removed.join(', ')}`);

if (check) {
  const changed = current !== next;
  console.log(changed ? 'lib/qoder-repos.js is out of date' : 'lib/qoder-repos.js is up to date');
  process.exit(changed ? 1 : 0);
}

fs.writeFileSync(target, next);
console.log(`wrote ${rows.length} repositories to lib/qoder-repos.js`);
