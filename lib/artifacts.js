// Artifact templates.
//
// The ChatGPT desktop app ships an MCP server called
// `openai_artifact_template_picker`: a tool-driven picker that offers Office and
// Google document/presentation/spreadsheet styles as pictures, and hands the
// chosen one back as a skill path. What makes it worth copying is not the
// picker, it is the checking that happens before anything is shown:
//
//   * a template is only real if `SKILL.md` sits in `…/skills/<artifact-template-*>/`,
//     the resolved directory really is inside the root it was found in,
//     and a namespaced name matches `.codex-plugin/plugin.json`'s owner;
//   * `artifact-template.json` must be schemaVersion 1, must declare the same
//     artifact kind the caller asked for, must point its reference at
//     `assets/reference.<ext>`, and for a Google-family template its source URL
//     must be the canonical `docs.google.com/<path>/d/<id>/edit`;
//   * the preview must resolve inside the template directory, be a real PNG
//     (magic bytes + IHDR), at most 8192 px on a side and inside a pixel budget.
//
// Everything below is that contract, written for this app: templates on disk,
// no upload endpoint, and the same refusals with reasons a UI can show. It reads
// the ChatGPT/Codex home only when the caller is local (see api/bridge.js), the
// same rule as the skills registry.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Artifact kinds the picker can offer. `google-*` are workspace flavours of the
// same three families, so a request for one accepts a template of the other.
export const ARTIFACT_KINDS = new Map([
  ['document', { extension: 'docx' }],
  ['presentation', { extension: 'pptx' }],
  ['spreadsheet', { extension: 'xlsx' }],
  ['google-docs', { family: 'document', workspacePath: 'document' }],
  ['google-slides', { family: 'presentation', workspacePath: 'presentation' }],
  ['google-sheets', { family: 'spreadsheet', workspacePath: 'spreadsheets' }]
]);

export const LIMITS = {
  templates: 100,
  offered: 10,
  request: 1000,
  metadataBytes: 64 * 1024,
  previewBytes: 8 * 1024 * 1024,
  totalPreviewBytes: 32 * 1024 * 1024,
  previewPixels: 16 * 1024 * 1024,
  totalPixels: 32 * 1024 * 1024,
  maxSide: 8192,
  displayName: 64
};

const TEMPLATE_NAME = /^artifact-template-[a-z0-9][a-z0-9._-]*$/u;
const PLUGIN_ID = /^[A-Za-z0-9_-]+$/u;

export const familyOf = (kind) =>
  ARTIFACT_KINDS.get(kind)?.family ?? (ARTIFACT_KINDS.has(kind) ? kind : undefined);
export const extensionOf = (kind) => ARTIFACT_KINDS.get(familyOf(kind))?.extension;

/** True when `filePath` is strictly below `directory` (no `..`, not the dir itself). */
export function isInside(directory, filePath) {
  const rel = path.relative(directory, filePath);
  return Boolean(rel) && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

/**
 * Read a file that must live inside `root` and stay small. Template metadata is
 * attacker-supplied by definition — it arrives with a downloaded template — so a
 * symlink out of the directory or a 2 GB "SKILL.md" is a refusal, not an error.
 */
export async function readTrustedText(root, relativePath, limit = LIMITS.metadataBytes) {
  const realPath = await fsp.realpath(path.join(root, relativePath));
  const stats = await fsp.stat(realPath);
  if (!isInside(await fsp.realpath(root), realPath) || !stats.isFile() || stats.size > limit) {
    const err = new Error(`refusing to read ${relativePath}: outside ${root} or too large`);
    err.code = 'UntrustedMetadata';
    throw err;
  }
  return fsp.readFile(realPath, 'utf8');
}

/** `https://docs.google.com/<workspacePath>/d/<id>/edit[?resourcekey=…]`, nothing else. */
export function isCanonicalGoogleUrl(value, workspacePath) {
  try {
    const url = new URL(value);
    const id = url.pathname.split('/')[3];
    const resourceKey = url.searchParams.get('resourcekey');
    if (url.protocol !== 'https:' || url.host !== 'docs.google.com') return false;
    return (
      id !== 'e' &&
      /^[A-Za-z0-9_-]+$/u.test(id ?? '') &&
      value ===
        `https://docs.google.com/${workspacePath}/d/${id}/edit${
          resourceKey == null ? '' : `?resourcekey=${encodeURIComponent(resourceKey)}`
        }`
    );
  } catch {
    return false;
  }
}

/** PNG dimensions from the IHDR chunk, or null when this is not a PNG. */
export function pngSize(head) {
  if (!Buffer.isBuffer(head) || head.length < 24) return null;
  if (head.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height, pixels: width * height };
}

/** Frontmatter `name:` / `description:` from a SKILL.md, without a YAML parser. */
export function parseSkillFrontmatter(source) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1] ?? '';
  const name = /^name:\s*["']?([^\s"']+)["']?\s*$/mu.exec(block)?.[1] ?? null;
  const description = /^description:\s*["']?(.+?)["']?\s*$/mu.exec(block)?.[1] ?? '';
  return { name, description, block };
}

