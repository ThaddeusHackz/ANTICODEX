import path from 'node:path';

export const RENDERER_STATE_KEYS = new Set(['theme', 'accent', 'density', 'sidebar', 'recent', 'onboarding']);
const BUTTONS = new Set(['left', 'middle', 'right']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function validatedAppUrl(value, { allowFile = false } = {}) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (allowFile && url.protocol === 'file:') return url.toString();
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || url.hostname.startsWith('127.'))) return url.toString();
  } catch { /* invalid */ }
  return null;
}

export function isTrustedFrameUrl(value, appOrigin) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      if (!appOrigin) return true;
      const expectedFile = new URL(appOrigin);
      return expectedFile.protocol === 'file:' && path.dirname(url.pathname) === path.dirname(expectedFile.pathname);
    }
    const expected = new URL(appOrigin);
    return url.origin === expected.origin &&
      (LOOPBACK.has(url.hostname) || url.hostname.startsWith('127.'));
  } catch { return false; }
}

export function isTrustedSender(event, appOrigin) {
  const frame = event?.senderFrame;
  if (frame?.parent) return false;
  const value = frame?.url || event?.sender?.getURL?.() || '';
  return isTrustedFrameUrl(value, appOrigin);
}

export function navigationAllowed(value, { appOrigin, startUrl } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      const files = [appOrigin, startUrl].filter(Boolean).map((item) => new URL(item)).filter((item) => item.protocol === 'file:');
      return files.some((item) => path.dirname(item.pathname) === path.dirname(url.pathname));
    }
    const allowed = [appOrigin, startUrl].filter(Boolean).map((item) => new URL(item).origin);
    return allowed.includes(url.origin);
  } catch { return false; }
}

export function filterStatePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of RENDERER_STATE_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'boolean' || typeof value === 'number' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => String(item).slice(0, 200));
    else if (value && typeof value === 'object') out[key] = Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [String(k).slice(0, 80), typeof v === 'boolean' || typeof v === 'number' ? v : String(v).slice(0, 200)]));
  }
  return out;
}

function finiteInt(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`);
  return value;
}

export function validateComputerArgs(command, args = {}, bounds = { x: -32768, y: -32768, width: 65536, height: 65536 }) {
  const minX = Math.trunc(bounds.x);
  const minY = Math.trunc(bounds.y);
  const maxX = minX + Math.max(1, Math.trunc(bounds.width)) - 1;
  const maxY = minY + Math.max(1, Math.trunc(bounds.height)) - 1;
  if (command === 'move' || command === 'click') {
    const out = {
      x: finiteInt(args.x, minX, maxX, 'x'),
      y: finiteInt(args.y, minY, maxY, 'y')
    };
    if (command === 'click') {
      out.button = BUTTONS.has(args.button) ? args.button : 'left';
      out.count = finiteInt(args.count ?? 1, 1, 3, 'count');
    }
    return out;
  }
  if (command === 'type') {
    if (typeof args.text !== 'string' || args.text.length > 10000) throw new Error('text must be at most 10000 characters');
    return { text: args.text };
  }
  if (command === 'key') {
    const combo = String(args.combo || '').trim();
    if (!combo || combo.length > 80 || !/^[A-Za-z0-9+_-]+$/.test(combo)) throw new Error('invalid key combination');
    return { combo };
  }
  if (command === 'launch') {
    if (typeof args.target !== 'string' || !path.isAbsolute(args.target) || args.target.length > 4096) throw new Error('launch target must be an absolute path');
    if (!Array.isArray(args.args) || args.args.length > 40 || args.args.some((arg) => typeof arg !== 'string' || arg.length > 1000)) throw new Error('invalid launch arguments');
    return { target: path.normalize(args.target), args: [...args.args] };
  }
  if (command === 'shell') {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 8000) throw new Error('invalid shell command');
    return { command: args.command };
  }
  if (command === 'screenshot' || command === 'windows') return {};
  throw new Error(`unknown computer command: ${command}`);
}

export function executableAllowed(target, allowlist = []) {
  const normalized = path.resolve(target);
  const base = path.basename(normalized).toLowerCase();
  return allowlist.some((entry) => {
    const candidate = String(entry || '').trim();
    if (!candidate) return false;
    return path.isAbsolute(candidate) ? path.resolve(candidate) === normalized : candidate.toLowerCase() === base;
  });
}

export function parseUpdateDigest(digest, assetName, sumsText = '') {
  const direct = /^sha256:([a-f0-9]{64})$/i.exec(String(digest || '').trim());
  if (direct) return direct[1].toLowerCase();
  const wanted = path.basename(String(assetName || ''));
  for (const line of String(sumsText || '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match && path.basename(match[2]) === wanted) return match[1].toLowerCase();
  }
  return null;
}

const UPDATE_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

export function updateUrlAllowed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && UPDATE_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}
