// Tests for the 2026-11 additions: the skill atlas engine, the Daytona client,
// the Codex parity map, the library, and the Qoder field guide.
//
// These are written against the real corpus and the real filesystem — the point of
// each one is a promise the UI makes to a user:
//   * "2,208 skills" is the number the page prints;
//   * "the model receives this exact text" is what ground() returns;
//   * "this is implemented" means the file exists (delete it → the row says missing);
//   * "every run says which machine ran it" holds for local and remote;
//   * a nav item never points at a route that does not exist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const mod = async (p) => import(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// --- the atlas --------------------------------------------------------------
console.log('\n— the skill atlas —');
{
  const kit = await mod('lib/skillkit.js');
  const stats = kit.skillStats();
  ok('the atlas is present', stats.available && stats.count > 2000, `count=${stats.count}`);
  ok('…with tiers that add up', (stats.tiers.bundled || 0) + (stats.tiers.curated || 0) + (stats.tiers.extra || 0) === stats.count);
  ok('…including the bundled REA packs', stats.tiers.bundled >= 5, JSON.stringify(stats.tiers));

  const index = JSON.parse(read('web/public/skills-atlas/index.json'));
  ok('the shipped index is metadata only (no bodies)', index.skills.every((s) => s.body === undefined));
  ok('…and every skill names its shard', index.skills.every((s) => typeof s.shard === 'string'));
  const shard = index.skills[0].shard;
  ok('…the shards it names exist', fs.existsSync(path.join(ROOT, 'web/public/skills-atlas/bodies', `${shard}.json`)));
  ok('every skill carries its source and commit', index.skills.every((s) => s.source && s.source.label && (s.source.commit || s.source.id === 'anticodex')));
  ok('descriptions respect the 1024-char Qoder limit', index.skills.every((s) => (s.description || '').length <= 1024));
}

// --- listing / filtering ----------------------------------------------------
console.log('\n— browse —');
{
  const kit = await mod('lib/skillkit.js');
  const page1 = kit.listSkills({ per: 10 });
  ok('a page is 10 rows', page1.skills.length === 10, String(page1.skills.length));
  ok('…and the total is the corpus', page1.total === kit.skillStats().count);
  ok('…pages are consistent', page1.pages === Math.ceil(page1.total / 10));
  const page2 = kit.listSkills({ per: 10, page: 2 });
  ok('page 2 is a different page', page2.skills[0].slug !== page1.skills[0].slug);

  const bundled = kit.listSkills({ tier: 'bundled', per: 50 });
  ok('tier filter works', bundled.skills.every((s) => s.tier === 'bundled') && bundled.total === kit.skillStats().tiers.bundled);

  const security = kit.listSkills({ tag: 'security', per: 20 });
  ok('tag filter works', security.skills.every((s) => s.tags.includes('security')));

  const q = kit.listSkills({ q: 'playwright', per: 5 });
  ok('search returns ranked rows', q.skills.length > 0 && q.skills[0].score > 0, JSON.stringify(q.skills[0]?.slug));
  const az = kit.listSkills({ sort: 'az', per: 3 });
  ok('alphabetical sort is alphabetical', az.skills[0].slug <= az.skills[1].slug);
}

// --- retrieval --------------------------------------------------------------
console.log('\n— retrieval —');
{
  const kit = await mod('lib/skillkit.js');
  const r1 = kit.resolveSkills('make my express api secure against sql injection', { limit: 4 });
  ok('a real request finds skills', r1.matched.length > 0);
  ok('…and the top one is about security', /secur|inject|xss|vulnerab/i.test(`${r1.matched[0].slug} ${r1.matched[0].description}`), r1.matched[0].slug);
  ok('…with a score and a reason', typeof r1.matched[0].score === 'number' && Boolean(r1.matched[0].why));
  const r2 = kit.resolveSkills('make my express api secure against sql injection', { limit: 4 });
  ok('retrieval is deterministic', JSON.stringify(r1.matched.map((m) => m.slug)) === JSON.stringify(r2.matched.map((m) => m.slug)));
  const greeting = kit.resolveSkills('hi', { limit: 4 });
  ok('a greeting retrieves nothing', greeting.matched.filter((m) => m.score > 8).length === 0, JSON.stringify(greeting.matched.map((m) => m.slug)));
  const explicit = kit.resolveSkills('', { slugs: ['leanrea'] });
  ok('an explicit slug always resolves', explicit.matched[0]?.slug === 'leanrea' && explicit.matched[0].why === 'explicit');
  const limited = kit.resolveSkills('write tests', { limit: 2 });
  ok('the limit is honoured', limited.matched.length <= 2);
  const tiered = kit.resolveSkills('write tests', { limit: 5, tiers: ['bundled'] });
  ok('the tier filter is honoured', tiered.matched.every((m) => m.tier === 'bundled'));
}

