// Pure studio logic shared by Image Studio and Video Studio.
//
// This file deliberately has no React and no module-level browser access, so
// `node tests/test-studios.mjs` can assert the status mapping, the resume rules
// and the backoff without mounting a page.

export const VIDEO_POLL_BASE_MS = 4000;
export const VIDEO_POLL_MAX_MS = 30000;
export const VIDEO_TERMINAL_STATUSES = Object.freeze(['ready', 'failed', 'demo']);

const READY = new Set(['success', 'succeeded', 'ready', 'completed', 'done']);
const FAILED = new Set(['fail', 'failed', 'failure', 'error', 'cancelled', 'canceled']);
const DEMO = new Set(['demo', 'preview', 'simulated']);

/** Provider words → the states this app can act on. Unknown is NOT terminal:
 *  a future MiniMax status ("Preparing") must keep the poll alive. */
export function mapVideoStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (READY.has(s)) return 'ready';
  if (FAILED.has(s)) return 'failed';
  if (DEMO.has(s)) return 'demo';
  return 'processing';
}

export function isTerminalVideo(status) {
  return VIDEO_TERMINAL_STATUSES.includes(mapVideoStatus(status));
}

/** Exponential backoff, capped. Attempt 0 → 4s, 1 → 8s, 2 → 16s, 3+ → 30s.
 *  A Hailuo render takes minutes, so a fixed 2.5s loop only proved the job was
 *  slow and then gave up. */
export function nextPollDelay(attempt, { base = VIDEO_POLL_BASE_MS, max = VIDEO_POLL_MAX_MS } = {}) {
  const n = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)));
  return Math.min(max, base * (2 ** n));
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function makeId(prefix = 'gen') {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Flux has no separate negative-prompt field on Workers AI. Saying "appended
 *  as an avoid list" is true; a control that silently did nothing would not be. */
export function withAvoid(prompt, negative) {
  const p = String(prompt || '').trim();
  const n = String(negative || '').trim();
  return n ? `${p}\n\nAvoid: ${n}` : p;
}

export function dataMime(src) {
  const m = /^data:([^;,]+)/i.exec(String(src || ''));
  return m ? m[1].toLowerCase() : null;
}

export function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/svg+xml') return 'svg';
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/png') return 'png';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/webm') return 'webm';
  return null;
}

/** The file extension a generated result should be saved with. A demo result is
 *  an SVG even though the old gallery told the browser it was a .png. */
export function downloadExt(result) {
  const direct = result?.ext || extFromMime(result?.mime);
  if (direct) return direct;
  return extFromMime(dataMime(result?.image)) || 'bin';
}

/** Append the first time a status is seen. Repeated polls of "Processing" must
 *  not rewrite the timeline timestamp every few seconds. The local queue state
 *  stays "queued" so the first timeline step is visibly current before the
 *  provider answers; every provider word still goes through mapVideoStatus. */
export function appendJobEvent(job, status, at = new Date().toISOString()) {
  const raw = String(status || '').trim().toLowerCase();
  const s = raw === 'queued' ? 'queued' : mapVideoStatus(status);
  const events = Array.isArray(job?.events) ? [...job.events] : [];
  if (!events.some((e) => String(e?.status || '').toLowerCase() === s)) events.push({ status: s, at });
  return { ...job, status: s, events };
}

export function normalizeVideoJob(job, now = Date.now()) {
  if (!job || typeof job !== 'object' || !job.id) return null;
  const demo = job.demo === true || job.status === 'demo' || job.video === 'demo';
  const raw = String(job.status || '').trim().toLowerCase();
  let status = raw === 'queued' ? 'queued' : mapVideoStatus(job.status);
  if (demo && status !== 'failed') status = 'demo';
  const created = job.created_at || job.at || new Date(now).toISOString();
  return {
    ...job,
    id: String(job.id),
    demo,
    status,
    created_at: created,
    at: job.at || created,
    events: Array.isArray(job.events) ? job.events.filter((e) => e && e.status) : []
  };
}

/** Durable-state entry point. Terminal jobs stay exactly as stored; active jobs
 *  are marked `resume:true` so the page knows to schedule a poll on mount. */
export function resumeVideoJobs(jobs, now = Date.now()) {
  const list = Array.isArray(jobs) ? jobs : [];
  const byId = new Map();
  for (const raw of list) {
    const job = normalizeVideoJob(raw, now);
    if (!job) continue;
    const previous = byId.get(job.id);
    const stamp = (j) => Date.parse(j?.updated_at || j?.created_at || 0) || 0;
    if (!previous || stamp(job) >= stamp(previous)) byId.set(job.id, job);
  }
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.created_at || 0) || 0) - (Date.parse(a.created_at || 0) || 0))
    .map((job) => ({ ...job, resume: !isTerminalVideo(job.status) }));
}

/** Timeline steps for the card. `state` is a plain string the page maps to CSS. */
export function videoTimeline(job) {
  const raw = String(job?.status || '').trim().toLowerCase();
  const status = raw === 'queued' ? 'queued' : mapVideoStatus(job?.status);
  const events = Array.isArray(job?.events) ? job.events : [];
  // "queued" and provider "Processing" both map to processing in mapVideoStatus,
  // so the timeline matches the raw event word first and only then the mapping.
  const at = (id) => events.find((e) => {
    const es = String(e?.status || '').trim().toLowerCase();
    return es === id || (id === 'processing' && es !== 'queued' && mapVideoStatus(es) === 'processing');
  })?.at || (id === 'queued' ? (job?.created_at || job?.at || null) : null);

  if (status === 'demo') {
    return [
      { id: 'queued', label: 'Queued', at: at('queued'), state: 'done' },
      { id: 'demo', label: 'Preview', at: job?.created_at || job?.at || null, state: 'current' }
    ];
  }

  const steps = [
    { id: 'queued', label: 'Queued' },
    { id: 'processing', label: 'Rendering' },
    status === 'failed' ? { id: 'failed', label: 'Failed' } : { id: 'ready', label: 'Ready' }
  ];
  const current = status === 'processing' ? 1 : (status === 'queued' ? 0 : 2);
  return steps.map((step, i) => ({
    ...step,
    at: at(step.id) || (step.id === 'queued' ? (job?.created_at || job?.at || null) : null),
    state: step.id === 'failed' ? 'failed' : i < current ? 'done' : i === current ? 'current' : 'pending'
  }));
}

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `This browser could not save the history (${e?.name === 'QuotaExceededError' ? 'storage is full' : String(e?.message || e)}). Download the media you want to keep, then clear older entries.`
    };
  }
}
