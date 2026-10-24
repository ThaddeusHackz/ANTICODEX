// Model health — what the picker knows about a model *after* someone used it.
//
// The catalog is a guess about which ids exist. A guess becomes a fact in two
// ways: the provider lists it (`live` models, see providers.js) or a real call
// succeeds. It becomes a *dead* id when the provider itself says the model does
// not exist — "model_not_found", "no such model", a 404 on the model name.
//
// Dead ids are the ones users complain about twice:
//
//   1. they are offered in the picker, and
//   2. choosing one answers "there is nothing like this model available".
//
// So a model the provider has explicitly rejected is hidden from the picker (on
// the website and in the desktop app — both read the same index) until either a
// call to it succeeds or someone clears the record. Nothing is deleted from the
// catalog: `include_hidden` still lists it, with the sentence the provider used.
//
// Also recorded, because silence is the other complaint: the last latency, so a
// slow model can be labelled slow instead of just *feeling* broken.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH } from './keys.js';

// Resolved once, from one root: a relative or oddly-joined DATA_PATH must not be
// able to land this file somewhere else than the data directory the process was
// configured with.
const ROOT = path.resolve(DATA_PATH);
const FILE = path.join(ROOT, 'model-health.json');
const MAX_MODELS = 2000;
// A "missing" verdict is re-tested after this long, because providers do add
// models and because a 404 can mean a stale gateway route rather than a typo.
const MISSING_TTL_MS = 12 * 60 * 60 * 1000;

let cache = null;
let writeTimer = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = raw && raw.v === 1 && raw.models && typeof raw.models === 'object' ? raw : { v: 1, models: {} };
  } catch {
    cache = { v: 1, models: {} };
  }
  return cache;
}

function flush() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cache));
    } catch { /* read-only filesystem: keep it in memory for this process */ }
  }, 400);
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/** `provider::model` — the same ref shape the picker and the chat call use. */
export function modelRef(model, provider) {
  const id = String(model || '');
  if (id.includes('::')) return id;
  return provider ? `${provider}::${id}` : id;
}

/**
 * Turn a provider failure into one of the states the UI paints with.
 *
 * The distinction that matters is `missing` (the id does not exist — hide it)
 * versus everything else (the key, the quota, the network). A 404 alone is not
 * enough: gateways answer 404 for an unknown path too, so the text has to talk
 * about the model.
 */
export function classifyFailure(errOrMessage, status) {
  const raw = String(errOrMessage && errOrMessage.message ? errOrMessage.message : errOrMessage || '');
  const code = Number(status || (raw.match(/\b(4\d\d|5\d\d)\b/) || [])[1] || 0);
  if (/(no such model|model[_ ]not[_ ]found|unknown model|invalid model|does not exist|not a valid model|unsupported model|no model called|nothing like this model)/i.test(raw)) return 'missing';
  if (code === 404 && /\bmodel\b/i.test(raw)) return 'missing';
  // A 404 about the *request* is not a missing model: NVIDIA NIM says
  // "Function '<uuid>': Not found for account '…'" for every id when the key is
  // unknown or the account is not entitled. Recording that as missing would hide
  // models that exist from the picker for 12 hours.
  if (code === 404 && !/\bmodel\b/i.test(raw)
    && /(not found for account|function [^.]{0,60}not found|page not found|endpoint not found|route not found)/i.test(raw)) return 'key';
  if (/(\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden)/i.test(raw)) return 'key';
  if (/(\b429\b|rate ?limit|quota|insufficient (?:funds|balance))/i.test(raw)) return 'quota';
  if (/(abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|network|could not reach)/i.test(raw)) return 'network';
  if (/(\b5\d\d\b|overloaded|bad gateway|server error)/i.test(raw)) return 'retry';
  if (/no api key configured/i.test(raw)) return 'key';
  return 'error';
}

