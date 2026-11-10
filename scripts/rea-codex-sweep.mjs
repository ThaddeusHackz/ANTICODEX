#!/usr/bin/env node
// REA sweep of `openai/codex` (Apache-2.0) — turn the upstream workspace into data.
//
// The point is not to copy Codex. It is to be able to say, for each surface this
// app claims ("approval modes", "patch proposals", "skills", "sandbox"), where the
// behaviour comes from in the real implementation, and whether it is present here
// or still missing. A claim you cannot point at is a claim you should not make.
//
// What it records per crate: file count, source bytes, whether it is a binary, and
// the module list from its `lib.rs`/`main.rs` if we can fetch it cheaply. Nothing
// is executed; this is a read of public source and the GitHub tree API.
//
// Output: lib/codex-repos.js (generated — do not hand-edit) + data/codex-sweep.json
//
// Usage: node scripts/rea-codex-sweep.mjs [--repo openai/codex] [--ref main] [--no-fetch]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_JS = path.join(ROOT, 'lib', 'codex-repos.js');
const OUT_DATA = path.join(ROOT, 'data', 'codex-sweep.json');

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REPO = arg('--repo', 'openai/codex');
const REF = arg('--ref', 'main');
const fetchModules = !argv.includes('--no-fetch');

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

async function gh(urlPath, raw = false) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'User-Agent': 'ANTICODEX-REA-Sweep',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${urlPath}`);
  return raw ? res.text() : res.json();
}

const NON_CRATES = new Set(['.cargo', '.config', 'scripts', 'vendor', 'third_party', 'docs', 'bazel']);

function kindOf(name, files) {
  if (files.some((f) => /(^|\/)main\.rs$/.test(f))) return 'binary';
  if (/^(tui|cli|exec|app-server|app-server-daemon|app-server-client|app-server-test-client|exec-server|login|mcp|mcp-server|codex|apply-patch|windows-sandbox-service|exec-server-cli|tcp-tunnel|stdio-to-uds|message-board-mcp|uds)$/.test(name)) return 'binary';
  if (/-macros$/.test(name)) return 'macros';
  if (files.every((f) => /tests?\//.test(f))) return 'tests';
  return 'library';
}

async function main() {
  console.error(`· sweeping ${REPO}@${REF}`);
  const tree = await gh(`/repos/${REPO}/git/trees/${encodeURIComponent(REF)}?recursive=1`);
  const sha = tree.sha;
  const blobs = (tree.tree || []).filter((e) => e.type === 'blob');

  // --- codex-rs crates -----------------------------------------------------
  const byCrate = new Map();
  for (const b of blobs) {
    const m = b.path.match(/^codex-rs\/([^/]+)\//);
    if (!m || NON_CRATES.has(m[1])) continue;
    const name = m[1];
    const c = byCrate.get(name) || { name, files: 0, bytes: 0, paths: [] };
    c.files += 1;
    c.bytes += b.size || 0;
    if (/\.rs$/.test(b.path)) c.paths.push(b.path);
    byCrate.set(name, c);
  }

  const crates = [...byCrate.values()].map((c) => ({
    name: c.name,
    files: c.files,
    source_files: c.paths.length,
    source_bytes: c.paths.reduce((n, p) => n + (blobs.find((b) => b.path === p)?.size || 0), 0),
    kind: kindOf(c.name, c.paths),
    modules: []
  }));

  // --- module lists for the crates that matter -----------------------------
  const interesting = crates
    .filter((c) => c.source_bytes > 20_000 || /^(core|cli|exec|tui|app-server.*|config|tools|skills|execpolicy|apply-patch|code-mode.*|sandboxing|hooks|memories|codex-home|keyring-store|login|mcp|codex-mcp|rmcp-client|protocol)$/.test(c.name))
    .sort((a, b) => b.source_bytes - a.source_bytes)
    .slice(0, 40);

  if (fetchModules) {
    for (const c of interesting) {
      for (const candidate of ['lib.rs', 'main.rs']) {
        try {
          const text = await gh(`/repos/${REPO}/contents/codex-rs/${c.name}/src/${candidate}?ref=${encodeURIComponent(REF)}`, true);
          const mods = [...text.matchAll(/^\s*(?:pub\s+)?mod\s+([a-z0-9_]+)\s*;/gm)].map((m) => m[1]);
          c.modules = [...new Set(mods)];
          c.entry = `src/${candidate}`;
          break;
        } catch { /* no such entry point */ }
      }
      console.error(`  · ${c.name}: ${c.modules.length} modules`);
    }
  }

  // --- other surfaces ------------------------------------------------------
  const rootDirs = [...new Set(blobs.map((b) => b.path.split('/')[0]))].filter((d) => !d.includes('.'));
  const docs = blobs.filter((b) => /^docs\/[^/]+\.md$/.test(b.path)).map((b) => b.path.replace(/^docs\//, ''));
  const counts = {
    entries: blobs.length,
    crates: crates.length,
    crates_by_kind: crates.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] || 0) + 1 }), {}),
    source_bytes: crates.reduce((n, c) => n + c.source_bytes, 0),
    rust_files: blobs.filter((b) => /\.rs$/.test(b.path)).length
  };

  const data = {
    generated_at: new Date().toISOString(),
    repo: REPO,
    ref: REF,
    commit: sha,
    url: `https://github.com/${REPO}/tree/${sha}`,
    license: 'Apache-2.0',
    counts,
    root_dirs: rootDirs.sort(),
    docs: docs.sort(),
    crates: crates.sort((a, b) => b.source_bytes - a.source_bytes)
  };

  await fsp.mkdir(path.dirname(OUT_DATA), { recursive: true });
  await fsp.writeFile(OUT_DATA, JSON.stringify(data, null, 2));

  const banner = `// GENERATED by scripts/rea-codex-sweep.mjs — do not hand-edit.
//
// A read of ${REPO}@${REF} (Apache-2.0) as it stood at commit ${sha.slice(0, 12)} on
// ${data.generated_at.slice(0, 10)}: every workspace crate, its source size, whether it
// builds a binary, and the modules its entry point declares. This is evidence for
// \`lib/codex-map.js\`, which pairs each crate with the ANTICODEX surface that
// implements the same job and says honestly whether that implementation exists.
//
// Regenerate with: node scripts/rea-codex-sweep.mjs

export const CODEX_SOURCE = {
  repo: ${JSON.stringify(REPO)},
  ref: ${JSON.stringify(REF)},
  commit: ${JSON.stringify(sha)},
  url: ${JSON.stringify(data.url)},
  license: 'Apache-2.0',
  generated_at: ${JSON.stringify(data.generated_at)},
  counts: ${JSON.stringify(counts, null, 2).replace(/\n/g, '\n  ')}
};

/** @type {{name:string,files:number,source_files:number,source_bytes:number,kind:string,modules:string[],entry?:string}[]} */
export const CODEX_CRATES = ${JSON.stringify(data.crates, null, 2)};

export const CODEX_DOCS = ${JSON.stringify(data.docs)};
export const CODEX_ROOT_DIRS = ${JSON.stringify(data.root_dirs)};
`;
  await fsp.writeFile(OUT_JS, banner);

  console.error(`\n✓ ${crates.length} crates · ${(counts.source_bytes / 1024 / 1024).toFixed(1)} MB of Rust · ${counts.rust_files} .rs files`);
  console.error(`  ${OUT_JS}`);
  console.error(`  ${OUT_DATA}`);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