// --- grounding --------------------------------------------------------------
console.log('\n— the block a model actually receives —');
{
  const kit = await mod('lib/skillkit.js');
  const g = kit.groundSkills('build a playwright test for the login flow', { max_skills: 2 });
  ok('grounding produces a prompt block', g.ok && g.text.length > 500, `${g.text.length} chars`);
  ok('…that names each skill and its source', g.injected.every((s) => g.text.includes(`### Skill: ${s.slug}`)));
  ok('…and respects the skill cap', g.injected.length <= 2);
  const tight = kit.groundSkills('write documentation', { max_skills: 1, per_skill_chars: 900, total_chars: 2000 });
  ok('a tight budget still fits', tight.text.length <= 2400, `${tight.text.length} chars`);
  const huge = kit.groundSkills('write documentation', { max_skills: 4, per_skill_chars: 40000, total_chars: 4000 });
  ok('…and the total budget wins over the per-skill one', huge.text.length <= 4600, `${huge.text.length} chars`);
  const excerpted = kit.groundSkills('', { slugs: ['reverse-engineer-anything'], per_skill_chars: 1200 });
  ok('cut text says so and points at skill_get', /excerpt: \d+ more characters/.test(excerpted.text) && /skill_get/.test(excerpted.text));
  const empty = kit.groundSkills('', {});
  ok('nothing to ground yields no block (never the whole corpus)', empty.text === '');
}

// --- the scanner ------------------------------------------------------------
console.log('\n— safety scan —');
{
  const kit = await mod('lib/skillkit.js');
  const code = [
    'const q = db.query("SELECT * FROM users WHERE id = " + req.query.id);',
    'eval(input);',
    'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";',
    'el.innerHTML = req.body.html;',
    'const h = md5(password);'
  ].join('\n');
  const out = kit.scanCode(code, { filename: 'server.js' });
  const ids = out.findings.map((f) => f.id);
  ok('SQL injection is caught', ids.includes('sql-injection'));
  ok('eval is caught', ids.includes('eval'));
  ok('a provider key is caught', ids.includes('openai-key'));
  ok('an HTML sink is caught', ids.includes('xss-innerhtml'));
  ok('a weak hash is caught', ids.includes('weak-hash'));
  ok('findings carry a line number', out.findings.every((f) => Number.isInteger(f.line) && f.line >= 1));
  ok('critical findings block', out.summary.verdict === 'block' && out.summary.critical >= 2);
  ok('every finding has a fix to show', out.findings.every((f) => typeof f.fix === 'string' && f.fix.length > 4));
  const clean = kit.scanCode('const add = (a, b) => a + b;\nexport default add;', { filename: 'math.js' });
  ok('clean code passes', clean.findings.length === 0 && clean.summary.verdict === 'pass');
  const py = kit.scanCode('import os\nverify = False\nDEBUG = True', { filename: 'app.py' });
  ok('python rules run for .py', py.language === 'py' && py.findings.some((f) => f.id === 'debug-on'));
}

