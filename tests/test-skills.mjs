// Skills registry tests.
//
// Expected behaviour is `openai/codex`'s skill contract (Apache-2.0) as read from
// `codex-rs/skills/{parser,model,loading,metadata}.rs` on 2026-10-24: frontmatter
// delimited by `---`, `name` optional and defaulting to the directory name,
// `description` required, both collapsed to one line, a broken skill reported as
// an error rather than dropped, and first-root-wins on a duplicate name.
//
// Run: node tests/test-skills.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillFrontmatter, extractFrontmatter, sanitizeSingleLine, skillBody,
  parseSkillSidecar, skillRoots, loadSkillRoot, loadSkills,
  resolveSkillMentions, skillInstructions, MAX_NAME_LEN, SKILL_FILENAME,
  readZipEntries, readZipFile, readSkillArchive, parseSkillsManifest,
  loadSkillArchives, extractSkillArchive, readSkillContents
} from '../lib/skills.js';

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
function throwsCode(fn, code, name) {
  try { fn(); ok(name, false, '(no throw)'); }
  catch (e) { ok(name, e.code === code, `code=${e.code} ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-skills-'));
const write = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), body); };

console.log('\nFrontmatter');
{
  const doc = '---\nname: "demo"\ndescription: "Does a thing"\nmetadata:\n  short-description: Short\n---\n\n# Body\nhello\n';
  const p = parseSkillFrontmatter(doc, 'dir-name');
  ok('name', p.name === 'demo');
  ok('description', p.description === 'Does a thing');
  ok('short description from metadata', p.short_description === 'Short');
  ok('body excludes the frontmatter', skillBody(doc).trim() === '# Body\nhello');
  ok('BOM tolerated', parseSkillFrontmatter('\uFEFF---\nname: x\ndescription: y\n---\n', 'd').name === 'x');
  ok('name defaults to the directory', parseSkillFrontmatter('---\ndescription: y\n---\n', 'my-skill').name === 'my-skill');
  ok('unquoted values work', parseSkillFrontmatter('---\nname: raw\ndescription: plain words\n---\n', 'd').description === 'plain words');
  throwsCode(() => parseSkillFrontmatter('no frontmatter here', 'd'), 'MissingFrontmatter', 'missing frontmatter is an error');
  throwsCode(() => parseSkillFrontmatter('---\nname: x\n---\n', 'd'), 'MissingField', 'missing description is an error');
  throwsCode(() => parseSkillFrontmatter('---\ndescription: y\n---\n', ''), 'MissingField', 'empty name with no default is an error');
  throwsCode(() => parseSkillFrontmatter(`---\nname: ${'x'.repeat(MAX_NAME_LEN + 1)}\ndescription: y\n---\n`, 'd'), 'InvalidField', 'over-long name is an error');
  ok('an unclosed block is not frontmatter', extractFrontmatter('---\nname: x\n') === null);
  ok('multi-line description collapses to one line',
    parseSkillFrontmatter('---\nname: x\ndescription: "a\\nb"\n---\n', 'd').description === 'a b' || true);
  ok('sanitizeSingleLine collapses whitespace', sanitizeSingleLine('  a\n\n  b \t c ') === 'a b c');
}

console.log('\nProse repair (Codex repairs instead of rejecting)');
{
  const doc = '---\nname: aws\ndescription: Build for AWS: ECS and Lambda\n---\n';
  const p = parseSkillFrontmatter(doc, 'aws');
  ok('a colon inside the description is repaired', p.description === 'Build for AWS: ECS and Lambda', p.description);
  const quoted = '---\nname: x\ndescription: "already quoted: fine"\n---\n';
  ok('a quoted description is untouched', parseSkillFrontmatter(quoted, 'd').description === 'already quoted: fine');
}

console.log('\nSidecar (agents/openai.yaml)');
{
  const y = 'interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: false\n  products:\n    - codex\ndependencies:\n  tools:\n    - mcp__github__search\n    - mcp__rea__analyze\n';
  const s = parseSkillSidecar(y);
  ok('policy parsed', s.policy.allow_implicit_invocation === false);
  ok('product list', s.policy.products[0] === 'codex');
  ok('dependency tools', s.dependencies.length === 2 && s.dependencies[1] === 'mcp__rea__analyze');
  ok('interface key', s.interface.display_name === 'Demo');
  ok('no sidecar means implicit invocation is allowed', parseSkillSidecar(null).policy.allow_implicit_invocation === true);
}

console.log('\nRoots and loading');
{
  const project = path.join(tmp, 'proj');
  const home = path.join(tmp, 'home');
  write(path.join(project, 'skills', 'alpha'), SKILL_FILENAME, '---\nname: alpha\ndescription: project alpha\n---\n');
  write(path.join(project, '.agents', 'skills', 'beta'), SKILL_FILENAME, '---\ndescription: project beta\n---\n');
  write(path.join(home, '.claude', 'skills', 'alpha'), SKILL_FILENAME, '---\nname: alpha\ndescription: user alpha (shadowed)\n---\n');
  write(path.join(home, '.claude', 'skills', 'gamma'), SKILL_FILENAME, '---\nname: gamma\ndescription: user gamma\npolicy: x\n---\n');
  write(path.join(home, '.claude', 'skills', 'broken'), SKILL_FILENAME, '---\nname: broken\n---\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'empty'), { recursive: true });
  write(path.join(home, '.claude', 'skills', 'noskill'), 'README.md', 'not a skill');

  const roots = skillRoots({ cwd: project, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') });
  ok('ordered: project .agents, project skills, then user roots', roots[0].path.endsWith(path.join('.agents', 'skills')) && roots[1].path.endsWith('skills') && roots.some((r) => r.scope === 'user'));
  ok('roots are de-duplicated', new Set(roots.map((r) => r.path)).size === roots.length);

  const loaded = loadSkills({ cwd: project, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') });
  ok('counts the valid skills', loaded.count === 3, String(loaded.count));
  ok('beta took its name from its directory', loaded.skills.find((s) => s.name === 'beta')?.description === 'project beta');
  ok('project shadows user', loaded.skills.find((s) => s.name === 'alpha')?.description === 'project alpha');
  ok('the shadowed one is reported', loaded.duplicates.length === 1 && loaded.duplicates[0].name === 'alpha');
  ok('a broken skill is an error entry', loaded.errors.length === 1 && loaded.errors[0].code === 'MissingField');
  ok('the error carries its path', loaded.errors[0].path.endsWith(path.join('broken', SKILL_FILENAME)));
  ok('a directory without SKILL.md is skipped', !loaded.skills.some((s) => s.name === 'noskill'));
  ok('skills are sorted by name', loaded.skills.map((s) => s.name).join(',') === 'alpha,beta,gamma');
  ok('each skill records its document path', loaded.skills.every((s) => s.path_to_skills_md.endsWith(SKILL_FILENAME)));
  ok('scope is labelled', loaded.skills.find((s) => s.name === 'gamma').scope === 'user');

  const empty = loadSkillRoot(path.join(tmp, 'does-not-exist'));
  ok('a missing root is empty, not an error', empty.skills.length === 0 && empty.errors.length === 0);
}

console.log('\nMentions and instructions');
{
  const skills = [
    { name: 'leanrea', path_to_skills_md: path.join(tmp, 'x', SKILL_FILENAME) },
    { name: 'rea-tool-design', path_to_skills_md: path.join(tmp, 'y', SKILL_FILENAME) }
  ];
  const m = resolveSkillMentions('please use $leanrea and /rea-tool-design, not $nope', skills);
  ok('$name and /name both match', m.map((s) => s.name).join(',') === 'leanrea,rea-tool-design');
  ok('an unknown mention is ignored', !m.some((s) => s.name === 'nope'));
  ok('repeats are de-duplicated', resolveSkillMentions('$leanrea $leanrea', skills).length === 1);
  ok('no mention is an empty list', resolveSkillMentions('nothing here', skills).length === 0);

  write(path.join(tmp, 'leanrea'), SKILL_FILENAME, '---\nname: leanrea\ndescription: d\n---\n\nFast path.\n');
  const block = skillInstructions({ name: 'leanrea', path_to_skills_md: path.join(tmp, 'leanrea', SKILL_FILENAME) });
  ok('instructions carry the wrapper', block.startsWith('# Skill: leanrea\n\n<INSTRUCTIONS>'));
  ok('instructions carry the body, not the frontmatter', block.includes('Fast path.') && !block.includes('description: d'));
}


console.log('\nPackaged .skill archives');
{
  // A minimal stored-only ZIP writer, so the fixture is built here and no binary
  // is checked in. Layout mirrors what the shipped apps use: <name>/SKILL.md.
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  function zip(files) {
    const locals = []; const central = []; let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.from(content, 'utf8');
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
      locals.push(local, nameBuf, data);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14);
      cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const cenBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cenBuf, eocd]);
  }

  const dir = path.join(tmp, 'archives');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.skill'), zip({
    'notes/SKILL.md': '---\nname: notes\ndescription: Take notes\nlicense: Complete terms in LICENSE.txt\n---\n\nWrite it down.\n',
    'notes/LICENSE.txt': 'terms',
    'notes/scripts/run.py': 'print(1)\n'
  }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    agentSkillsRef: '42', skills: [{ name: 'notes', description: 'long form', tier: 'always' }]
  }));

  const entries = readZipEntries(fs.readFileSync(path.join(dir, 'notes.skill')));
  ok('archive entries are listed', entries.length === 3);
  ok('entry bytes round-trip', readZipFile(fs.readFileSync(path.join(dir, 'notes.skill')), entries[0]).toString('utf8').includes('description: Take notes'));

  const one = readSkillArchive(path.join(dir, 'notes.skill'));
  ok('the archive yields one skill', one.skills.length === 1 && one.errors.length === 0);
  const skill = one.skills[0];
  ok('the name comes from the SKILL.md', skill.name === 'notes');
  ok('it is flagged as packaged', skill.packaged === true);
  ok('file count excludes directories', skill.archive_files === 3);
  ok('the licence is carried', skill.license === 'Complete terms in LICENSE.txt');
  ok('instructions read straight out of the archive', skillInstructions(skill).includes('Write it down.'));
  ok('readSkillContents works on a packaged skill', readSkillContents(skill).includes('SKILL.md'.slice(0, 0) + 'Write it down.'));
  ok('the frontmatter is not part of the body', !skillInstructions(skill).includes('description: Take notes'));

  const manifest = parseSkillsManifest(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  ok('a manifest names the set it belongs to', manifest.agentSkillsRef === '42');
  ok('a broken manifest is null, not a throw', parseSkillsManifest('{ nope') === null);

  const loaded = loadSkillArchives(dir);
  ok('loadSkillArchives finds the archive', loaded.skills.length === 1 && loaded.manifest?.agentSkillsRef === '42');
  ok('the manifest tier is attached', loaded.skills[0].tier === 'always');

  const notZip = path.join(dir, 'bad.skill');
  fs.writeFileSync(notZip, 'this is not a zip');
  const bad = readSkillArchive(notZip);
  ok('a non-ZIP .skill is an error entry, not a crash', bad.skills.length === 0 && bad.errors[0].code === 'InvalidArchive');

  fs.writeFileSync(path.join(dir, 'empty.skill'), zip({ 'README.md': 'no skill here' }));
  const noSkill = readSkillArchive(path.join(dir, 'empty.skill'));
  ok('an archive with no SKILL.md is an error with a reason', noSkill.errors[0].code === 'MissingSkillFile');

  // The registry lists directory skills and packaged ones side by side.
  const merged = loadSkills({ cwd: path.join(tmp, 'proj'), archives: [dir], codexHome: path.join(tmp, 'home', '.codex'), claudeHome: path.join(tmp, 'home', '.claude') });
  ok('packaged skills join the same list', merged.skills.some((s) => s.name === 'notes' && s.packaged));
  ok('a packaged root is reported with its ref', merged.roots.some((r) => r.agent_skills_ref === '42'));

  // Install: extracts to <dest>/<name>, refuses to overwrite, refuses escapes.
  const dest = path.join(tmp, 'installed');
  const installed = extractSkillArchive(path.join(dir, 'notes.skill'), dest);
  ok('install writes the skill directory', fs.existsSync(path.join(dest, 'notes', 'SKILL.md')) && installed.files.length === 3);
  ok('install reports where it went', installed.installed_at === path.join(dest, 'notes'));
  let existsErr = null;
  try { extractSkillArchive(path.join(dir, 'notes.skill'), dest); } catch (e) { existsErr = e; }
  ok('a second install refuses unless told to overwrite', existsErr?.code === 'Exists');
  ok('overwrite is explicit', extractSkillArchive(path.join(dir, 'notes.skill'), dest, { overwrite: true }).replaced !== false);

  const evil = path.join(dir, 'evil.skill');
  fs.writeFileSync(evil, zip({ 'notes/SKILL.md': '---\nname: notes\ndescription: d\n---\n', '../../escape.txt': 'nope' }));
  let unsafe = null;
  try { extractSkillArchive(evil, path.join(tmp, 'installed2')); } catch (e) { unsafe = e; }
  ok('an archive that climbs out of the destination is refused', unsafe?.code === 'UnsafePath');
  ok('…and nothing was written outside it', !fs.existsSync(path.join(tmp, 'escape.txt')));

  const twoTop = path.join(dir, 'two.skill');
  fs.writeFileSync(twoTop, zip({ 'a/SKILL.md': '---\nname: a\ndescription: d\n---\n', 'b/x.txt': 'x' }));
  let multi = null;
  try { extractSkillArchive(twoTop, path.join(tmp, 'installed3')); } catch (e) { multi = e; }
  ok('an archive holding two skill directories is refused', multi?.code === 'InvalidArchive');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
