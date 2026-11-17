// Pure helpers for the Library page.
//
// The Library shows the two record sets this app actually writes in this
// browser: `acx_images` (Image Studio) and `acx_videos` (Video Studio). The
// bridge's `artifacts` action is a document-template picker, not a record list,
// so nothing here invents a server record or a field. Every byte count is either
// read from the record or calculated from its data URL; everything else is
// reported as unknown, with a reason the UI can show.

export const LIBRARY_KEYS = Object.freeze({ image: 'acx_images', video: 'acx_videos' });
export const LIBRARY_KINDS = Object.freeze(['image', 'video']);

export const KIND_LABELS = Object.freeze({ image: 'Image', video: 'Video' });

export const TIME_FILTERS = Object.freeze([
  { id: 'all', label: 'Any time', ms: null },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 }
]);

export const SORT_OPTIONS = Object.freeze([
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'largest', label: 'Largest first' }
]);

// The Create menu goes to the surface that can actually make each kind. Only
// Image Studio and Video Studio write records this page can show; the others
// are real tools whose output lives somewhere else, and the label says so.
export const CREATE_TARGETS = Object.freeze([
  { to: '/images', icon: 'images', label: 'Image', hint: 'Flux generation · lands in this library', saves: true },
  { to: '/video', icon: 'video', label: 'Video', hint: 'Hailuo job · lands in this library', saves: true },
  { to: '/sandbox', icon: 'sandbox', label: 'Code run', hint: 'Runs on this machine · not saved here', saves: false },
  { to: '/skills', icon: 'skills', label: 'Skill or artifact template', hint: 'Installed on disk · not saved here', saves: false },
  { to: '/codex', icon: 'codex', label: 'Codex workspace', hint: 'Files on disk · not saved here', saves: false }
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A stable identity for selection and React keys. Records from the generators always carry an id. */
export function recordUid(kind, record, index = 0) {
  const id = record?.id;
  return id === undefined || id === null || String(id) === ''
    ? `${kind}:#${index}`
    : `${kind}:${String(id)}`;
}

/** Milliseconds since the epoch, from the record's own `at`/`created_at`, or null. */
export function atMs(record) {
  const value = record?.at ?? record?.created_at;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** True byte length of a `data:` URL, or null when it is not one / cannot be decoded. */
export function dataUrlBytes(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]*)((?:;[^,]*)*),/i.exec(value);
  if (!match) return null;
  const meta = match[2] || '';
  const payload = value.slice(match[0].length);
  if (/;base64(?:;|$)/i.test(meta)) {
    const clean = payload.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
    const padding = (clean.match(/=+$/) || [''])[0].length;
    return Math.floor((clean.length * 3) / 4) - padding;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return null;
  }
}

/** A URL this page can actually put in <img>/<video>; a provider reference is not one. */
export function mediaUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'demo') return null;
  if (/^data:[^,]+,/i.test(text)) return text;
  if (/^(https?:|blob:)/i.test(text)) return text;
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  return null;
}

/** What this record knows about its own size, and why when it does not. */
export function recordBytes(record) {
  if (!isObject(record)) return { bytes: null, known: false, reason: 'This is not a record.' };
  for (const field of ['bytes', 'size']) {
    const value = Number(record[field]);
    if (Number.isFinite(value) && value >= 0) return { bytes: value, known: true, reason: null };
  }
  const media = record.kind === 'video' ? mediaUrl(record.video) : mediaUrl(record.image);
  const bytes = dataUrlBytes(media);
  if (bytes !== null) return { bytes, known: true, reason: null };
  if (record.kind === 'video') {
    if (record.video === 'demo' || record.demo) {
      return { bytes: null, known: false, reason: 'This is a simulated job, so no video file was produced.' };
    }
    if (typeof record.video === 'string' && record.video.trim() && !media) {
      return { bytes: null, known: false, reason: 'The job stores a provider reference, not a downloadable file.' };
    }
    if (record.video) return { bytes: null, known: false, reason: 'Remote video: the record does not carry its byte size.' };
    return { bytes: null, known: false, reason: 'No video file is stored in this record.' };
  }
  if (record.image) return { bytes: null, known: false, reason: 'Remote image: the record does not carry its byte size.' };
  return { bytes: null, known: false, reason: 'No image bytes are stored in this record.' };
}

/** A printable title, using only the prompt the generator wrote. */
export function titleOf(record) {
  const prompt = typeof record?.prompt === 'string' ? record.prompt.trim() : '';
  if (prompt) return prompt;
  if (record?.kind === 'video') return 'Untitled video job';
  if (record?.kind === 'image') return 'Untitled image';
  return 'Untitled record';
}