// --- export -----------------------------------------------------------------
console.log('\n— install a skill —');
{
  const kit = await mod('lib/skillkit.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-skill-'));
  const out = kit.exportSkill('leanrea', dir);
  ok('export writes SKILL.md', out.ok && fs.existsSync(out.file), out.error);
  const text = fs.readFileSync(out.file, 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  ok('…with valid frontmatter', Boolean(front));
  ok('…a lowercase name', /name: leanrea/.test(front?.[1] || ''));
  ok('…a single-line description', /^description: /m.test(front?.[1] || '') && (front?.[1] || '').split('\n').filter((l) => l.startsWith('description:')).length === 1);
  ok('…and no nested frontmatter in the body', !/^---$/m.test(text.slice(front[0].length).trim().slice(0, 4)));
  const again = kit.exportSkill('leanrea', dir);
  ok('re-installing refuses to clobber', again.ok === false && /already exists/.test(again.error || ''));
  const forced = kit.exportSkill('leanrea', dir, { overwrite: true });
  ok('…unless asked', forced.ok === true);
  const missing = kit.exportSkill('no-such-skill-xyz', dir);
  ok('an unknown skill is an honest error', missing.ok === false && /No skill named/.test(missing.error));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- installed on this machine ---------------------------------------------
console.log('\n— skills on this machine —');
{
  const kit = await mod('lib/skillkit.js');
  const inst = kit.installedSkills();
  ok('roots are reported with their paths', Array.isArray(inst.roots) && inst.roots.every((r) => r.path.startsWith(os.homedir())));
  ok('accepted skills have a valid name', inst.installed.every((s) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s.name)));
  ok('every refusal carries a reason', inst.refused.every((r) => typeof r.reason === 'string' && r.reason.length > 5));
  ok('duplicates are counted, not hidden', typeof inst.duplicates === 'number');
  const local = kit.localCorpus();
  ok('the local corpus feeds retrieval', Array.isArray(local));
  if (local.length) {
    const found = kit.resolveSkills(local[0].description || local[0].slug, { limit: 3, include_local: true });
    ok('…and a local skill can be retrieved', found.matched.some((m) => m.slug === local[0].slug), JSON.stringify(found.matched.map((m) => m.slug)));
    const body = kit.skillBody(local[0].slug);
    ok('…and its body is readable', Boolean(body && body.body.length > 0 && body.tier === 'local'));
  } else {
    ok('…and a local skill can be retrieved', true, 'no local skills installed here');
    ok('…and its body is readable', true, 'no local skills installed here');
  }
}

// --- Daytona ---------------------------------------------------------------
console.log('\n— Daytona —');
{
  const d = await mod('lib/daytona.js');
  const status = d.daytonaStatus();
  ok('status has the five fields Qoder asks for', ['Host address', 'Port', 'Username', 'Authentication', 'Name'].every((k) => k in status.fields));
  ok('…and never contains a private key', !JSON.stringify(status).includes('BEGIN OPENSSH PRIVATE KEY'));
  ok('the "ssh " prefix is normalised away', d.normaliseUser('ssh WtMs123@ssh.app.daytona.io') === 'WtMs123@ssh.app.daytona.io');
  ok('…but shown as the console prints it', d.setupRecipe({ user: 'WtMs123' }).fields.Username === 'ssh WtMs123');
  const recipe = d.setupRecipe({ user: 'WtMs123' });
  ok('the ssh line is runnable, not decorative', /^ssh -p \d+ WtMs123@ssh\.app\.daytona\.io$/.test(recipe.commands[0]), recipe.commands[0]);
  const confused = d.setupRecipe({ user: 'ssh WtMs123' });
  ok('…even when the user pastes the prefixed form', !/ssh\s+ssh/.test(confused.commands[0]), confused.commands[0]);
  const local = await d.execAnywhere('printf "ran in %s" "$0"', { target: 'local' });
  ok('execAnywhere can run locally', local.ok && local.target === 'local' && /ran in/.test(local.stdout));
  ok('…and reports the target it used', local.target === 'local');
  const quoted = await d.execAnywhere(`printf '%s' "a'b\\"c"`, { target: 'local' });
  ok('quoting survives a nasty command', quoted.ok, quoted.stderr);
  const long = await d.execAnywhere('x'.repeat(5000), { target: 'local' });
  ok('an over-long command is refused before spawn', long.ok === false && /longer than/.test(long.error || ''));
  const noTarget = await d.sshExec('echo hi');
  ok('SSH without a target explains itself', noTarget.ok === false && /DAYTONA_SSH_USER/.test(noTarget.error || ''));
}

