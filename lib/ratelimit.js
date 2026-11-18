// ANTICODEX v2.5 — in-process token-bucket rate limiter.
//
// The bridge used to answer every action, unauthenticated, without a single
// rate check: /api/bridge was an unlimited proxy onto whatever provider keys
// the server holds (chat, image, video, search all cost money per call). This
// module gives the hot endpoints a cheap per-IP budget.
//
// Caveat documented on purpose: on serverless each warm instance keeps its own
// buckets, so this is a strong mitigation for the Node/desktop server and a
// best-effort backstop on Vercel (per-instance). For a global limit, put it in
// Vercel WAF/edge middleware; the interface here matches what that would need.

const buckets = new Map(); // key -> { tokens, at }
let sweptAt = Date.now();

/**
 * @param key       identity string (usually `${scope}:${ip}`)
 * @param capacity  burst size (tokens)
 * @param perMinute sustained refill rate (tokens/minute)
 * @returns {{ ok: true }} or {{ ok:false, retry_after_s, remaining }}
 */
export function consume(key, capacity, perMinute) {
  const now = Date.now();
  // Opportunistic sweep so the map cannot grow unbounded under scan traffic.
  if (now - sweptAt > 60_000) {
    sweptAt = now;
    for (const [k, b] of buckets) if (b.tokens >= capacity && now - b.at > 120_000) buckets.delete(k);
  }
  const rate = perMinute / 60_000; // tokens per ms
  let b = buckets.get(key);
  if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
  b.tokens = Math.min(capacity, b.tokens + (now - b.at) * rate);
  b.at = now;
  if (b.tokens < 1) {
    const waitS = Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
    return { ok: false, retry_after_s: waitS, remaining: 0 };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

/** Presets for the actions that actually cost money or invite abuse. */
export const LIMITS = {
  chat:        { capacity: 20, perMinute: 10 },   // per IP: LLM calls are the expensive relay
  auth_write:  { capacity: 8,  perMinute: 2 },    // register/login/forgot/reset — brute-force surface
  admin_login: { capacity: 5,  perMinute: 1 },    // the Thaddeusadmin console gate
  media:       { capacity: 6,  perMinute: 3 },    // image / video_start generation
  mcp_call:    { capacity: 30, perMinute: 20 }    // connector tool playground
};

export function clientKey(req, scope) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local')
    .toString().split(',')[0].trim();
  return `${scope}:${ip}`;
}