/** Record a real model call. `ms` is measured by the caller (call → answer). */
export function recordOutcome(ref, { state, ms = null, error = null, provider = null, firstTokenMs = null }) {
  const key = modelRef(ref, provider);
  if (!key || key === 'anticodex/demo-core') return null;
  const db = load();
  const prev = db.models[key] || {};
  const now = Date.now();
  const next = {
    ...prev,
    state,
    provider: provider || prev.provider || (key.includes('::') ? key.split('::')[0] : null),
    model: key.includes('::') ? key.split('::').slice(1).join('::') : key,
    checks: (prev.checks || 0) + 1,
    checked_at: now,
    // A success proves the id exists — that is the only thing that revives a
    // model the provider previously rejected.
    ...(state === 'ok' ? { last_ok_at: now, last_error: null, missing_since: null } : {}),
    ...(state === 'missing' ? { missing_since: prev.missing_since || now, last_error: String(error || '').slice(0, 240) } : {}),
    ...(state && state !== 'ok' && state !== 'missing' ? { last_error: String(error || '').slice(0, 240) } : {}),
    ...(Number.isFinite(ms) ? { latency_ms: Math.round(ms), ...(Number.isFinite(firstTokenMs) ? { first_token_ms: Math.round(firstTokenMs) } : {}) } : {}),
    ...(prev.latency_ms && Number.isFinite(ms)
      ? { latency_avg_ms: Math.round(((prev.latency_avg_ms || prev.latency_ms) * (prev.checks || 1) + ms) / ((prev.checks || 1) + 1)) }
      : {})
  };
  db.models[key] = next;
  const keys = Object.keys(db.models);
  if (keys.length > MAX_MODELS) {
    // Oldest-touched first out; this is a cache, not a ledger.
    keys.sort((a, b) => (db.models[a].checked_at || 0) - (db.models[b].checked_at || 0));
    for (const k of keys.slice(0, keys.length - MAX_MODELS)) delete db.models[k];
  }
  flush();
  return next;
}

export function getHealth(ref) {
  const db = load();
  const key = modelRef(ref);
  return db.models[key] || null;
}

/** True when the provider rejected this exact id recently enough to hide it. */
export function isDead(ref, now = Date.now()) {
  const h = getHealth(ref);
  if (!h || h.state !== 'missing') return false;
  return now - (h.missing_since || h.checked_at || 0) < MISSING_TTL_MS;
}

export function clearHealth(ref) {
  const db = load();
  if (ref) delete db.models[modelRef(ref)];
  else db.models = {};
  flush();
  return true;
}

/**
 * Attach health to a picker entry and decide whether it should be offered.
 *
 * `live` comes from the provider's own /models answer. A model the endpoint has
 * just listed is never hidden on our say-so — the list is fresher than we are.
 */
export function annotate(model, { liveConfirmed = false } = {}) {
  const ref = modelRef(model.id, model.provider);
  const h = getHealth(ref);
  const dead = !liveConfirmed && isDead(ref);
  return {
    ...model,
    health: h
      ? {
          state: h.state,
          checks: h.checks || 0,
          checked_at: h.checked_at || null,
          latency_ms: h.latency_ms ?? null,
          first_token_ms: h.first_token_ms ?? null,
          last_error: h.last_error || null
        }
      : null,
    dead,
    ...(dead ? { dead_reason: h?.last_error || 'the provider says this model does not exist' } : {})
  };
}

export function summary() {
  const db = load();
  const out = { tracked: 0, ok: 0, missing: 0, slowest: null, fastest: null };
  for (const [ref, h] of Object.entries(db.models)) {
    out.tracked += 1;
    if (h.state === 'ok') out.ok += 1;
    if (isDead(ref)) out.missing += 1;
    if (Number.isFinite(h.latency_ms)) {
      if (!out.slowest || h.latency_ms > out.slowest.latency_ms) out.slowest = { ref, latency_ms: h.latency_ms };
      if (!out.fastest || h.latency_ms < out.fastest.latency_ms) out.fastest = { ref, latency_ms: h.latency_ms };
    }
  }
  return out;
}

/** For tests and the Settings page: the whole record, newest first. */
export function allHealth() {
  const db = load();
  return Object.entries(db.models)
    .map(([ref, h]) => ({ ref, ...h, dead: isDead(ref) }))
    .sort((a, b) => (b.checked_at || 0) - (a.checked_at || 0));
}