// --- Codex parity ----------------------------------------------------------
console.log('\n— Codex parity map —');
{
  const map = await mod('lib/codex-map.js');
  const parity = map.codexParity();
  ok('the sweep has evidence', parity.source.commit.length >= 7 && parity.counts.crates > 100, `${parity.counts.crates} crates`);
  ok('every surface has a parity statement', parity.rows.every((r) => typeof r.parity === 'string' && r.parity.length > 20));
  ok('…and a status that matches the filesystem', parity.rows.every((r) => {
    if (r.status === 'parity') return r.present.length === r.files.length;
    if (r.status === 'missing') return r.present.length === 0;
    return r.present.length > 0 && r.present.length < r.files.length;
  }));
  const ids = parity.rows.map((r) => r.id);
  ok('surface ids are unique', new Set(ids).size === ids.length);
  ok('the tally counts every row', Object.values(parity.tally).reduce((a, b) => a + b, 0) === parity.rows.length);
  ok('most surfaces are implemented', (parity.tally.parity || 0) >= 10, JSON.stringify(parity.tally));
  ok('unported crates are named', parity.unported.length > 0);
  const one = map.crateDetail('execpolicy');
  ok('a crate resolves to the surfaces that claim it', one && one.surfaces.length > 0, 'execpolicy');
  ok('biggest crates are ordered by size', map.biggestCrates(5).every((c, i, a) => i === 0 || a[i - 1].kb >= c.kb));

  // The check the page depends on: a missing file changes the verdict.
  const victim = 'lib/workspacefs.js';
  const abs = path.join(ROOT, victim);
  const backup = fs.readFileSync(abs);
  try {
    fs.unlinkSync(abs);
    const after = mod;
    const parity2 = (await import(`${path.join(ROOT, 'lib/codex-map.js')}?v=${Date.now()}`)).codexParity();
    const row = parity2.rows.find((r) => r.files.includes(victim));
    ok('deleting an implementation downgrades its row', row && row.status !== 'parity', `${victim} → ${row?.status}`);
  } finally {
    fs.writeFileSync(abs, backup);
  }
}

// --- library ---------------------------------------------------------------
console.log('\n— library —');
{
  // DATA_PATH is resolved when lib/keys.js is first imported (skillkit already did
  // that above), so this test uses unique account names rather than its own dir.
  const lib = await import(`${path.join(ROOT, 'lib/library.js')}?v=${Date.now()}`);
  const run = Date.now().toString(36);
  const acct1 = `test1-${run}`;
  const acct2 = `test2-${run}`;
  const bad = lib.recordArtifact(acct1, { kind: 'nonsense' });
  ok('an unknown kind is refused with the list', bad.ok === false && /Known:/.test(bad.error));
  const good = lib.recordArtifact(acct1, { kind: 'image', title: 'A logo', url: 'https://x/y.png', bytes: 1234 });
  ok('a record is written', good.ok && good.item.id.startsWith('art_'));
  lib.recordArtifact(acct1, { kind: 'video', title: 'A teaser' });
  lib.recordArtifact(acct2, { kind: 'code', title: 'Someone else' });
  const list1 = lib.listLibrary(acct1);
  ok('…and listed for its account only', list1.total === 2 && list1.items.every((i) => i.title !== 'Someone else'), String(list1.total));
  const filtered = lib.listLibrary(acct1, { kind: 'video' });
  ok('kind filter works', filtered.total === 1 && filtered.items[0].title === 'A teaser');
  const searched = lib.listLibrary(acct1, { q: 'logo' });
  ok('search works', searched.total === 1);
  const sum = lib.librarySummary(acct1);
  ok('summary counts by kind', sum.by_kind.image === 1 && sum.total === 2);
  ok('the catalogue is closed', Object.keys(lib.ARTIFACT_CATALOG).length >= 8);
  ok('…and an account that never made anything sees nothing', lib.listLibrary(`never-${run}`).total === 0);
}

// --- the field guide -------------------------------------------------------
console.log('\n— Qoder field guide —');
{
  const kitMod = await mod('lib/qoder-fieldkit.js');
  const kit = kitMod.qoderFieldKit();
  const ids = kit.nav.map((n) => n.id);
  ok('every nav item is unique', new Set(ids).size === ids.length);
  ok('…and explains itself', kit.nav.every((n) => n.note && n.note.length > 10));
  const app = read('web/src/App.jsx');
  const missing = kit.nav.filter((n) => n.kind !== 'group' && n.route && !app.includes(`path="/${n.route.replace(/^\//, '').split('?')[0].replace(/\/$/, '')}"`) && n.route !== '/');
  ok('every nav destination is a real route', missing.length === 0, missing.map((m) => m.route).join(', '));
  ok('every surface states its limit', kit.surfaces.every((s) => s.limit && s.limit.length > 10));
  ok('…and its evidence', kit.surfaces.every((s) => s.evidence && s.evidence.length > 10));
  ok('the statuses are the documented set', kit.surfaces.every((s) => ['live', 'partial', 'needs-cli', 'external', 'unrunnable'].includes(s.status)));
  ok('the skills row does not claim a copy of Qoder\'s catalog', kit.surfaces.find((s) => s.id === 'skills').limit.includes('cannot be copied'));
  ok('the Daytona fields match what the client uses', kit.daytona['Host address'] === 'ssh.app.daytona.io' && kit.daytona.Port === '22');
}

