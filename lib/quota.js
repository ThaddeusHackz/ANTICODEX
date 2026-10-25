const buckets = new Map();
const LIMITED_ACTIONS = new Set(['chat', 'chat_stream', 'search', 'image', 'video_start', 'video_status', 'extras', 'model_health']);
const DEFAULTS = Object.freeze({
  anonymous: { capacity: 20, refillPerMinute: 2 },
  ip: { capacity: 120, refillPerMinute: 12 },
  user: { capacity: 120, refillPerMinute: 12 }
});
const MAX_BUCKETS = 10000;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function quotaConfig(env = process.env) {
  let parsed = {};
  try { parsed = JSON.parse(env.ANTICODEX_QUOTAS || '{}'); } catch { parsed = {}; }
  const section = (name, capacityEnv, refillEnv) => ({
    capacity: positive(env[capacityEnv] ?? parsed[name]?.capacity, DEFAULTS[name].capacity),
    refillPerMinute: positive(env[refillEnv] ?? parsed[name]?.refillPerMinute, DEFAULTS[name].refillPerMinute)
  });
  return {
    anonymous: section('anonymous', 'ANTICODEX_QUOTA_ANON_CAPACITY', 'ANTICODEX_QUOTA_ANON_REFILL_PER_MINUTE'),
    ip: section('ip', 'ANTICODEX_QUOTA_IP_CAPACITY', 'ANTICODEX_QUOTA_IP_REFILL_PER_MINUTE'),
    user: section('user', 'ANTICODEX_QUOTA_USER_CAPACITY', 'ANTICODEX_QUOTA_USER_REFILL_PER_MINUTE')
  };
}

function stateFor(key, policy, now) {
  const prior = buckets.get(key);
  if (!prior) return { tokens: policy.capacity, at: now };
  const elapsedMinutes = Math.max(0, now - prior.at) / 60000;
  return { tokens: Math.min(policy.capacity, prior.tokens + elapsedMinutes * policy.refillPerMinute), at: now };
}

function retryAfter(state, policy, cost) {
  return Math.max(1, Math.ceil(((cost - state.tokens) / policy.refillPerMinute) * 60));
}

function prune(now) {
  for (const [key, row] of buckets) if (now - row.at > 24 * 60 * 60 * 1000) buckets.delete(key);
  while (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
}

export function consumeQuota({ action, ip, userId, cost = 1, now = Date.now(), config = quotaConfig() }) {
  if (!LIMITED_ACTIONS.has(action)) return { allowed: true, retryAfter: 0, limited: false };
  const normalizedIp = String(ip || 'unknown').slice(0, 128);
  const checks = userId
    ? [
        { key: `ip:${normalizedIp}`, policy: config.ip },
        { key: `user:${String(userId).slice(0, 160)}`, policy: config.user }
      ]
    : [{ key: `anonymous:${normalizedIp}`, policy: config.anonymous }];
  const states = checks.map((check) => ({ ...check, state: stateFor(check.key, check.policy, now) }));
  const blocked = states.filter((check) => check.state.tokens < cost);
  if (blocked.length) {
    return {
      allowed: false,
      retryAfter: Math.max(...blocked.map((check) => retryAfter(check.state, check.policy, cost))),
      limited: true
    };
  }
  for (const check of states) buckets.set(check.key, { tokens: check.state.tokens - cost, at: now });
  prune(now);
  return { allowed: true, retryAfter: 0, limited: true };
}

export function resetQuotasForTests() {
  buckets.clear();
}
