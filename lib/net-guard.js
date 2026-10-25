import dns from 'node:dns';
import net from 'node:net';

export const DEFAULT_NET_TIMEOUT_MS = 8000;
export const DEFAULT_NET_MAX_BYTES = 5 * 1024 * 1024;

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4(address, base, bits) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value == null || network == null) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(network / size);
}

export function isPrivateAddress(address) {
  const raw = String(address || '').split('%')[0].replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(raw);
  if (family === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ].some(([base, bits]) => inV4(raw, base, bits));
  }
  if (family === 6) {
    if (raw === '::' || raw === '::1') return true;
    if (raw.startsWith('::ffff:')) {
      const tail = raw.slice(7);
      if (net.isIP(tail) === 4) return isPrivateAddress(tail);
      const pair = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(tail);
      if (pair) {
        const high = Number.parseInt(pair[1], 16);
        const low = Number.parseInt(pair[2], 16);
        return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return true;
    }
    const first = Number.parseInt(raw.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  }
  return family === 0;
}

function normalizeLookupResult(result) {
  const rows = Array.isArray(result) ? result : [result];
  return rows.map((row) => typeof row === 'string' ? { address: row, family: net.isIP(row) } : row).filter((row) => row?.address);
}

export async function assertSafeUrl(input, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
  let url;
  try { url = new URL(input); } catch { throw new Error('invalid network URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('credentials in URLs are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : normalizeLookupResult(await lookup(hostname, { all: true, verbatim: true }));
  if (!addresses.length) throw new Error('hostname did not resolve');
  if (!allowPrivate && addresses.some((row) => isPrivateAddress(row.address))) {
    throw new Error('private, local, or reserved network addresses are blocked');
  }
  return { url, addresses };
}

async function limitedResponse(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
}

export async function guardedFetch(input, init = {}, options = {}) {
  const {
    allowPrivate = false,
    lookup = dns.promises.lookup,
    fetchImpl = globalThis.fetch,
    maxRedirects = 3,
    timeoutMs = DEFAULT_NET_TIMEOUT_MS,
    maxBytes = DEFAULT_NET_MAX_BYTES,
    bufferResponse = true
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  let current = (await assertSafeUrl(input, { allowPrivate, lookup })).url;
  let request = { ...init, headers: new Headers(init.headers || {}), redirect: 'manual' };

  for (let redirects = 0; ; redirects += 1) {
    if (redirects > maxRedirects) throw new Error('too many redirects');
    await assertSafeUrl(current, { allowPrivate, lookup });
    const response = await fetchImpl(current, { ...request, signal: combinedSignal(init.signal, timeoutMs) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return bufferResponse ? limitedResponse(response, maxBytes) : response;
    const location = response.headers.get('location');
    if (!location) throw new Error('redirect response has no location');
    const next = new URL(location, current);
    if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS protocol downgrade is blocked');
    await assertSafeUrl(next, { allowPrivate, lookup });
    if (next.origin !== current.origin) {
      request.headers.delete('authorization');
      request.headers.delete('cookie');
      request.headers.delete('proxy-authorization');
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && String(request.method || 'GET').toUpperCase() === 'POST')) {
      request = { ...request, method: 'GET', body: undefined };
      request.headers.delete('content-type');
      request.headers.delete('content-length');
    }
    current = next;
  }
}
