// Brand tiles + MCP catalog truthfulness.
//
// Two classes of bug this suite exists to stop:
//   1. A tile that points at a logo file nobody vendored — the UI then shows a
//      broken image, or worse, a monogram that pretends to be the brand mark.
//   2. A connector card that advertises an endpoint/launch spec that cannot
//      work: a made-up `*.anticodex.ai` host, a `local:` URL with no launch spec,
//      or an unpinned `npx` package that mutates under the user.
//
// Run: node tests/test-brands.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createClient, isLocalMcp, stdioNeedsConfig, stdioSpec, MCP_CATALOG } from '../lib/mcp.js';

const root = new URL('..', import.meta.url).pathname;
const logoDir = path.join(root, 'web', 'public', 'logos');
const brandSrc = fs.readFileSync(path.join(root, 'web', 'src', 'BrandIcon.jsx'), 'utf8');
const brandCss = fs.readFileSync(path.join(root, 'web', 'src', 'brand.css'), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` ${extra}` : ''}`); }
}

// ---------------------------------------------------------------------------
// Parse the registry out of BrandIcon.jsx (the file is JSX, so Node cannot
// import it directly; the map itself is plain `'key': 'slug'` lines).
// ---------------------------------------------------------------------------
const mapBlock = (() => {
  const start = brandSrc.indexOf('export const BRAND_LOGOS');
  const end = brandSrc.indexOf('};', start);
  return start >= 0 && end > start ? brandSrc.slice(start, end) : '';
})();
const brands = {};
for (const m of mapBlock.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) brands[m[1]] = m[2];
const mappedSlugs = new Set(Object.values(brands));

console.log('\n— BrandIcon registry —');
{
  ok('BRAND_LOGOS parses out of BrandIcon.jsx', Object.keys(brands).length >= 40, `${Object.keys(brands).length} entries`);
  ok('it is imported from brand.css', /import\s+['"]\.\/brand\.css['"]/.test(brandSrc));
  ok('component renders <img src="/logos/<slug>.svg">', /src=\{`\/logos\/\$\{slug\}\.svg`\}/.test(brandSrc));
  ok('image is decorative (alt="", aria-hidden)', /alt=""/.test(brandSrc) && /aria-hidden="true"/.test(brandSrc));
  ok('a failed mark falls back to a monogram', /onError=\{\(\) => setBrokenSlug\(slug\)\}/.test(brandSrc));
  ok('a monogram is never labelled as the official logo', /monogram \(no bundled brand mark\)/.test(brandSrc));
  ok('brand.css styles the tile image', /\.mcp-icon\s*>\s*img\s*\{/.test(brandCss));
  ok('brand.css distinguishes a real mark from a monogram',
    /\.mcp-icon\[data-brand\]/.test(brandCss) && /\.mcp-icon\[data-monogram\]/.test(brandCss));
}

console.log('\n— vendored logo files —');
{
  ok('public/logos exists', fs.existsSync(logoDir));
  const files = fs.readdirSync(logoDir).filter((f) => f.endsWith('.svg'));
  ok('there are vendor files to check', files.length > 0, `${files.length} svg`);
  const onDisk = new Set(files.map((f) => f.slice(0, -4)));
  const missing = [...mappedSlugs].filter((s) => !onDisk.has(s));
  ok('every mapped slug has a file on disk', missing.length === 0, missing.join(', '));
  const orphans = [...onDisk].filter((s) => !mappedSlugs.has(s));
  ok('every vendored file is reachable from the registry (no dead asset)', orphans.length === 0, orphans.join(', '));
  ok('slug names are lowercase/url-safe', [...onDisk].every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)));

  const bad = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(logoDir, f), 'utf8');
    if (!/<svg[\s>]/.test(s) || !/<path\b[^>]*\bd=/.test(s) || !/viewBox="0 0 24 24"/.test(s)) bad.push(`${f}: not a Simple Icons path`);
    // Dark canvas: every mark must be visible. Path data is untouched; only the
    // root fill is rewritten by the vendoring step.
    if (!/fill="#ffffff"/.test(s)) bad.push(`${f}: not filled for the dark UI`);
    if (/fill="(?:#000(?:000)?|black)"/i.test(s)) bad.push(`${f}: black fill`);
    if (/<script\b/i.test(s) || /\b(?:href|xlink:href)=/i.test(s)) bad.push(`${f}: external or executable content`);
  }
  ok('every SVG is a real monochrome path, white-filled, script-free', bad.length === 0, bad.slice(0, 5).join('; '));
}

console.log('\n— no fake brand marks —');
{
  // These have no Simple Icons entry (verified against the registry). They must
  // stay monograms: inventing a lookalike logo is worse than a letter tile.
  const mustBeMonogram = ['composio', 'pipedream', 'deepwiki', 'context7', 'memory', 'rea', 'filesystem', 'sequential-thinking', 'xai', 'numes', 'zai', 'hunyuan', 'groq', 'together', 'fireworks', 'cerebras', 'cohere', 'thinkingmachines', 'atria', 'experientiallabs'];
  const faked = mustBeMonogram.filter((id) => brands[id]);
  ok('brands without a bundled mark fall back to a monogram', faked.length === 0, faked.join(', '));
  const required = ['github', 'notion', 'linear', 'supabase', 'cloudflare', 'sentry', 'paypal', 'stripe', 'asana', 'intercom', 'vercel', 'zapier', 'playwright', 'shadcn', 'nvidia', 'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'moonshot', 'qwen', 'doubao', 'minimax', 'meta', 'openrouter', 'perplexity', 'azure', 'vertex', 'bedrock'];
  const unmapped = required.filter((id) => !brands[id]);
  ok('catalog and provider brands with a real mark are mapped', unmapped.length === 0, unmapped.join(', '));
  ok('chrome-devtools uses the Chrome mark', brands['chrome-devtools'] === 'googlechrome');
  ok('shadcn aliases the shadcn/ui mark', brands.shadcn === 'shadcnui');
}

console.log('\n— pages use BrandIcon instead of letter tiles —');
{
  const mcpSrc = fs.readFileSync(path.join(root, 'web', 'src', 'pages', 'Mcp.jsx'), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(root, 'web', 'src', 'pages', 'Settings.jsx'), 'utf8');
  ok('Mcp.jsx imports BrandIcon', /import\s+BrandIcon\s+from\s+['"]\.\.\/BrandIcon\.jsx['"]/.test(mcpSrc));
  ok('Settings.jsx imports BrandIcon', /import\s+BrandIcon\s+from\s+['"]\.\.\/BrandIcon\.jsx['"]/.test(settingsSrc));
  ok('Mcp.jsx has no hard-coded letter/emoji tile left', !/<div className="mcp-icon">/.test(mcpSrc));
  ok('Settings.jsx has no hard-coded letter tile left', !/<div className="mcp-icon"/.test(settingsSrc));
  ok('gateway, catalog and connected rows all render a brand mark',
    (mcpSrc.match(/<BrandIcon\b/g) || []).length >= 3);
  ok('provider cards render a brand mark', (settingsSrc.match(/<BrandIcon\b/g) || []).length >= 1);
  ok('needs_config is surfaced on the card', /Not connectable yet — needs/.test(mcpSrc) && /Required value/.test(mcpSrc));
  ok('needs_config disables Connect instead of failing silently', /disabled=\{Boolean\(cfg\)/.test(mcpSrc));
  ok('hosted site keeps the honest "runs on your machine" message', /connect it from the desktop app or a local `npm start`, not from the hosted site/.test(mcpSrc));
}

console.log('\n— MCP catalog: no fake hosts —');
{
  const ids = MCP_CATALOG.map((c) => c.id);
  ok('catalog ids are unique', new Set(ids).size === ids.length);
  const missingMeta = MCP_CATALOG.filter((c) => !c.name || !c.vendor || !c.description || !Array.isArray(c.tags));
  ok('every entry has name/vendor/description/tags', missingMeta.length === 0, missingMeta.map((c) => c.id).join(', '));

  const fake = [];
  for (const c of MCP_CATALOG) {
    for (const raw of [c.url, c.gateway].filter(Boolean)) {
      let host = '';
      try { host = new URL(raw).hostname; } catch { continue; }
      if (/(^|\.)anticodex\.ai$/i.test(host)) fake.push(`${c.id}: ${host}`);
    }
  }
  ok('no catalog entry points at a made-up *.anticodex.ai host', fake.length === 0, fake.join(', '));
  ok('the fake memory endpoint is gone', !MCP_CATALOG.some((c) => /memory\.mcp\.anticodex\.ai/.test(c.url || '')));
  ok('the fake fetch endpoint is gone', !MCP_CATALOG.some((c) => c.id === 'fetch' || /fetch\.mcp\.anticodex\.ai/.test(c.url || '')));
}

console.log('\n— MCP catalog: local entries are launchable or explicit —');
{
  const local = MCP_CATALOG.filter((c) => /^(stdio|local):/.test(c.url || ''));
  ok('there are local entries', local.length >= 5, `${local.length}`);
  const unresolved = local.filter((c) => !stdioSpec(c.url) && !c.needs_config);
  ok('every local:/stdio: entry resolves through stdioSpec or carries needs_config',
    unresolved.length === 0, unresolved.map((c) => c.id).join(', '));
  ok('isLocalMcp agrees for every launchable entry',
    local.filter((c) => c.stdio).every((c) => isLocalMcp(c.url) === true));
  ok('a needs_config entry is not reported as launchable',
    local.filter((c) => c.needs_config && !c.stdio).every((c) => isLocalMcp(c.url) === false));

  const badSpec = local.filter((c) => c.stdio && (c.stdio.command !== 'npx' || !Array.isArray(c.stdio.args) || !c.stdio.args.length));
  ok('launch specs are registry-only npx commands', badSpec.length === 0, badSpec.map((c) => c.id).join(', '));
  const unpinned = local.filter((c) => c.stdio && !c.stdio.args.some((a) => /@\d+\.\d+\.\d+$/.test(a)));
  ok('every stdio package is version-pinned', unpinned.length === 0, unpinned.map((c) => c.id).join(', '));
  ok('every launchable entry reports its pinned version',
    local.filter((c) => c.stdio).every((c) => /^\d+\.\d+\.\d+$/.test(c.version || '')));

  const cfg = MCP_CATALOG.filter((c) => c.needs_config);
  const badCfg = cfg.filter((c) => !c.needs_config.field || !c.needs_config.label || !c.needs_config.example || !c.needs_config.why);
  ok('needs_config carries field/label/example/why', badCfg.length === 0, badCfg.map((c) => c.id).join(', '));
  ok('a needs_config entry never pretends to have a launch spec',
    cfg.every((c) => !c.stdio));

  const fsEntry = MCP_CATALOG.find((c) => c.id === 'filesystem');
  ok('filesystem asks for a directory', fsEntry?.needs_config?.field === 'directory' && /folder/.test(fsEntry.needs_config.label));
  ok('stdioNeedsConfig explains the filesystem entry',
    stdioNeedsConfig('local:filesystem')?.field === 'directory');
  ok('stdioNeedsConfig ignores launchable and remote urls',
    stdioNeedsConfig('stdio:playwright') === null && stdioNeedsConfig('https://mcp.notion.com/mcp') === null);
  let msg = null;
  try { createClient({ url: 'local:filesystem' }); } catch (e) { msg = e.message; }
  ok('createClient refuses filesystem with the missing value, not a bare "no launch spec"',
    /needs folder to expose/.test(String(msg)) && !/no launch spec/.test(String(msg)), String(msg));
  ok('the removed Postgres entry is not advertised',
    !MCP_CATALOG.some((c) => c.id === 'postgres' || c.url === 'local:postgres'));
}

console.log('\n— MCP catalog: the advertised local servers —');
{
  const memory = MCP_CATALOG.find((c) => c.id === 'memory');
  ok('memory is a real stdio entry', memory?.url === 'stdio:memory' && memory?.local === true);
  ok('memory is pinned to @modelcontextprotocol/server-memory@2.1.1',
    stdioSpec('stdio:memory')?.args.join(' ') === '-y @modelcontextprotocol/server-memory@2.1.1');

  const pw = MCP_CATALOG.find((c) => c.id === 'playwright');
  const pwSpec = stdioSpec('stdio:playwright');
  ok('Playwright entry exists', Boolean(pw));
  ok('Playwright is pinned to @playwright/mcp@0.0.85',
    pwSpec?.args.includes('@playwright/mcp@0.0.85') && pw?.version === '0.0.85');
  ok('Playwright launches headless', pwSpec?.args.includes('--headless'));
  ok('Playwright is tagged browser/ui/e2e/local',
    ['browser', 'ui', 'e2e', 'local'].every((t) => pw?.tags.includes(t)));

  const chrome = stdioSpec('stdio:chrome-devtools');
  ok('Chrome DevTools is pinned to chrome-devtools-mcp@1.13.0',
    chrome?.args.includes('chrome-devtools-mcp@1.13.0'));
  const shadcn = stdioSpec('stdio:shadcn');
  ok('shadcn is pinned to shadcn@4.23.0', shadcn?.args.includes('shadcn@4.23.0'));
  ok('shadcn runs its own `mcp` subcommand', shadcn?.args[shadcn.args.length - 1] === 'mcp');
  const seq = stdioSpec('stdio:sequential-thinking');
  ok('sequential-thinking is pinned to @modelcontextprotocol/server-sequential-thinking@2.1.1',
    seq?.args.includes('@modelcontextprotocol/server-sequential-thinking@2.1.1'));
  ok('stdioSpec keeps the entry id and human name',
    stdioSpec('stdio:playwright')?.id === 'playwright' && stdioSpec('stdio:playwright')?.name === 'Playwright');
  ok('an unknown local id still has no spec', stdioSpec('stdio:definitely-not-registered') === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