/**
 * The two `interface:` keys the picker shows. Both come out of a YAML file, so
 * they are read as JSON scalars and anything that is not a string is dropped —
 * `icon_large: ../../etc` must not become a path, it must become nothing.
 */
export function parseInterface(metadata) {
  const scalar = (key) => {
    const raw = new RegExp(`^ {2}${key}:\\s*(.+?)\\s*$`, 'mu').exec(metadata ?? '')?.[1];
    if (raw == null) return null;
    try {
      const value = JSON.parse(raw);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  return { displayName: scalar('display_name'), iconLarge: scalar('icon_large') };
}

/**
 * Validate one template directory for a requested artifact kind.
 *
 * Returns `null` for "not a usable template of this kind" rather than throwing:
 * a directory that fails a check is simply not offered, which is what the real
 * picker does — one bad template must not break the list. Everything that is a
 * refusal *of the caller* (bad kind, bad request) is thrown by the callers below.
 */
export async function loadTemplate(
  directory,
  skillName,
  requestedKind,
  { withPreview = true, librarySkillId = null, personalRoot = null } = {}
) {
  try {
    const realDirectory = await fsp.realpath(directory);

    const source = await readTrustedText(realDirectory, 'SKILL.md');
    const frontmatter = parseSkillFrontmatter(source);

    // A personal template is installed under `skill-<library id>`, so its own
    // name comes from its SKILL.md. Everything else is named by its directory.
    const names = String(skillName ?? frontmatter.name ?? '').split(':');
    const name = names.at(-1);
    const owner = names.length === 2 ? names[0] : null;
    if (names.length > 2 || !TEMPLATE_NAME.test(name ?? '')) return null;
    if (owner != null && (!PLUGIN_ID.test(owner) || owner.length > 512)) return null;
    // The skill names itself; if it disagrees with the name it was found under,
    // the picker would show something other than what it resolves to.
    if (frontmatter.name != null && frontmatter.name !== name) return null;

    const personal =
      owner == null &&
      librarySkillId != null &&
      personalRoot != null &&
      path.basename(realDirectory) === `skill-${librarySkillId}` &&
      path.dirname(realDirectory) === (await fsp.realpath(personalRoot));
    if (!personal && (path.basename(realDirectory) !== name || path.basename(path.dirname(realDirectory)) !== 'skills')) {
      return null;
    }
    if (personal && path.basename(realDirectory) !== `skill-${librarySkillId}`) return null;

    // A namespaced template belongs to a plugin, and the plugin says so itself.
    const pluginDirectory = path.dirname(path.dirname(realDirectory));
    let plugin = null;
    try {
      plugin = JSON.parse(await readTrustedText(pluginDirectory, path.join('.codex-plugin', 'plugin.json')));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'UntrustedMetadata') return null;
    }
    if ((plugin?.name ?? null) !== owner) return null;

    let manifest;
    try {
      manifest = JSON.parse(await readTrustedText(realDirectory, 'artifact-template.json'));
    } catch {
      return null;
    }
    const kind = ARTIFACT_KINDS.get(manifest?.kind);
    const requestedFamily = familyOf(requestedKind);
    if (requestedFamily == null) return null;
    if (manifest?.schemaVersion !== 1 || !kind) return null;
    if (familyOf(manifest.kind) !== requestedFamily) return null;
    if (manifest.reference !== `assets/reference.${kind.extension ?? 'png'}`) return null;
    if (kind.family && !isCanonicalGoogleUrl(manifest.sourceUrl, kind.workspacePath)) return null;

    let metadata = '';
    try {
      metadata = await readTrustedText(realDirectory, path.join('agents', 'openai.yaml'));
    } catch {
      return null;
    }
    const { displayName, iconLarge } = parseInterface(metadata);
    if (!displayName || !displayName.trim() || !iconLarge || path.isAbsolute(iconLarge)) return null;

    const reference = await fsp.realpath(path.join(realDirectory, manifest.reference));
    const previewPath = await fsp.realpath(path.resolve(realDirectory, iconLarge));
    if (!isInside(realDirectory, reference) || !isInside(realDirectory, previewPath)) return null;
    if (path.extname(previewPath).toLowerCase() !== '.png') return null;
    if (typeof manifest.preview === 'string' && path.resolve(realDirectory, manifest.preview) !== previewPath) return null;

    const [referenceStats, previewStats] = await Promise.all([fsp.stat(reference), fsp.stat(previewPath)]);
    if (!referenceStats.isFile() || !previewStats.isFile()) return null;
    if (previewStats.size < 45 || previewStats.size > LIMITS.previewBytes) return null;

    const handle = await fsp.open(previewPath, 'r');
    let head;
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      head = bytesRead === header.length ? header : null;
    } finally {
      await handle.close();
    }
    const size = pngSize(head);
    if (!size || Math.max(size.width, size.height) > LIMITS.maxSide || size.pixels > LIMITS.previewPixels) return null;

    return {
      artifactKind: manifest.kind,
      skillName: names.join(':'),
      unqualifiedSkillName: name,
      title: displayName,
      description: frontmatter.description,
      skillPath: path.join(realDirectory, 'SKILL.md'),
      directory: realDirectory,
      pixels: size.pixels,
      width: size.width,
      height: size.height,
      previewPath,
      // The bytes are only read when someone is going to look at them; listing a
      // hundred templates should not read a hundred images.
      preview: withPreview ? await fsp.readFile(previewPath) : null
    };
  } catch {
    return null;
  }
}

