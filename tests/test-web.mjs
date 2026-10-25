// Build-artifact checks: the web bundle must exist and contain key surfaces.

import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = path.join(root, 'web', 'dist');
let passed = 0, failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('\n— web bundle —');
ok('dist/index.html exists', fs.existsSync(path.join(dist, 'index.html')),
  ' → run `npm run build --prefix web` first: this suite asserts on what ships, not on the source');
const assets = path.join(dist, 'assets');
const readAll = (ext) => {
  let files = [];
  try { files = fs.readdirSync(assets).filter((f) => f.endsWith(ext)); } catch { return ''; }
  return files.map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
};
const js = readAll('.js');
const css = readAll('.css');
if (!js) {
  ok('a built bundle is present to assert on', false, `no .js under ${assets} — run \`npm run build --prefix web\` and re-run`);
  console.log('\n  (the remaining bundle checks need that build, so they are not run)');
  process.exit(1);
}
// "I fixed it but the app did not change" is usually this: assertions passing
// against a bundle that predates the source. The packager rebuilds for exactly
// this reason; the test suite should refuse to grade a stale artifact too.
const newestSrc = (() => {
  let t = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(jsx?|css|html)$/.test(e.name)) t = Math.max(t, fs.statSync(p).mtimeMs);
    }
  };
  for (const d of [path.join(root, 'web', 'src'), path.join(root, 'web')]) {
    try { if (d.endsWith('src')) walk(d); else t = Math.max(t, fs.statSync(path.join(d, 'index.html')).mtimeMs, fs.statSync(path.join(d, 'vite.config.js')).mtimeMs); } catch { /* no config */ }
  }
  return t;
})();
const bundleAge = fs.statSync(path.join(dist, 'index.html')).mtimeMs;
ok('the bundle being graded is not older than web/src', bundleAge >= newestSrc - 1000,
  ' → web/dist predates the source; run `npm run build --prefix web`');

for (const needle of ['ANTICODEX', 'MCP', 'Codex', 'Flux', 'Hailuo', 'Computer Use', 'NVIDIA', 'Tavily', 'Exa', 'Forgot', 'pairing']) {
  ok(`bundle contains "${needle}"`, js.includes(needle) || css.includes(needle));
}
// Admin credentials live only on the server, never in the web bundle.
const keysSrc = fs.readFileSync(path.join(root, 'lib', 'keys.js'), 'utf8');
ok('admin creds defined server-side', keysSrc.includes('Thaddeusadmin') && keysSrc.includes('Thaddeusk12'));
ok('admin creds NOT in web bundle', !js.includes('Thaddeusk12'));
// The sanitizer is an allowlist now (tags + attributes + URL scheme), named in the
// source; the minified bundle proves the URL allowlist shipped with it.
const mdSrc = fs.readFileSync(path.join(root, 'web', 'src', 'lib', 'markdown.js'), 'utf8');
ok('markdown sanitizer is an allowlist, not a blocklist',
  /ALLOWED_TAGS/.test(mdSrc) && /ALLOWED_ATTRS/.test(mdSrc) && /SAFE_URL/.test(mdSrc) && /sanitizeTag/.test(mdSrc));
ok('…and it shipped in the bundle', js.includes('mailto:'));
ok('css has prism design tokens', css.includes('--accent-grad') && css.includes('.composer'));

console.log('\n— page layout coverage (the "blank workspace" class of bug) —');
const srcRoot = path.join(root, 'web', 'src');
const jsxFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p2 = path.join(d, f);
    if (fs.statSync(p2).isDirectory()) walk(p2); else if (/\.jsx?$/.test(f)) jsxFiles.push(p2);
  }
})(srcRoot);
const cssSrc = fs.readFileSync(path.join(srcRoot, 'styles.css'), 'utf8');
const styled = new Set([...cssSrc.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
// classes that are behaviour/state hooks only, styled through a parent selector
const HOOK_ONLY = new Set(['tab']);
const unstyled = [];
for (const f of jsxFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ');
    for (const c of raw.split(/\s+/)) {
      if (c && /^[A-Za-z][\w-]*$/.test(c) && !styled.has(c) && !HOOK_ONLY.has(c)) unstyled.push(`${path.basename(f)}: .${c}`);
    }
  }
}
ok('every className used by a page has a rule in styles.css', unstyled.length === 0);
if (unstyled.length) console.log('      ' + [...new Set(unstyled)].join(', '));

ok('codex workspace is sized by flex (no 100vh overflow clipping)',
  /\.workspace\s*\{[^}]*flex: 1/.test(cssSrc) && !/\.workspace\s*\{[^}]*height: 100%/.test(cssSrc));
ok('codex workspace file tree has an explicit width', /\.file-tree\s*\{[^}]*width:/.test(cssSrc));
ok('codex workspace rows are styled (.file-item)', /\.file-item/.test(cssSrc));
ok('codex workspace editor fills its pane and scrolls', /\.editor-pane textarea\s*\{[^}]*flex: 1[^}]*min-height: 0/.test(cssSrc));
ok('codex workspace terminal is bounded so the composer stays reachable', /\.workspace \.term\s*\{[^}]*max-height/.test(cssSrc));
ok('panes stack on narrow windows (desktop minimum size)', (() => {
  const i = cssSrc.indexOf('@media (max-width: 1000px)');
  return i > 0 && /\.workspace\s*\{\s*flex-direction: column/.test(cssSrc.slice(i, i + 700));
})());
ok('main allows panes to shrink', /\.main\s*\{[^}]*min-height: 0/.test(cssSrc));

// A named import that the module does not export renders a blank page (React
// throws at render time), so it is worth failing CI on.
const exportsOf = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) {
    const n = part.trim().split(/\s+as\s+/).pop().trim();
    if (n) names.add(n);
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
};
const brokenImports = [];
for (const f of jsxFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const [, raw, spec] = m;
    let target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) target = ['.jsx', '.js'].map((x) => target + x).find((x) => fs.existsSync(x));
    if (!target) { brokenImports.push(`${path.basename(f)} → ${spec} (missing file)`); continue; }
    const have = exportsOf(target);
    for (const part of raw.split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n && !have.has(n)) brokenImports.push(`${path.basename(f)} → ${n} from ${spec}`);
    }
  }
}
ok('every named import resolves to a real export', brokenImports.length === 0);
if (brokenImports.length) console.log('      ' + brokenImports.join(', '));

console.log('\n— repo integrity —');
for (const f of ['api/bridge.js', 'server.mjs', 'supabase/schema.sql', 'skills/leanrea/SKILL.md',
  'skills/reverse-engineer-anything/SKILL.md', 'docs/FORENSIC-REPORT.md', 'desktop/main.mjs', 'desktop/package.json']) {
  ok(`${f} exists`, fs.existsSync(path.join(root, f)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