/** The provider/model pair the record names, or an empty string. */
export function sourceOf(record) {
  return [record?.provider, record?.model]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' · ');
}

export function sinceFor(id, now = Date.now()) {
  const filter = TIME_FILTERS.find((entry) => entry.id === id);
  return filter?.ms == null ? null : now - filter.ms;
}

/**
 * Read both storage keys without pretending a damaged key is empty.
 * Returns `{ items, errors, skipped }`, where each item keeps its own fields and
 * gains `kind` plus a UI-only `uid`.
 */
export function readLibrary(storage) {
  const items = [];
  const errors = [];
  const skipped = [];
  if (!storage || typeof storage.getItem !== 'function') {
    return {
      items,
      errors: [{ key: null, error: 'Browser storage is not available, so the library cannot be read.' }],
      skipped
    };
  }
  for (const kind of LIBRARY_KINDS) {
    const key = LIBRARY_KEYS[kind];
    let raw;
    try {
      raw = storage.getItem(key);
    } catch (e) {
      errors.push({ key, error: `Could not read ${key}: ${String(e?.message || e)}` });
      continue;
    }
    if (raw == null || raw === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ key, error: 'The stored value is not valid JSON, so these records cannot be read.' });
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push({ key, error: 'The stored value is not a list, so these records cannot be read.' });
      continue;
    }
    parsed.forEach((entry, index) => {
      if (!isObject(entry)) {
        skipped.push({ key, index, reason: 'not an object' });
        return;
      }
      items.push({ ...entry, kind, uid: recordUid(kind, entry, index) });
    });
  }
  return { items, errors, skipped };
}

/** Remove the records whose `uid` is in `uids`. A failed write removes nothing from that key. */
export function removeRecords(storage, uids) {
  const doomed = new Set(Array.isArray(uids) ? uids : []);
  const result = { removed: 0, errors: [] };
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    result.errors.push({ key: null, error: 'Browser storage is not available, so nothing was deleted.' });
    return result;
  }
  for (const kind of LIBRARY_KINDS) {
    const key = LIBRARY_KEYS[kind];
    let parsed;
    try {
      const raw = storage.getItem(key);
      if (raw == null || raw === '') continue;
      parsed = JSON.parse(raw);
    } catch (e) {
      result.errors.push({ key, error: `Could not read ${key}, so nothing was deleted there. ${String(e?.message || e)}`.trim() });
      continue;
    }
    if (!Array.isArray(parsed)) {
      result.errors.push({ key, error: `Could not read ${key}, so nothing was deleted there.` });
      continue;
    }
    let removedHere = 0;
    const kept = parsed.filter((entry, index) => {
      if (!doomed.has(recordUid(kind, entry, index))) return true;
      removedHere += 1;
      return false;
    });
    if (!removedHere) continue;
    try {
      storage.setItem(key, JSON.stringify(kept));
      result.removed += removedHere;
    } catch (e) {
      result.errors.push({ key, error: `Could not write ${key}, so those records were kept. ${String(e?.message || e)}`.trim() });
    }
  }
  return result;
}

