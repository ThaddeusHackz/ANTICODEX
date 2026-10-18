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
ok('dist/index.html exists', fs.existsSync(path.join(dist, 'index.html')));
const assets = path.join(dist, 'assets');
const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
const css = fs.readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');

for (const needle of ['ANTICODEX', 'MCP', 'Codex', 'Flux', 'Hailuo', 'Computer Use', 'NVIDIA', 'Tavily', 'Exa', 'Forgot', 'pairing']) {
  ok(`bundle contains "${needle}"`, js.includes(needle) || css.includes(needle));
}
// Admin credentials live only on the server, never in the web bundle.
const keysSrc = fs.readFileSync(path.join(root, 'lib', 'keys.js'), 'utf8');
ok('admin creds defined server-side', keysSrc.includes('Thaddeusadmin') && keysSrc.includes('Thaddeusk12'));
ok('admin creds NOT in web bundle', !js.includes('Thaddeusk12'));
ok('markdown sanitizer present', js.includes('blocked:'));
ok('css has prism design tokens', css.includes('--accent-grad') && css.includes('.composer'));

console.log('— repo integrity —');
for (const f of ['api/bridge.js', 'server.mjs', 'supabase/schema.sql', 'skills/leanrea/SKILL.md',
  'skills/reverse-engineer-anything/SKILL.md', 'docs/FORENSIC-REPORT.md', 'desktop/main.mjs', 'desktop/package.json']) {
  ok(`${f} exists`, fs.existsSync(path.join(root, f)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
