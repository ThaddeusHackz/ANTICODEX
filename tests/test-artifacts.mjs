// Tests for the artifact template picker (lib/artifacts.js).
//
// The fixtures are what the ChatGPT app expects to find on disk, including the
// shapes that must be refused: a template whose reference escapes its directory,
// a plugin template whose owner disagrees with plugin.json, a PNG that is only a
// PNG by extension, and a Google template pointed at a non-canonical URL.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_KINDS,
  LIMITS,
  discoverTemplates,
  extensionOf,
  familyOf,
  isCanonicalGoogleUrl,
  isInside,
  loadTemplate,
  normalizeRequest,
  offer,
  parseInterface,
  parseSkillFrontmatter,
  pngSize,
  readTrustedText,
  resolveSelection,
  suggestDisplayName,
  templateRoots,
  validateDisplayName
} from '../lib/artifacts.js';
import {
  CREATE_TARGETS,
  LIBRARY_KEYS,
  SORT_OPTIONS,
  TIME_FILTERS,
  atMs,
  dataUrlBytes,
  downloadPlan,
  filterRecords,
  formatBytes,
  libraryExport,
  mediaUrl,
  readLibrary,
  recordBytes,
  recordExport,
  recordUid,
  removeRecords,
  sinceFor,
  sortRecords,
  sourceOf,
  summarize,
  titleOf
} from '../web/src/library.js';

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

// A real 1×1 PNG (68 bytes) — the same fixture the shipped test suite uses.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
);