/** Where templates live: personal skills first, then installed plugin caches. */
export function templateRoots(codexHome = path.join(os.homedir(), '.codex')) {
  return {
    personal: path.join(codexHome, 'skills', 'remote-skills'),
    plugins: path.join(codexHome, 'plugins', 'cache'),
    codexHome
  };
}

/**
 * Everything usable for one artifact kind, personal templates before plugins,
 * de-duplicated by kind+name and capped. Reading order is deliberate: a personal
 * template wins over a plugin template with the same name, so a user can shadow
 * a downloaded style instead of being ambushed by it.
 */
export async function discoverTemplates({ codexHome, artifactKind, limit = LIMITS.templates } = {}) {
  const roots = templateRoots(codexHome);
  const found = [];
  const identities = new Set();

  const push = (template) => {
    if (!template) return false;
    const identity = `${template.artifactKind}:${template.skillName}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    found.push(template);
    return true;
  };

  let entries = [];
  try {
    entries = await fsp.readdir(roots.personal, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    const match = /^skill-([A-Za-z0-9_+-]+={0,2})$/u.exec(entry.name);
    if (!entry.isDirectory() || match == null || match[1].length > 255) continue;
    push(
      await loadTemplate(path.join(roots.personal, entry.name), null, artifactKind, {
        librarySkillId: match[1],
        personalRoot: roots.personal
      })
    );
    if (found.length === limit) return found;
  }

  let marketplaces = [];
  try {
    marketplaces = await fsp.readdir(roots.plugins, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw err;
  }
  for (const marketplace of marketplaces.slice(0, 32)) {
    if (!marketplace.isDirectory()) continue;
    let plugins = [];
    try {
      plugins = await fsp.readdir(path.join(roots.plugins, marketplace.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins.slice(0, limit)) {
      if (!plugin.isDirectory()) continue;
      const pluginRoot = path.join(roots.plugins, marketplace.name, plugin.name);
      let version;
      let skillEntries;
      try {
        const versions = (await fsp.readdir(pluginRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
        // Exactly one installed version: two versions is an ambiguous install,
        // and guessing which one the user means is how a template picker picks a
        // template the user never chose.
        if (versions.length !== 1) continue;
        version = path.join(pluginRoot, versions[0].name);
        const manifest = JSON.parse(await readTrustedText(version, path.join('.codex-plugin', 'plugin.json')));
        if (manifest.name !== plugin.name) continue;
        skillEntries = await fsp.readdir(path.join(version, 'skills'), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of skillEntries) {
        if (!entry.isDirectory() || !TEMPLATE_NAME.test(entry.name)) continue;
        push(await loadTemplate(path.join(version, 'skills', entry.name), `${plugin.name}:${entry.name}`, artifactKind));
        if (found.length === limit) return found;
      }
    }
  }
  return found;
}

/**
 * Turn candidates into the card list a picker shows: at most ten, unique ids, and
 * a preview budget across the whole list — one 8 MB image per card would be a
 * denial of service dressed as a nice grid.
 */
export function offer(templates, { limit = LIMITS.offered } = {}) {
  const cards = [];
  const ids = new Set();
  let bytes = 0;
  let pixels = 0;
  for (const template of templates) {
    if (cards.length >= limit) break;
    const id = `artifact-template:${encodeURIComponent(template.skillName)}`;
    if (ids.has(id)) continue;
    const previewBytes = template.preview ? template.preview.length : 0;
    bytes += previewBytes;
    pixels += template.pixels;
    if (bytes > LIMITS.totalPreviewBytes || pixels > LIMITS.totalPixels) {
      const err = new Error('template previews exceed the allowed size');
      err.code = 'PreviewsTooLarge';
      throw err;
    }
    ids.add(id);
    cards.push({
      id,
      skillName: template.skillName,
      title: template.title,
      description: template.description,
      artifactKind: template.artifactKind,
      width: template.width,
      height: template.height,
      preview: previewBytes ? `data:image/png;base64,${template.preview.toString('base64')}` : null
    });
  }
  return cards;
}

/** Request validation shared by list and choose — same limits as the real server. */
export function normalizeRequest(artifactKind, request) {
  if (!ARTIFACT_KINDS.has(artifactKind)) {
    const err = new Error('unknown artifact kind');
    err.code = 'InvalidArtifactKind';
    throw err;
  }
  if (request == null) return '';
  if (typeof request !== 'string' || !request.trim() || Array.from(request).length > LIMITS.request) {
    const err = new Error('invalid template request');
    err.code = 'InvalidRequest';
    throw err;
  }
  return request.trim();
}

/**
 * Resolve a card id (or a plain skill name, as the model would echo it) back to
 * the one template it names. Ambiguity is refused: two templates answering to
 * the same name must not silently become "the first one".
 */
export function resolveSelection(templates, selection) {
  if (typeof selection !== 'string' || !selection) {
    const err = new Error('selected template is unavailable');
    err.code = 'Unavailable';
    throw err;
  }
  let wanted = selection;
  if (wanted.startsWith('artifact-template:')) {
    try {
      wanted = decodeURIComponent(wanted.slice('artifact-template:'.length));
    } catch {
      const err = new Error('selected template is unavailable');
      err.code = 'Unavailable';
      throw err;
    }
  }
  const matches = templates.filter(
    (t) => t.skillName === wanted || t.unqualifiedSkillName === wanted || t.skillPath === wanted
  );
  if (matches.length !== 1) {
    const err = new Error(matches.length ? 'more than one template matches that name' : 'selected template is unavailable');
    err.code = matches.length ? 'Ambiguous' : 'Unavailable';
    throw err;
  }
  const [template] = matches;
  return {
    status: 'selected',
    artifactKind: template.artifactKind,
    skillName: template.skillName,
    title: template.title,
    skillPath: template.skillPath
  };
}

/** `quarterly_report.docx` → `Quarterly Report`, the default save name in the real flow. */
export function suggestDisplayName(filePath) {
  return path
    .basename(String(filePath), path.extname(String(filePath)))
    .replace(/[_-]+/gu, ' ')
    .trim()
    .replace(/(?:^|\s)\p{L}/gu, (s) => s.toUpperCase())
    .slice(0, LIMITS.displayName);
}

/** A template name has to be printable, non-empty and actually contain a letter. */
export function validateDisplayName(value) {
  if (typeof value !== 'string') return null;
  if (value !== value.trim() || value.length > LIMITS.displayName) return null;
  if (/[<>\0\r\n]/u.test(value)) return null;
  if (!/[A-Za-z0-9]/u.test(value.normalize('NFKD'))) return null;
  return value;
}
