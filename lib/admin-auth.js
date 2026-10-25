import crypto from 'node:crypto';
import { getKey } from './keys.js';

export const ADMIN_TOKEN_TTL_SECONDS = 30 * 60;
const HEADER = Object.freeze({ alg: 'HS256', typ: 'ACX-ADMIN' });
const DEV_SECRET = crypto.randomBytes(32).toString('base64url');
const denied = new Map();
const attempts = new Map();
const MAX_CACHE = 2000;
const MAX_FAILURES = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

export function adminCredentials() {
  const username = getKey('ADMIN_USERNAME');
  const password = getKey('ADMIN_PASSWORD');
  return username && password ? { username, password } : null;
}

export function adminCredentialsMatch(username, password, credentials = adminCredentials()) {
  if (!credentials) return false;
  const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return crypto.timingSafeEqual(digest(username), digest(credentials.username)) &&
    crypto.timingSafeEqual(digest(password), digest(credentials.password));
}

export function adminSessionSecret(explicit) {
  if (explicit) return String(explicit);
  const configured = getKey('ADMIN_SESSION_SECRET');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Admin setup incomplete: set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET.');
  }
  return DEV_SECRET;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

function prune(map, nowMs) {
  for (const [key, value] of map) {
    const until = typeof value === 'number' ? value : Math.max(value.windowUntil || 0, value.lockedUntil || 0);
    if (until <= nowMs) map.delete(key);
  }
  while (map.size > MAX_CACHE) map.delete(map.keys().next().value);
}

export function issueAdminToken(subject, { now = Date.now(), secret, jti = crypto.randomUUID() } = {}) {
  if (!subject) throw new Error('admin token subject required');
  const iat = Math.floor(now / 1000);
  const payload = { sub: String(subject), iat, exp: iat + ADMIN_TOKEN_TTL_SECONDS, jti: String(jti) };
  const encodedHeader = encode(HEADER);
  const encodedPayload = encode(payload);
  const input = `${encodedHeader}.${encodedPayload}`;
  return `adm_${input}.${sign(input, adminSessionSecret(secret)).toString('base64url')}`;
}

export function verifyAdminToken(token, { now = Date.now(), secret, subject } = {}) {
  if (typeof token !== 'string' || !token.startsWith('adm_')) return null;
  try {
    const parts = token.slice(4).split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (header?.alg !== HEADER.alg || header?.typ !== HEADER.typ || Object.keys(header).length !== 2) return null;
    const input = `${encodedHeader}.${encodedPayload}`;
    const expected = sign(input, adminSessionSecret(secret));
    const actual = Buffer.from(encodedSignature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const nowSeconds = Math.floor(now / 1000);
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || !payload.jti) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds) return null;
    if (payload.exp - payload.iat !== ADMIN_TOKEN_TTL_SECONDS) return null;
    if (subject && payload.sub !== subject) return null;
    prune(denied, now);
    if (denied.has(payload.jti)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function revokeAdminToken(token, options = {}) {
  const payload = verifyAdminToken(token, options);
  if (!payload) return false;
  denied.set(payload.jti, payload.exp * 1000);
  prune(denied, options.now || Date.now());
  return true;
}

function attemptKey(ip, username) {
  return `${String(ip || 'unknown').slice(0, 128)}\n${String(username || '').toLowerCase().slice(0, 128)}`;
}

export function adminLoginStatus(ip, username, now = Date.now()) {
  prune(attempts, now);
  const key = attemptKey(ip, username);
  const row = attempts.get(key);
  if (!row) return { allowed: true, retryAfter: 0 };
  if (row.lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((row.lockedUntil - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}

export function recordAdminLoginFailure(ip, username, now = Date.now()) {
  const key = attemptKey(ip, username);
  const prior = attempts.get(key);
  const row = !prior || prior.windowUntil <= now
    ? { failures: 0, windowUntil: now + ATTEMPT_WINDOW_MS, lockedUntil: 0 }
    : { ...prior };
  row.failures += 1;
  if (row.failures >= MAX_FAILURES) row.lockedUntil = now + LOCK_MS;
  attempts.set(key, row);
  prune(attempts, now);
  return adminLoginStatus(ip, username, now);
}

export function clearAdminLoginFailures(ip, username) {
  attempts.delete(attemptKey(ip, username));
}

export function resetAdminSecurityStateForTests() {
  denied.clear();
  attempts.clear();
}