async function writeTemplate(dir, name, overrides = {}) {
  const kind = overrides.kind ?? 'document';
  // A Google-family template's reference is still `assets/reference.png`: the
  // workspace kinds inherit their family's file type but declare no extension.
  const ext = ARTIFACT_KINDS.get(kind).extension ?? 'png';
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${overrides.description ?? 'Create a document using the smoke template.'}\n---\n\nBody.\n`
  );
  await fs.writeFile(
    path.join(dir, 'artifact-template.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind,
      reference: `assets/reference.${ext}`,
      preview: 'assets/preview.png',
      ...(overrides.manifest ?? {})
    })
  );
  await fs.writeFile(
    path.join(dir, 'agents', 'openai.yaml'),
    `interface:\n  display_name: ${JSON.stringify(overrides.title ?? 'Smoke template')}\n  icon_large: ${JSON.stringify(
      overrides.icon ?? 'assets/preview.png'
    )}\n`
  );
  await fs.writeFile(path.join(dir, 'assets', `reference.${ext}`), 'fixture');
  await fs.writeFile(path.join(dir, 'assets', 'preview.png'), overrides.preview ?? PNG);
  return dir;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acx-artifacts-'));
const home = path.join(tmp, 'codex');
const personal = path.join(home, 'skills', 'remote-skills');
// A plain install: `…/skills/<artifact-template-*>/`, the shape a plugin uses.
const plain = (name, overrides = {}) => writeTemplate(path.join(tmp, 'plain', 'skills', name), name, overrides);

section('artifact kinds');
{
  ok('the three Office kinds carry their extensions', extensionOf('document') === 'docx' && extensionOf('presentation') === 'pptx' && extensionOf('spreadsheet') === 'xlsx');
  ok('Google kinds are flavours of the same families', familyOf('google-slides') === 'presentation' && extensionOf('google-sheets') === 'xlsx');
  ok('an unknown kind has no family', familyOf('video') === undefined);
  ok('…so a request for one cannot match a template', familyOf('video') !== familyOf('document'));
  ok('the kind table has six entries', ARTIFACT_KINDS.size === 6);
}

section('containment');
{
  ok('a file below the directory is inside', isInside('/a/b', '/a/b/c/d.txt'));
  ok('…the directory itself is not', isInside('/a/b', '/a/b') === false);
  ok('…a sibling with a common prefix is not', isInside('/a/b', '/a/bc/d') === false);
  ok('…and neither is a traversal', isInside(path.join(tmp, 'x'), path.join(tmp, 'x', '..', 'y')) === false);
}

section('metadata is read defensively');
{
  await fs.mkdir(path.join(tmp, 'trusted'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'trusted', 'ok.md'), 'hello');
  await fs.writeFile(path.join(tmp, 'outside.md'), 'secret');
  ok('a file inside the root is read', (await readTrustedText(path.join(tmp, 'trusted'), 'ok.md')) === 'hello');
  let refused = false;
  try {
    await readTrustedText(path.join(tmp, 'trusted'), '../outside.md');
  } catch (e) {
    refused = e.code === 'UntrustedMetadata';
  }
  ok('a relative traversal is refused with a reason', refused);
  let symlinked = false;
  try {
    await fs.symlink(path.join(tmp, 'outside.md'), path.join(tmp, 'trusted', 'link.md'));
    await readTrustedText(path.join(tmp, 'trusted'), 'link.md');
  } catch (e) {
    symlinked = e.code === 'UntrustedMetadata';
  }
  ok('a symlink out of the root is refused', symlinked);
  ok('the size cap is the template metadata cap', LIMITS.metadataBytes === 64 * 1024);
}

section('PNG headers');
{
  const size = pngSize(PNG);
  ok('a real PNG reports its size', size?.width === 1 && size?.height === 1 && size.pixels === 1);
  ok('a JPEG is not a PNG', pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === null);
  const noIhdr = Buffer.alloc(24);
  PNG.copy(noIhdr, 0, 0, 24);
  noIhdr.write('XXXX', 12, 'ascii');
  ok('a PNG-shaped file without IHDR is refused', pngSize(noIhdr) === null);
  ok('a zero-width PNG is refused', pngSize(Buffer.alloc(0)) === null);
}

section('frontmatter and interface');
{
  const fm = parseSkillFrontmatter('---\nname: artifact-template-x\ndescription: "Create a document using X."\n---\nbody');
  ok('name is parsed', fm.name === 'artifact-template-x');
  ok('description is parsed', fm.description === 'Create a document using X.');
  ok('a file with no frontmatter yields no name', parseSkillFrontmatter('just text').name === null);
  const ui = parseInterface('interface:\n  display_name: "Deck"\n  icon_large: "assets/preview.png"\n');
  ok('display_name and icon_large are parsed', ui.displayName === 'Deck' && ui.iconLarge === 'assets/preview.png');
  const numeric = parseInterface('interface:\n  display_name: 12\n  icon_large: "a.png"\n');
  ok('a non-string title is dropped rather than stringified', numeric.displayName === null);
  ok('a missing key is null', parseInterface('').iconLarge === null);
}

section('Google URLs');
{
  ok('the canonical edit URL is accepted', isCanonicalGoogleUrl('https://docs.google.com/document/d/abc123/edit', 'document'));
  ok('a resourcekey is kept in canonical order', isCanonicalGoogleUrl('https://docs.google.com/document/d/abc123/edit?resourcekey=0-xyz', 'document'));
  ok('the /e/ shortcut is refused', isCanonicalGoogleUrl('https://docs.google.com/document/d/e/2PACX/edit', 'document') === false);
  ok('another host is refused', isCanonicalGoogleUrl('https://evil.example/document/d/abc123/edit', 'document') === false);
  ok('a trailing slash is refused', isCanonicalGoogleUrl('https://docs.google.com/document/d/abc123/edit/', 'document') === false);
  ok('http is refused', isCanonicalGoogleUrl('http://docs.google.com/document/d/abc123/edit', 'document') === false);
  ok('the wrong workspace path is refused', isCanonicalGoogleUrl('https://docs.google.com/spreadsheets/d/abc/edit', 'document') === false);
}

section('one template');
{
  const dir = await writeTemplate(path.join(personal, 'skill-personal'), 'artifact-template-personal');
  const asPersonal = { librarySkillId: 'personal', personalRoot: personal };
  const t = await loadTemplate(dir, 'artifact-template-personal', 'document', asPersonal);
  ok('a well-formed personal template loads', t?.title === 'Smoke template');
  ok('…with its skill path and pixels', t.skillPath.endsWith('SKILL.md') && t.pixels === 1);
  ok('…and its preview bytes only when asked', t.preview.length === PNG.length);
  const bare = await loadTemplate(dir, 'artifact-template-personal', 'document', { ...asPersonal, withPreview: false });
  ok('…and not when not asked', bare.preview === null && bare.previewPath.endsWith('preview.png'));
  ok('the wrong family is not offered', (await loadTemplate(dir, 'artifact-template-personal', 'presentation', asPersonal)) === null);
  ok('a Google request accepts the Office family', (await loadTemplate(dir, 'artifact-template-personal', 'google-docs', asPersonal)) !== null);
  ok('a badly named skill is refused', (await loadTemplate(dir, 'Other Template', 'document', asPersonal)) === null);
  ok('a directory that does not match the name is refused', (await loadTemplate(dir, 'artifact-template-other', 'document', asPersonal)) === null);
  ok('the personal exemption needs the installed directory name', (await loadTemplate(dir, 'artifact-template-personal', 'document', { librarySkillId: 'somebody-else', personalRoot: personal })) === null);
  const outside = await loadTemplate(dir, 'artifact-template-personal', 'document', { librarySkillId: 'personal', personalRoot: path.join(tmp, 'other-root') });
  ok('…and is anchored to the personal root', outside === null);
  const plainDir = await plain('artifact-template-plain');
  ok('a plugin-style install loads by its directory name', (await loadTemplate(plainDir, 'artifact-template-plain', 'document'))?.title === 'Smoke template');
  ok('…and names itself from SKILL.md when no name is passed', (await loadTemplate(plainDir, null, 'document'))?.unqualifiedSkillName === 'artifact-template-plain');
}

section('refusals');
{
  const bad = async (label, name, overrides, requested = 'document') => {
    const dir = await plain(name, overrides);
    const got = await loadTemplate(dir, name, requested);
    ok(label, got === null, got ? `accepted ${JSON.stringify({ kind: got.artifactKind })}` : '');
  };

  await bad('a schema version other than 1 is refused', 'artifact-template-schemav', { manifest: { schemaVersion: 2 } });
  await bad('a reference that is not assets/reference.<ext> is refused', 'artifact-template-ref', { manifest: { reference: 'assets/other.docx' } });
  await bad('an unknown kind is refused', 'artifact-template-kind', { manifest: { kind: 'website' } });
  ok('a Google template without a source URL is refused', (await loadTemplate(await plain('artifact-template-g', { kind: 'google-docs' }), 'artifact-template-g', 'google-docs')) === null);
  const good = await plain('artifact-template-g2', {
    kind: 'google-sheets',
    manifest: { sourceUrl: 'https://docs.google.com/spreadsheets/d/budget42/edit' }
  });
  ok('a Google template with a canonical URL loads', (await loadTemplate(good, 'artifact-template-g2', 'google-sheets'))?.artifactKind === 'google-sheets');

  // An icon that resolves outside the template directory.
  const escape = await plain('artifact-template-escape', { icon: '../escape.png' });
  await fs.writeFile(path.join(tmp, 'plain', 'skills', 'escape.png'), PNG);
  ok('an icon outside the template is refused', (await loadTemplate(escape, 'artifact-template-escape', 'document')) === null);

  // A PNG that only claims to be one.
  const fake = await plain('artifact-template-fake', {
    preview: Buffer.concat([Buffer.from('not a png at all, definitely not a png, no really not'), Buffer.alloc(64)])
  });
  ok('a preview that is not a PNG is refused', (await loadTemplate(fake, 'artifact-template-fake', 'document')) === null);

  // 8193 px on a side is over the limit even though it is a valid header.
  const huge = Buffer.alloc(64);
  PNG.copy(huge, 0, 0, 24);
  huge.writeUInt32BE(8193, 16);
  huge.writeUInt32BE(1, 20);
  const wide = await plain('artifact-template-wide', { preview: huge });
  ok('a preview wider than 8192 px is refused', (await loadTemplate(wide, 'artifact-template-wide', 'document')) === null);

  // A namespaced template whose plugin disagrees about who owns it.
  const pluginRoot = path.join(home, 'plugins', 'cache', 'market', 'toolkit', '1.0.0');
  const pluginTemplate = await writeTemplate(path.join(pluginRoot, 'skills', 'artifact-template-brand'), 'artifact-template-brand');
  await fs.mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'other' }));
  ok('a plugin template owned by another plugin is refused', (await loadTemplate(pluginTemplate, 'toolkit:artifact-template-brand', 'document')) === null);
  await fs.writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit' }));
  ok('…and accepted once the owner agrees', (await loadTemplate(pluginTemplate, 'toolkit:artifact-template-brand', 'document'))?.skillName === 'toolkit:artifact-template-brand');
}

section('discovery');
{
  const found = await discoverTemplates({ codexHome: home, artifactKind: 'document' });
  ok('personal templates are discovered', found.some((t) => t.skillName === 'artifact-template-personal'));
  ok('plugin templates are discovered and namespaced', found.some((t) => t.skillName === 'toolkit:artifact-template-brand'));
  ok('templateRoots points at the ChatGPT home', templateRoots('/home/someone/.codex').personal === '/home/someone/.codex/skills/remote-skills');
  const capped = await discoverTemplates({ codexHome: home, artifactKind: 'document', limit: 1 });
  ok('the limit is respected', capped.length === 1);
  const empty = await discoverTemplates({ codexHome: path.join(tmp, 'nowhere'), artifactKind: 'document' });
  ok('a machine with no templates lists none', empty.length === 0);
  const pres = await discoverTemplates({ codexHome: home, artifactKind: 'presentation' });
  ok('a deck request does not offer document templates', pres.length === 0);
}

section('offering and selecting');
{
  const templates = await discoverTemplates({ codexHome: home, artifactKind: 'document' });
  const cards = offer(templates);
  ok('cards carry an id, a title and a data URL', cards.length === templates.length && cards[0].id.startsWith('artifact-template:') && cards[0].preview.startsWith('data:image/png;base64,'));
  ok('the id round-trips the skill name', decodeURIComponent(cards[0].id.split(':')[1]) === cards[0].skillName);
  const capped = offer(templates, { limit: 1 });
  ok('the picker shows at most the requested number', capped.length === 1);
  let budgetError = null;
  try {
    offer([{ ...templates[0], preview: Buffer.alloc(LIMITS.totalPreviewBytes + 1) }]);
  } catch (e) {
    budgetError = e.code;
  }
  ok('…reported as PreviewsTooLarge', budgetError === 'PreviewsTooLarge');

  const chosen = resolveSelection(templates, cards[0].id);
  ok('a card id resolves to its skill path', chosen.status === 'selected' && chosen.skillPath.endsWith('SKILL.md'));
  ok('a plain skill name also resolves', resolveSelection(templates, 'artifact-template-personal').title === 'Smoke template');
  let unknown = null;
  try {
    resolveSelection(templates, 'artifact-template-nope');
  } catch (e) {
    unknown = e.code;
  }
  ok('an unknown selection is refused as unavailable', unknown === 'Unavailable');
  let ambiguous = null;
  try {
    resolveSelection([templates[0], { ...templates[0] }], 'artifact-template-personal');
  } catch (e) {
    ambiguous = e.code;
  }
  ok('two templates answering to one name are refused as ambiguous', ambiguous === 'Ambiguous');
  let bad = null;
  try {
    resolveSelection(templates, 42);
  } catch (e) {
    bad = e.code;
  }
  ok('a non-string selection is refused', bad === 'Unavailable');
}

section('requests');
{
  ok('a document request is valid', normalizeRequest('document', 'a quarterly deck') === 'a quarterly deck');
  ok('no request is allowed (the list call may omit it)', normalizeRequest('document', null) === '');
  ok('a whitespace-only request is refused', (() => { try { normalizeRequest('document', '   '); return false; } catch (e) { return e.code === 'InvalidRequest'; } })());
  ok('an over-long request is refused', (() => { try { normalizeRequest('document', 'x'.repeat(LIMITS.request + 1)); return false; } catch (e) { return e.code === 'InvalidRequest'; } })());
  ok('an unknown kind is refused before anything is read', (() => { try { normalizeRequest('video', 'x'); return false; } catch (e) { return e.code === 'InvalidArtifactKind'; } })());
}

section('display names');
{
  ok('a filename becomes a title', suggestDisplayName('/tmp/quarterly_report-v2.docx') === 'Quarterly Report V2');
  ok('the name is capped at 64 characters', suggestDisplayName(`${'a'.repeat(80)}.docx`).length === 64);
  ok('a printable name is accepted', validateDisplayName('Quarterly report') === 'Quarterly report');
  ok('surrounding whitespace is refused', validateDisplayName(' Quarterly') === null);
  ok('markup characters are refused', validateDisplayName('Report <b>') === null);
  ok('a name with no letters or digits is refused', validateDisplayName('***') === null);
  ok('a non-string is refused', validateDisplayName(7) === null);
}

section('library record helpers');
{
  // The Library page reads the two keys the generators actually write. These
  // fixtures use only fields those generators produce (Images.jsx / Video.jsx)
  // plus the `kind`/`uid` decoration readLibrary adds.
  const imageAt = '2026-05-02T10:00:00.000Z';
  const videoAt = '2026-05-03T10:00:00.000Z';
  const image = {
    id: 1700000000000,
    prompt: 'A neon city reflected in a dark ocean',
    image: `data:image/png;base64,${PNG.toString('base64')}`,
    provider: 'cloudflare-flux',
    model: 'schnell',
    at: imageAt
  };
  const video = {
    id: 'vid_demo_1',
    status: 'ready',
    prompt: 'Drone flight over a neon city',
    model: 'MiniMax-Hailuo-2.3',
    duration: 6,
    resolution: '768P',
    video: 'https://cdn.example.test/vid_demo_1.mp4',
    at: videoAt
  };
  const makeStorage = (values = {}, { failWrite = false } = {}) => {
    const map = new Map(Object.entries(values));
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => {
        if (failWrite) throw new Error('quota');
        map.set(key, String(value));
      },
      dump: (key) => map.get(key)
    };
  };
  const seeded = makeStorage({
    [LIBRARY_KEYS.image]: JSON.stringify([image]),
    [LIBRARY_KEYS.video]: JSON.stringify([video])
  });

  const library = readLibrary(seeded);
  ok('both storage keys are read', library.items.length === 2 && library.errors.length === 0);
  ok('each record keeps its kind and gets a unique uid',
    library.items[0].kind === 'image' && library.items[1].kind === 'video'
      && library.items[0].uid !== library.items[1].uid);
  ok('a damaged key is reported, not treated as empty', (() => {
    const bad = readLibrary(makeStorage({ [LIBRARY_KEYS.image]: '{not json' }));
    return bad.items.length === 0 && bad.errors.length === 1 && bad.errors[0].key === LIBRARY_KEYS.image;
  })());
  ok('non-object entries are skipped with a count', (() => {
    const bad = readLibrary(makeStorage({ [LIBRARY_KEYS.image]: JSON.stringify([image, null, 42]) }));
    return bad.items.length === 1 && bad.skipped.length === 2;
  })());
  ok('a missing storage object is an error, not a fake empty library', readLibrary(null).errors.length === 1);

  ok('titles come from the prompt', titleOf(image) === image.prompt && titleOf({ kind: 'video' }) === 'Untitled video job');
  ok('source names the provider and model it actually has', sourceOf(image) === 'cloudflare-flux · schnell');
  ok('…and is empty when the record names neither', sourceOf({ kind: 'image' }) === '');
  ok('atMs reads at, then created_at', atMs(image) === Date.parse(imageAt) && atMs({ created_at: videoAt }) === Date.parse(videoAt));
  ok('an unparseable date is null', atMs({ at: 'not a date' }) === null);

  ok('a data URL reports its real byte length', dataUrlBytes(image.image) === PNG.length);
  ok('…and so does an SVG data URL', dataUrlBytes('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')) === 6);
  ok('a non-data URL has no byte length', dataUrlBytes('https://example.test/a.png') === null);
  ok('malformed base64 is rejected rather than guessed', dataUrlBytes('data:image/png;base64,***') === null);
  ok('an image record is sized from its data URL', recordBytes({ ...image, kind: 'image' }).bytes === PNG.length);
  ok('a remote video is unknown, with a reason', (() => {
    const size = recordBytes({ ...video, kind: 'video' });
    return size.known === false && /Remote video/i.test(size.reason);
  })());
  ok('a simulated video is unknown for its own reason', (() => {
    const size = recordBytes({ kind: 'video', video: 'demo', demo: true });
    return size.known === false && /simulated/i.test(size.reason);
  })());
  ok('a minimax provider reference is not a playable URL', mediaUrl('minimax:file_123') === null);
  ok('the demo sentinel is not a URL', mediaUrl('demo') === null);
  ok('http(s), data and same-origin paths are playable',
    mediaUrl('https://cdn.example.test/v.mp4') !== null && mediaUrl(image.image) !== null && mediaUrl('/media/a.png') !== null);
  ok('a protocol-relative URL is not treated as local', mediaUrl('//evil.example/a.png') === null);

  const decorated = readLibrary(seeded).items;
  const byKind = (id) => decorated.find((record) => record.kind === id);
  ok('search matches a prompt', filterRecords(decorated, { query: 'neon' }).length === 2);
  ok('search matches the kind label', filterRecords(decorated, { query: 'video' }).length === 1);
  ok('search matches the source', filterRecords(decorated, { query: 'cloudflare' }).length === 1);
  ok('kind filtering is exact', filterRecords(decorated, { kind: 'image' }).length === 1);
  ok('a time window keeps records at or after the boundary',
    filterRecords(decorated, { since: Date.parse(videoAt) }).length === 1);
  ok('a record with no date cannot pass a time window',
    filterRecords([{ kind: 'image', prompt: 'no date' }], { since: 0 }).length === 0);

  ok('newest sorts descending and unknown dates last', (() => {
    const sorted = sortRecords([...decorated, { kind: 'image', prompt: 'undated' }], 'newest');
    return sorted[0].kind === 'video' && sorted[1].kind === 'image' && sorted[2].prompt === 'undated';
  })());
  ok('oldest sorts ascending and unknown dates last', sortRecords(decorated, 'oldest')[0].kind === 'image');
  ok('largest puts known bytes first and unknown sizes last', (() => {
    const sorted = sortRecords(decorated, 'largest');
    return sorted[0].kind === 'image' && sorted[1].kind === 'video';
  })());
  ok('sorting does not mutate the caller list', (() => {
    const input = [byKind('video'), byKind('image')];
    sortRecords(input, 'oldest');
    return input[0].kind === 'video';
  })());
  ok('an unknown sort falls back to newest', sortRecords(decorated, 'nope')[0].kind === 'video');

  const summary = summarize(decorated);
  ok('summary counts both kinds', summary.total === 2 && summary.counts.image === 1 && summary.counts.video === 1 && summary.kindCount === 2);
  ok('summary adds only known bytes', summary.knownBytes === PNG.length && summary.unknownBytes === 1);
  ok('summary reports the last parseable write', summary.lastAt === Date.parse(videoAt));
  ok('summary counts missing dates separately', summarize([{ kind: 'image' }]).missingDates === 1);
  ok('an empty library summarizes to zeroes', (() => {
    const empty = summarize([]);
    return empty.total === 0 && empty.kindCount === 0 && empty.knownBytes === 0 && empty.lastAt === null;
  })());

  ok('bytes format in binary units', formatBytes(PNG.length) === '68 B' && formatBytes(1536) === '1.5 KB' && formatBytes(1048576) === '1 MB');
  ok('an unknown size formats as an em dash', formatBytes(null) === '—' && formatBytes(-1) === '—');

  const exported = recordExport({ ...image, kind: 'image', uid: 'image:1' }, { exportedAt: '2026-01-02T03:04:05.000Z' });
  const parsedExport = JSON.parse(exported.content);
  ok('a record export names its source and timestamp', parsedExport.source === LIBRARY_KEYS.image && parsedExport.exported_at === '2026-01-02T03:04:05.000Z');
  ok('…omits the huge data URL but keeps its size', /^\[data URL omitted: \d+ bytes\]$/.test(parsedExport.record.image));
  ok('…and drops the UI-only uid', !('uid' in parsedExport.record));
  ok('media=true keeps the data URL when explicitly asked', JSON.parse(recordExport(image, { media: true }).content).record.image.startsWith('data:'));
  const batch = JSON.parse(libraryExport(decorated, { exportedAt: '2026-01-02T03:04:05.000Z' }).content);
  ok('a batch export carries every record and a count', batch.count === 2 && batch.records.length === 2 && batch.exported_at === '2026-01-02T03:04:05.000Z');

  ok('a local data image downloads with a filename', (() => {
    const plan = downloadPlan({ ...image, kind: 'image' });
    return plan && plan.download === true && /\.png$/.test(plan.filename);
  })());
  ok('a remote video opens instead of pretending to download it', (() => {
    const plan = downloadPlan({ ...video, kind: 'video' });
    return plan && plan.download === false && plan.href === video.video;
  })());
  ok('a remote image keeps the extension its URL actually names', (() => {
    const plan = downloadPlan({ kind: 'image', id: 7, image: 'https://cdn.example.test/photo.jpeg?size=large' });
    return plan && plan.download === false && /\.jpg$/.test(plan.filename);
  })());
  ok('no plan for a simulated or reference-only video',
    downloadPlan({ kind: 'video', video: 'demo' }) === null && downloadPlan({ kind: 'video', video: 'minimax:x' }) === null);

  const removalStore = makeStorage({
    [LIBRARY_KEYS.image]: JSON.stringify([image]),
    [LIBRARY_KEYS.video]: JSON.stringify([video])
  });
  const removed = removeRecords(removalStore, [recordUid('image', image)]);
  ok('bulk delete removes only the selected record', removed.removed === 1 && JSON.parse(removalStore.dump(LIBRARY_KEYS.image)).length === 0);
  ok('…and leaves the other key alone', JSON.parse(removalStore.dump(LIBRARY_KEYS.video)).length === 1);
  ok('deleting an absent record reports zero removed', removeRecords(removalStore, [recordUid('image', image)]).removed === 0);
  ok('a failed write reports the key and removes nothing', (() => {
    const failing = makeStorage({ [LIBRARY_KEYS.image]: JSON.stringify([image]) }, { failWrite: true });
    const result = removeRecords(failing, [recordUid('image', image)]);
    return result.removed === 0 && result.errors.length === 1 && result.errors[0].key === LIBRARY_KEYS.image;
  })());
  ok('a record without an id still gets a stable local identity', recordUid('image', { prompt: 'x' }, 3) === 'image:#3');

  ok('time filters resolve to a boundary or null', sinceFor('all', 1000) === null && sinceFor('24h', 1000) === 1000 - 86400000);
  ok('the create menu only marks image/video as saved here', CREATE_TARGETS.filter((target) => target.saves).map((target) => target.to).join(',') === '/images,/video');
  ok('…and still routes to every real surface', ['/images', '/video', '/sandbox', '/skills', '/codex'].every((route) => CREATE_TARGETS.some((target) => target.to === route)));
  ok('the sort options the UI offers are the helper\'s options', SORT_OPTIONS.map((entry) => entry.id).join(',') === 'newest,oldest,largest');
  ok('the time options the UI offers are the helper\'s options', TIME_FILTERS.map((entry) => entry.id).join(',') === 'all,24h,7d,30d');
  ok('keys are the generators\' real storage keys', LIBRARY_KEYS.image === 'acx_images' && LIBRARY_KEYS.video === 'acx_videos');
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
