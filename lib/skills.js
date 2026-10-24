// ANTICODEX — skills registry.
//
// Contract taken from `openai/codex` (Apache-2.0), `codex-rs/skills` as read on
// 2026-10-24 — `parser.rs`, `model.rs`, `loading.rs`, `metadata.rs`:
//
//   * a skill is a directory containing `SKILL.md`;
//   * `SKILL.md` starts with `---`-delimited YAML frontmatter;
//   * fields: `name` (optional — defaults to the directory name, max 64 chars,
//     collapsed to one line), `description` (required, one line), and
//     `metadata.short-description` (optional);
//   * values are sanitised to a single line, and prose that breaks YAML (e.g.
//     `description: Build for AWS: ECS`) is repaired rather than rejected;
//   * an optional `agents/openai.yaml` sidecar carries `interface`,
//     `dependencies.tools[]` and `policy.allow_implicit_invocation`
//     (default **true**) / `policy.products[]`;
//   * a root yields `{ skills, errors }` — a broken skill is an *error entry*,
//     never a silent omission;
//   * skills live under directories named `skills`, and every skill carries its
//     `path_to_skills_md` and a `scope`.
//
// This is deliberately a parser for the subset that files actually use, not a
// general YAML engine: a full YAML parser would accept documents this product
// would then have to distrust.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const SKILL_FILENAME = 'SKILL.md';
export const SKILLS_DIR_NAME = 'skills';
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 2048;
const MAX_FRONTMATTER_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

class SkillParseError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Collapse every run of whitespace to one space — Codex does the same to both
 *  fields, so a multi-line description cannot leak into a list view. */
export function sanitizeSingleLine(raw) {
  return String(raw ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Extract the `---` block. Returns null when the document does not start with
 * `---` (Codex: `MissingFrontmatter`) or the block is never closed.
 */
export function extractFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { yaml: lines.slice(1, i).join('\n'), bodyOffset: i + 1, lines };
  }
  return null;
}

/** `key: value` at column 0, and the nested `metadata:` block. */
function parseFrontmatterFields(yaml) {
  const out = {};
  let section = null;
  for (const raw of yaml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+\S/.test(raw);
    const line = raw.trim();
    const eq = line.indexOf(':');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (!indented) {
      if (value === '') { section = key; out[key] = out[key] && typeof out[key] === 'object' ? out[key] : {}; continue; }
      section = null;
      out[key] = unquote(value);
      continue;
    }
    if (section) {
      if (!out[section] || typeof out[section] !== 'object') out[section] = {};
      out[section][key] = unquote(value);
    }
  }
  return out;
}

