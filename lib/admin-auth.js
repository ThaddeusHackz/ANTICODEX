// Expiring admin capabilities, invalidated immediately by credential rotation.
import crypto from 'node:crypto';
import { getKey } from './keys.js';
const TTL = 60 * 60 * 1000;
export function adminCredentials() {
  const username = getKey('ADMIN_USERNAME');
  const password = getKey('ADMIN_PASSWORD');
  return username && password ? { username, password } : null;
}
function mac(payload, c) {
  return crypto.createHmac('sha256', c.password).update(c.username + ':' + payload).digest('base64url');
}
export function issueAdminToken(now = Date.now()) {
  const c = adminCredentials();
  if (!c) return null;
  const payload = Buffer.from(JSON.stringify({ exp: now + TTL, nonce: crypto.randomBytes(24).toString('hex') })).toString('base64url');
  return 'adm_' + payload + '.' + mac(payload, c);
}
export function verifyAdminToken(token, now = Date.now()) {
  const c = adminCredentials();
  if (!c || typeof token !== 'string' || !token.startsWith('adm_')) return false;
  try {
    const [payload, signature, extra] = token.slice(4).split('.');
    if (!payload || !signature || extra) return false;
    const expected = Buffer.from(mac(payload, c)); const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
    const { exp, nonce } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof nonce === 'string' && Number.isFinite(exp) && exp > now && exp <= now + TTL;
  } catch { return false; }
}