/** Search title, kind and source (plus status where a video has one). */
export function filterRecords(records, { query = '', kind = 'all', since = null } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return (Array.isArray(records) ? records : []).filter((record) => {
    if (!isObject(record)) return false;
    if (kind !== 'all' && record.kind !== kind) return false;
    if (since !== null && since !== undefined) {
      const at = atMs(record);
      // A record with no parseable date cannot be proved to be inside a time
      // window, so it is excluded rather than silently treated as today.
      if (at === null || at < since) return false;
    }
    if (!needle) return true;
    return [titleOf(record), record.kind, KIND_LABELS[record.kind], sourceOf(record), record.status]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

/** Newest, oldest or largest. Records with unknown dates/sizes sort last. */
export function sortRecords(records, sort = 'newest') {
  const list = (Array.isArray(records) ? records : []).filter(isObject).slice();
  const when = new Map(list.map((record) => [record, atMs(record)]));
  const bytes = new Map(list.map((record) => [record, recordBytes(record)]));
  const tie = (a, b) => String(a.uid || '').localeCompare(String(b.uid || ''));

  if (sort === 'oldest') {
    return list.sort((a, b) => {
      const atA = when.get(a);
      const atB = when.get(b);
      if (atA === null && atB === null) return tie(a, b);
      if (atA === null) return 1;
      if (atB === null) return -1;
      return atA - atB || tie(a, b);
    });
  }
  if (sort === 'largest') {
    return list.sort((a, b) => {
      const sizeA = bytes.get(a);
      const sizeB = bytes.get(b);
      if (sizeA.known && sizeB.known) {
        return sizeB.bytes - sizeA.bytes || (when.get(b) ?? 0) - (when.get(a) ?? 0) || tie(a, b);
      }
      if (sizeA.known) return -1;
      if (sizeB.known) return 1;
      return (when.get(b) ?? 0) - (when.get(a) ?? 0) || tie(a, b);
    });
  }
  return list.sort((a, b) => {
    const atA = when.get(a);
    const atB = when.get(b);
    if (atA === null && atB === null) return tie(a, b);
    if (atA === null) return 1;
    if (atB === null) return -1;
    return atB - atA || tie(a, b);
  });
}

export function summarize(records) {
  const list = (Array.isArray(records) ? records : []).filter(isObject);
  const counts = Object.fromEntries(LIBRARY_KINDS.map((kind) => [kind, 0]));
  let knownBytes = 0;
  let unknownBytes = 0;
  let missingDates = 0;
  let lastAt = null;
  for (const record of list) {
    if (counts[record.kind] !== undefined) counts[record.kind] += 1;
    const size = recordBytes(record);
    if (size.known) knownBytes += size.bytes;
    else unknownBytes += 1;
    const at = atMs(record);
    if (at === null) missingDates += 1;
    else if (lastAt === null || at > lastAt) lastAt = at;
  }
  const kinds = LIBRARY_KINDS.filter((kind) => counts[kind] > 0);
  return {
    total: list.length,
    counts,
    kinds,
    kindCount: kinds.length,
    knownBytes,
    unknownBytes,
    missingDates,
    lastAt
  };
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.?0+$/, '')} ${units[unit]}`;
}

const safeFilePart = (value) => String(value ?? 'record').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'record';

function recordPayload(record, media) {
  const payload = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === 'uid') continue;
    if (!media && typeof value === 'string' && value.startsWith('data:')) {
      const bytes = dataUrlBytes(value);
      payload[key] = `[data URL omitted${bytes === null ? '' : `: ${bytes} bytes`}]`;
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

/** A JSON export that does not silently grow to hundreds of megabytes of data URL. */
export function recordExport(record, { media = false, exportedAt = new Date().toISOString() } = {}) {
  return {
    filename: `anticodex-${safeFilePart(record?.kind)}-${safeFilePart(record?.id)}.json`,
    mime: 'application/json',
    content: JSON.stringify(
      {
        exported_at: exportedAt,
        source: LIBRARY_KEYS[record?.kind] || null,
        record: recordPayload(record, media)
      },
      null,
      2
    )
  };
}

/** One file for a filtered set or the current selection. */
export function libraryExport(records, { media = false, exportedAt = new Date().toISOString() } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(isObject);
  return {
    filename: `anticodex-library-${exportedAt.replace(/[^\d]/g, '').slice(0, 14)}.json`,
    mime: 'application/json',
    content: JSON.stringify(
      {
        exported_at: exportedAt,
        source: 'browser storage: acx_images + acx_videos',
        count: list.length,
        records: list.map((record) => recordPayload(record, media))
      },
      null,
      2
    )
  };
}

const extensionForMime = (mime, kind) => {
  const type = String(mime || '').toLowerCase();
  if (type.includes('svg')) return 'svg';
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime')) return 'mov';
  if (type.includes('png')) return 'png';
  if (type.includes('mp4')) return 'mp4';
  return kind === 'video' ? 'mp4' : 'png';
};

/** Where the record's media can be opened, and whether a browser will really save it. */
export function downloadPlan(record) {
  const kind = record?.kind;
  const href = kind === 'video' ? mediaUrl(record?.video) : kind === 'image' ? mediaUrl(record?.image) : null;
  if (!href) return null;
  const mime = /^data:([^;,]+)/i.exec(href)?.[1] || '';
  const pathExt = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(href)?.[1]?.toLowerCase();
  const knownExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'webm', 'mov'];
  const extension = mime
    ? extensionForMime(mime, kind)
    : pathExt && knownExt.includes(pathExt)
      ? (pathExt === 'jpeg' ? 'jpg' : pathExt)
      : extensionForMime('', kind);
  return {
    href,
    filename: `anticodex-${safeFilePart(kind)}-${safeFilePart(record?.id)}.${extension}`,
    // `download` is honoured for data/blob URLs; a cross-origin link is opened
    // instead, because promising a save the browser will ignore is a lie.
    download: /^(data:|blob:)/i.test(href)
  };
}