function unquote(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/**
 * Codex repairs prose scalars like `description: Build for AWS: ECS` instead of
 * failing the whole file. We only do it when the failure is a *bare* `key: value`
 * whose value contains `: ` — anything else stays a parse error.
 */
function repairProseScalars(yaml) {
  let changed = false;
  const repaired = yaml.split(/\r?\n/).map((line) => {
    if (/^\s/.test(line)) return line;
    const m = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
    if (!m) return line;
    const value = m[2];
    if (/^["'[{]/.test(value.trim())) return line;
    if (!/:/.test(value) && !/^[>|]/.test(value)) return line;
    changed = true;
    return `${m[1]}: ${JSON.stringify(value.trim())}`;
  }).join('\n');
  return changed ? repaired : null;
}

/**
 * @param {string} contents  the whole SKILL.md
 * @param {string} defaultName  directory name, used when `name` is absent
 * @returns {{name, description, short_description, code?:string}}
 */
export function parseSkillFrontmatter(contents, defaultName = 'skill') {
  if (String(contents ?? '').length > MAX_FRONTMATTER_BYTES * 8) {
    throw new SkillParseError('TooLarge', 'SKILL.md is larger than this registry will parse');
  }
  const fm = extractFrontmatter(contents);
  if (!fm) throw new SkillParseError('MissingFrontmatter', 'missing YAML frontmatter delimited by ---');
  if (Buffer.byteLength(fm.yaml) > MAX_FRONTMATTER_BYTES) {
    throw new SkillParseError('TooLarge', 'frontmatter is larger than 64 KiB');
  }

  let fields = parseFrontmatterFields(fm.yaml);
  if (!fields.name && !fields.description) {
    const repaired = repairProseScalars(fm.yaml);
    if (repaired) fields = parseFrontmatterFields(repaired);
  }

  const name = sanitizeSingleLine(fields.name) || sanitizeSingleLine(defaultName);
  if (!name) throw new SkillParseError('MissingField', 'missing field `name`');
  if (name.length > MAX_NAME_LEN) {
    throw new SkillParseError('InvalidField', `invalid name: longer than ${MAX_NAME_LEN} characters`);
  }
  if (!/^[\w .:@+-]+$/.test(name)) {
    throw new SkillParseError('InvalidField', 'invalid name: unexpected characters');
  }

  const description = sanitizeSingleLine(fields.description);
  if (!description) throw new SkillParseError('MissingField', 'missing field `description`');
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new SkillParseError('InvalidField', `invalid description: longer than ${MAX_DESCRIPTION_LEN} characters`);
  }

  const shortRaw = fields.metadata && typeof fields.metadata === 'object' ? fields.metadata['short-description'] ?? fields.metadata.short_description : null;
  const short_description = sanitizeSingleLine(shortRaw) || undefined;
  // `license:` is not part of Codex's own contract, but both packaged skills
  // observed in the wild (Claude Desktop's `bundled-skills/*.skill`) carry it, so
  // it is read rather than dropped: a list view can then say what it is under.
  const license = sanitizeSingleLine(fields.license) || null;

  return { name, description, short_description, license, frontmatter: fm.yaml };
}

/** Body after the closing `---` (what the agent actually reads). */
export function skillBody(contents) {
  const fm = extractFrontmatter(contents);
  if (!fm) return String(contents ?? '');
  return fm.lines.slice(fm.bodyOffset).join('\n').replace(/^\s*\n/, '');
}

/** The SKILL.md behind a skill, whether it sits on disk or inside a `.skill`. */
export function readSkillContents(skill) {
  if (!skill) return null;
  if (skill.archive && /#/.test(skill.path_to_skills_md || '')) {
    try {
      const buf = fs.readFileSync(skill.archive);
      const entryName = String(skill.path_to_skills_md).split('#').pop();
      const entry = readZipEntries(buf).find((e) => e.name === entryName);
      return entry ? readZipFile(buf, entry).toString('utf8') : null;
    } catch { return null; }
  }
  return readText(skill.path_to_skills_md);
}

// ---------------------------------------------------------------------------
// agents/openai.yaml sidecar
// ---------------------------------------------------------------------------

/** Minimal reader for the sidecar's shape (policy + dependency tool names). */
export function parseSkillSidecar(text) {
  const out = { interface: null, dependencies: [], policy: { allow_implicit_invocation: true, products: [] } };
  if (!text) return out;
  let section = null;
  let subsection = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    const eq = line.indexOf(':');
    if (eq === -1) {
      const item = line.replace(/^-\s*/, '');
      if (item && subsection === 'tools' && section === 'dependencies') out.dependencies.push(unquote(item));
      else if (item && subsection === 'products' && section === 'policy') out.policy.products.push(unquote(item));
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (indent === 0) { section = key; subsection = null; if (key === 'interface') out.interface = {}; continue; }
    if (section === 'policy' && key === 'allow_implicit_invocation') {
      out.policy.allow_implicit_invocation = value !== 'false';
    } else if (section === 'policy' && key === 'products') {
      subsection = 'products';
    } else if (section === 'dependencies' && key === 'tools') {
      subsection = 'tools';
    } else if (section === 'interface' && out.interface) {
      out.interface[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Roots and loading
// ---------------------------------------------------------------------------

/**
 * Ordered roots. Earlier roots win on a name collision, so a project's own
 * skills shadow the user's, which shadow the bundled ones.
 */
export function skillRoots({ cwd, codexHome, claudeHome, extra = [] } = {}) {
  const roots = [];
  const add = (dir, scope, label) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (roots.some((r) => r.path === abs)) return;
    roots.push({ path: abs, scope, label });
  };
  if (cwd) {
    add(path.join(cwd, '.agents', SKILLS_DIR_NAME), 'project', 'project .agents');
    add(path.join(cwd, SKILLS_DIR_NAME), 'project', 'project skills');
  }
  const ch = claudeHome || path.join(os.homedir(), '.claude');
  const cd = codexHome || path.join(os.homedir(), '.codex');
  add(path.join(cd, SKILLS_DIR_NAME), 'user', '~/.codex');
  add(path.join(ch, SKILLS_DIR_NAME), 'user', '~/.claude');
  for (const e of extra) add(e, 'bundled', 'bundled');
  return roots;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Load one root. A directory without `SKILL.md` is skipped; a `SKILL.md` that
 * fails validation becomes an entry in `errors` (Codex's `SkillError`), so the
 * UI can show *why* a skill did not load instead of it vanishing.
 */
export function loadSkillRoot(rootPath, { scope = 'user', maxSkills = 500 } = {}) {
  const skills = [];
  const errors = [];
  let entries = [];
  try { entries = fs.readdirSync(rootPath, { withFileTypes: true }); } catch { return { root: rootPath, scope, skills, errors }; }

  for (const entry of entries.slice(0, maxSkills)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const dir = path.join(rootPath, entry.name);
    const docPath = path.join(dir, SKILL_FILENAME);
    const contents = readText(docPath);
    if (contents == null) continue;

    try {
      const parsed = parseSkillFrontmatter(contents, entry.name);
      const sidecar = parseSkillSidecar(readText(path.join(dir, 'agents', 'openai.yaml')));
      skills.push({
        name: parsed.name,
        description: parsed.description,
        short_description: parsed.short_description,
        dir,
        path_to_skills_md: docPath,
        scope,
        bytes: Buffer.byteLength(contents),
        allow_implicit_invocation: sidecar.policy.allow_implicit_invocation,
        dependencies: sidecar.dependencies,
        products: sidecar.policy.products,
        interface: sidecar.interface
      });
    } catch (e) {
      errors.push({ path: docPath, dir, code: e.code || 'InvalidYaml', message: String(e.message || e) });
    }
  }
  return { root: rootPath, scope, skills, errors };
}

/** Load every root; first definition of a name wins, later duplicates are noted. */
export function loadSkills(opts = {}) {
  const roots = skillRoots(opts);
  const archiveRoots = (opts.archives || []).filter(Boolean).map((d) => path.resolve(d));
  const byName = new Map();
  const skills = [];
  const errors = [];
  const duplicates = [];
  const rootSummaries = [];

  for (const root of roots) {
    const loaded = loadSkillRoot(root.path, { scope: root.scope });
    rootSummaries.push({ path: root.path, scope: root.scope, label: root.label, skills: loaded.skills.length, errors: loaded.errors.length, exists: fs.existsSync(root.path) });
    for (const skill of loaded.skills) {
      skill.root_label = root.label;
      if (byName.has(skill.name)) {
        duplicates.push({ name: skill.name, kept: byName.get(skill.name).path_to_skills_md, ignored: skill.path_to_skills_md });
        continue;
      }
      byName.set(skill.name, skill);
      skills.push(skill);
    }
    errors.push(...loaded.errors);
  }

  // Packaged `.skill` archives load last: a directory the user can edit always
  // wins over one they cannot, and the archive is still visible under its own
  // `packaged` flag when its name is taken.
  for (const dir of archiveRoots) {
    const archives = loadSkillArchives(dir, { scope: 'bundled' });
    rootSummaries.push({
      path: dir, scope: 'bundled', label: 'packaged .skill',
      skills: archives.skills.length, errors: archives.errors.length, exists: fs.existsSync(dir),
      agent_skills_ref: archives.manifest?.agentSkillsRef ?? null
    });
    for (const skill of archives.skills) {
      if (byName.has(skill.name)) {
        duplicates.push({ name: skill.name, kept: byName.get(skill.name).path_to_skills_md, ignored: skill.path_to_skills_md });
        continue;
      }
      byName.set(skill.name, skill);
      skills.push(skill);
    }
    errors.push(...archives.errors);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors, duplicates, roots: rootSummaries, count: skills.length };
}

/**
 * `$skill-name` (or `/skill-name`) in a message, the way Codex resolves a skill
 * mention. Returns the skills it matched, in mention order, de-duplicated.
 */
export function resolveSkillMentions(text, skills = []) {
  const found = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/(?:^|\s)[$/]([A-Za-z0-9][\w.:-]*)/g)) {
    const name = m[1];
    const skill = skills.find((s) => s.name === name);
    if (skill && !seen.has(skill.name)) { seen.add(skill.name); found.push(skill); }
  }
  return found;
}

/** The block the model receives for one skill: its frontmatter plus body. */
export function skillInstructions(skill) {
  const contents = readSkillContents(skill) ?? '';
  return `# Skill: ${skill.name}\n\n<INSTRUCTIONS>\n${skillBody(contents)}\n</INSTRUCTIONS>`;
}

// ---------------------------------------------------------------------------
// Packaged skills (`.skill` archives)
// ---------------------------------------------------------------------------
//
// A `.skill` file is what the shipped desktop apps hand around: a ZIP whose root
// holds exactly one directory `<name>/` with a `SKILL.md` (plus `LICENSE.txt` and
// any `scripts/`). Claude Desktop 2.42304.0 ships six of them next to a
// `manifest.json` that names each skill, its long description and a `tier`
// ("always" = preloaded without a mention); the ChatGPT package registers the
// extension itself, so double-clicking a `.skill` is an install.
//
// The contract adopted here is only that: an archive is a *container* for the
// same `SKILL.md` a directory root holds, so one list can show both. Nothing is
// executed on listing, and extraction is path-checked because the archive comes
// from outside this machine.

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Central-directory entries of a ZIP. Supports stored (0) and deflate (8). */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new SkillParseError('InvalidArchive', 'not a ZIP archive');
  if (buf.length > MAX_ARCHIVE_BYTES) throw new SkillParseError('TooLarge', 'archive is larger than this registry will read');
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new SkillParseError('InvalidArchive', 'no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ARCHIVE_ENTRIES) throw new SkillParseError('TooLarge', `archive has ${count} entries`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL) {
      throw new SkillParseError('InvalidArchive', 'corrupt central directory');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, size, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, inflated on demand. */
export function readZipFile(buf, entry) {
  if (entry.size > MAX_ENTRY_BYTES) throw new SkillParseError('TooLarge', `${entry.name} is larger than 32 MiB`);
  const at = entry.localOff;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) {
    throw new SkillParseError('InvalidArchive', `bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }); }
    catch (e) { throw new SkillParseError('InvalidArchive', `cannot inflate ${entry.name}: ${e.message}`); }
  }
  throw new SkillParseError('InvalidArchive', `unsupported compression method ${entry.method} for ${entry.name}`);
}

/** A path that stays inside the destination, so an archive cannot write out. */
function safeRelative(name) {
  const norm = path.posix.normalize(String(name).replace(/\\/g, '/'));
  if (!norm || norm === '.' || norm.startsWith('../') || norm.startsWith('/') || path.isAbsolute(norm)) return null;
  if (norm.split('/').includes('..')) return null;
  return norm;
}

/**
 * Read one `.skill` archive without extracting it.
 * @returns {{archive, skills: Array<object>, errors: Array<object>}}
 */
export function readSkillArchive(file, { scope = 'bundled', manifest = null, tier = null } = {}) {
  const skills = [];
  const errors = [];
  let entries = [];
  let buf;
  try {
    buf = fs.readFileSync(file);
    entries = readZipEntries(buf);
  } catch (e) {
    return { archive: file, skills, errors: [{ path: file, code: e.code || 'InvalidArchive', message: String(e.message || e) }] };
  }
  if (!entries.length) {
    return { archive: file, skills, errors: [{ path: file, code: 'InvalidArchive', message: 'empty archive' }] };
  }

  const doc = entries.find((e) => /^[^/]+\/SKILL\.md$/.test(e.name));
  if (!doc) {
    return { archive: file, skills, errors: [{ path: file, code: 'MissingSkillFile', message: 'no <name>/SKILL.md inside the archive' }] };
  }

  const dirName = doc.name.split('/')[0];
  try {
    const text = readZipFile(buf, doc).toString('utf8');
    const parsed = parseSkillFrontmatter(text, dirName);
    const declared = (manifest?.skills || []).find((s) => s.name === parsed.name) || null;
    skills.push({
      name: parsed.name,
      description: parsed.description,
      short_description: parsed.short_description,
      license: parsed.license,
      dir: null,
      path_to_skills_md: `${file}#${doc.name}`,
      scope,
      bytes: Buffer.byteLength(text),
      allow_implicit_invocation: tier === 'on-demand' ? false : true,
      dependencies: [],
      products: [],
      interface: null,
      packaged: true,
      archive: file,
      archive_bytes: buf.length,
      archive_files: entries.filter((e) => !e.name.endsWith('/')).length,
      tier: tier || declared?.tier || null,
      declared_description: declared?.description || null,
      root_label: 'packaged .skill'
    });
  } catch (e) {
    errors.push({ path: `${file}#${doc.name}`, code: e.code || 'InvalidSkill', message: String(e.message || e) });
  }
  return { archive: file, skills, errors };
}

/** `manifest.json` beside a set of archives: `{ agentSkillsRef, skills:[{name,description,tier}] }`. */
export function parseSkillsManifest(text) {
  if (!text) return null;
  try {
    const d = JSON.parse(String(text));
    if (!d || typeof d !== 'object') return null;
    return {
      agentSkillsRef: d.agentSkillsRef ?? d.agent_skills_ref ?? null,
      skills: Array.isArray(d.skills) ? d.skills.filter((s) => s && typeof s.name === 'string') : []
    };
  } catch { return null; }
}

/** Every `.skill` file in a directory, sorted, with that directory's manifest. */
export function loadSkillArchives(rootPath, { scope = 'bundled' } = {}) {
  const skills = [];
  const errors = [];
  let names = [];
  try { names = fs.readdirSync(rootPath).filter((n) => n.toLowerCase().endsWith('.skill')).sort(); }
  catch { return { root: rootPath, skills, errors, manifest: null }; }
  const manifest = parseSkillsManifest(readText(path.join(rootPath, 'manifest.json')));
  for (const name of names) {
    const one = readSkillArchive(path.join(rootPath, name), { scope, manifest });
    skills.push(...one.skills);
    errors.push(...one.errors);
  }
  return { root: rootPath, skills, errors, manifest };
}

/** Default location for packaged skills inside an install (before extraction). */
export function archiveSkillDirs({ cwd, extra = [] } = {}) {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(path.resolve(d))) dirs.push(path.resolve(d)); };
  if (cwd) add(path.join(cwd, SKILLS_DIR_NAME));
  for (const e of extra) add(e);
  return dirs;
}

/**
 * Extract one `.skill` into `<destRoot>/<name>/`, refusing anything that would
 * land outside it. Files are written only after every path has been checked.
 */
export function extractSkillArchive(file, destRoot, { overwrite = false } = {}) {
  const buf = fs.readFileSync(file);
  const entries = readZipEntries(buf);
  const files = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const rel = safeRelative(entry.name);
    if (!rel) throw new SkillParseError('UnsafePath', `archive entry escapes the destination: ${entry.name}`);
    files.push({ entry, rel });
  }
  if (!files.length) throw new SkillParseError('InvalidArchive', 'archive has no files');
  const top = files[0].rel.split('/')[0];
  if (!files.every((f) => f.rel.split('/')[0] === top)) {
    throw new SkillParseError('InvalidArchive', 'archive does not hold a single skill directory');
  }
  const target = path.join(destRoot, top);
  if (fs.existsSync(target) && !overwrite) {
    throw new SkillParseError('Exists', `${top} is already installed at ${target}`);
  }
  const written = [];
  for (const { entry, rel } of files) {
    const out = path.join(destRoot, rel);
    const resolved = path.resolve(out);
    if (!resolved.startsWith(path.resolve(destRoot) + path.sep)) {
      throw new SkillParseError('UnsafePath', `refusing to write outside ${destRoot}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, readZipFile(buf, entry));
    written.push(resolved);
  }
  return { name: top, installed_at: target, files: written };
}
