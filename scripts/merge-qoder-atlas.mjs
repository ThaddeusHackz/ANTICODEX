#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { toAtlasEntries, QODER_SOURCE, QODER_COMMIT, QODER_REPO } from '../lib/qoder-skills.js';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(ROOT, 'web', 'public', 'skills-atlas', 'index.json');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const h = { 'User-Agent': 'anticodex-atlas', Accept: 'application/vnd.github+json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
const tr = await fetch('https://api.github.com/repos/' + QODER_REPO + '/git/trees/' + QODER_COMMIT + ':catalog', { headers: h });
if (!tr.ok) { console.error('catalog tree HTTP ' + tr.status); process.exit(1); }
const entry = ((await tr.json()).tree || []).find((t) => t.path === 'qoder.json');
if (!entry) { console.error('catalog/qoder.json missing'); process.exit(1); }
const br = await fetch('https://api.github.com/repos/' + QODER_REPO + '/git/blobs/' + entry.sha, { headers: { ...h, Accept: 'application/vnd.github.raw' } });
if (!br.ok) { console.error('catalog blob HTTP ' + br.status); process.exit(1); }
const catalog = await br.json();
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const core = (index.skills || []).filter((s) => s.source?.id !== QODER_SOURCE.id);
const coreSlugs = new Set(core.map((s) => s.slug));
const qoder = toAtlasEntries(catalog, { commit: QODER_COMMIT }).filter((s) => !coreSlugs.has(s.slug));
const skills = [...core, ...qoder];
const tiers = {}; for (const s of skills) tiers[s.tier] = (tiers[s.tier] || 0) + 1;
const tags = [...new Set(skills.flatMap((s) => s.tags || []))].sort();
const sources = [...(index.sources || []).filter((s) => s.id !== QODER_SOURCE.id), { id: QODER_SOURCE.id, repo: QODER_REPO, label: QODER_SOURCE.label, license: 'MIT', tier: 'extra', commit: QODER_COMMIT, found: qoder.length }];
const merged = { ...index, generated_at: new Date().toISOString(), generator: (index.generator || 'build-skill-atlas') + ' + merge-qoder-atlas (' + QODER_COMMIT + ')', count: skills.length, duplicates: (index.duplicates || 0), tiers, sources, tags, skills };
fs.writeFileSync(INDEX, JSON.stringify(merged));
console.log('atlas: ' + core.length + ' core + ' + qoder.length + ' qoder = ' + skills.length + ' skills, ' + fs.statSync(INDEX).size + ' bytes');