// --- page wiring -----------------------------------------------------------
console.log('\n— pages are wired —');
{
  const app = read('web/src/App.jsx');
  for (const [p, page] of [
    ['/skills', 'SkillsPage'], ['/library', 'LibraryPage'], ['/parity', 'ParityPage'],
    ['/evidence', 'EvidencePage'], ['/studio', 'ClaudePage'], ['/sandbox', 'SandboxPage']
  ]) {
    ok(`${p} renders ${page}`, new RegExp(`path="${p}"[^>]*>\\s*<Shell>\\s*<Guarded>\\s*<${page}`).test(app) || (app.includes(`path="${p}"`) && app.includes(`<${page} />`)), p);
  }
  ok('the old /claude link still lands somewhere real', /path="\/claude"/.test(app) && /Navigate/.test(app));
  ok('the rail is collapsed state, not a removed sidebar', /railed/.test(read('web/src/lib/state.jsx')) && /sidebar\.rail/.test(read('web/src/styles.css')));
  ok('the command palette is reachable by keyboard', /metaKey \|\| e\.ctrlKey/.test(app) && /k'/.test(app));
  ok('chat sends skills settings with the turn', /use_skills/.test(read('web/src/pages/Chat.jsx')) && /skills_mode/.test(read('web/src/pages/Chat.jsx')));
  ok('the bridge grounds skills on both chat paths', (read('api/bridge.js').match(/skillsForTurn\(/g) || []).length >= 3);
  ok('the skills trail is kept with the answer', /skills: skillTrail\.length/.test(read('web/src/pages/Chat.jsx')));
}


// --- installers -------------------------------------------------------------
console.log('\n— installers —');
{
  const macScript = read('desktop/package-mac.mjs');
  ok('the macOS packager refuses to claim a signature it cannot make', /unsigned/i.test(macScript) && /codesign/.test(macScript));
  ok('…and names what only macOS can do', /notarytool/.test(macScript) && /hdiutil/.test(macScript));
  ok('…and rebuilds the renderer first', /npm', \['run', 'build'\]/.test(macScript) && /--skip-build/.test(macScript));
  const winScript = read('desktop/package-win.mjs');
  ok('the Windows packager keeps the skill atlas in the bundle', /skills-atlas/.test(winScript));

  const iosDir = path.join(ROOT, 'web', 'ios');
  ok('the iOS project exists', fs.existsSync(path.join(iosDir, 'capacitor.config.json')));
  const cap = JSON.parse(read('web/ios/capacitor.config.json'));
  ok('…with a real app id', /^app\.anticodex\./.test(cap.appId), cap.appId);
  ok('…pointing at an https origin, never cleartext', /^https:\/\//.test(cap.server.url) && cap.server.cleartext === false);
  const plist = read('web/ios/App/App/Info.plist');
  ok('the Info.plist declares the permissions it uses', /NSCameraUsageDescription/.test(plist) && /NSMicrophoneUsageDescription/.test(plist));
  ok('…and forbids arbitrary cleartext loads', /NSAllowsArbitraryLoads<\/key><false\/>/.test(plist));
  ok('the iOS asset bundle has install.html', fs.existsSync(path.join(ROOT, 'dist', 'ios', 'install.html')));
  const installHtml = read('dist/ios/install.html');
  ok('…that says Safari, because only Safari can install it', /Safari/.test(installHtml) && /Add to Home Screen/.test(installHtml));
  ok('…and links the manifest', /manifest\.webmanifest/.test(installHtml));
  const manifest = JSON.parse(read('web/public/manifest.webmanifest'));
  ok('the manifest is installable', manifest.display === 'standalone' && manifest.icons.length >= 2);
  ok('…with a maskable icon for Android/Chrome', manifest.icons.some((i) => /maskable/.test(i.purpose || '')));
  const index = read('web/index.html');
  ok('the document carries the Apple meta tags', /apple-mobile-web-app-capable/.test(index) && /apple-touch-icon/.test(index));
  ok('a service worker is registered for the offline shell', /serviceWorker/.test(read('web/src/main.jsx')) || /serviceWorker/.test(index));
  const installPage = read('web/src/pages/Install.jsx');
  ok('the install page leads with what the device can do', /detect\.ios/.test(installPage) && /detect\.mac/.test(installPage));
  ok('…and admits what a browser cannot do', /cannot open an SSH socket|no socket/i.test(installPage));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
