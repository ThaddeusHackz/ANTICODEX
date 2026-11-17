// Image generation — Cloudflare Workers AI Flux (schnell / dev).
//
// Two things this module must never do:
//   1. call a keyless request a "generation" — it returns a labelled local SVG
//      preview instead, with the exact env vars that would make it real;
//   2. swallow a provider error — it throws an Error carrying `statusCode`,
//      `fix` and `retryable`, and api/bridge.js turns that into `{ok:false,...}`
//      so the page can print the sentence instead of a toast that disappears.

import { getKey, CATALOG } from './keys.js';

export const FLUX_FIX =
  'Add CF_ACCOUNT_ID and CF_API_TOKEN in Settings → Media (Cloudflare account id + a token with Workers AI permission), or set the same env vars on the server.';

export const FLUX_MODELS = [
  { id: 'schnell', label: 'Flux 1 schnell', fixed_size: true },
  { id: 'dev', label: 'Flux 1 dev', fixed_size: false }
];

/** The exact credential resolution the generator uses (request/account/device
 *  keys first, then env/runtime config). Kept in one place so /config can report
 *  the same truth instead of a second, drifting guess. */
export function fluxCredentials(keys = {}) {
  const account = (keys && keys.CF_ACCOUNT_ID) || getKey('CF_ACCOUNT_ID');
  const token = (keys && keys.CF_API_TOKEN) || getKey('CF_API_TOKEN');
  const missing = [];
  if (!account) missing.push('CF_ACCOUNT_ID');
  if (!token) missing.push('CF_API_TOKEN');
  return { account, token, missing, configured: missing.length === 0 };
}

function fluxError(message, { status, fix, retryable = true } = {}) {
  const err = new Error(message);
  err.provider = 'cloudflare-flux';
  if (status) err.statusCode = status;
  err.fix = fix || FLUX_FIX;
  err.retryable = retryable;
  return err;
}

function fixForStatus(status) {
  if (status === 401 || status === 403) return 'Cloudflare rejected the credentials. Check that CF_API_TOKEN has Workers AI permission and belongs to the account in CF_ACCOUNT_ID. ' + FLUX_FIX;
  if (status === 404) return 'Cloudflare could not find that account or model. Check CF_ACCOUNT_ID (the 32-character account id, not the account name).';
  if (status === 429) return 'Cloudflare rate-limited this account. Wait a minute and retry, or use fewer images per batch.';
  if (status === 400 || status === 422) return 'Cloudflare rejected the request payload. Try a shorter prompt, or switch between Flux schnell and dev.';
  return FLUX_FIX;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function dimension(value, fallback = 1024) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(Math.round(n / 8) * 8, 256, 2048);
}

export async function generateImage({ prompt, width = 1024, height = 1024, steps = 4, model = 'schnell', keys }) {
  const text = String(prompt || '').trim();
  if (!text) {
    throw fluxError('A prompt is required before Flux can render anything.', {
      status: 400, retryable: false, fix: 'Type what you want to see, then press Generate.'
    });
  }

  const family = String(model || 'schnell').toLowerCase();
  if (family !== 'schnell' && family !== 'dev') {
    throw fluxError(`Unknown Flux model "${model}".`, {
      status: 400, retryable: false, fix: 'Choose Flux schnell (fast) or Flux dev (custom size).'
    });
  }

  let w = dimension(width);
  let h = dimension(height);
  // Cloudflare's flux-1-schnell endpoint renders a fixed 1024×1024 image and
  // does not take a size; only flux-1-dev accepts width/height. Applying this
  // here means the response never claims a size the provider ignored.
  if (family === 'schnell') { w = 1024; h = 1024; }
  const stepCount = family === 'schnell' ? clamp(Math.round(Number(steps) || 4), 1, 8) : clamp(Math.round(Number(steps) || 4), 1, 50);

  const { account, token, missing } = fluxCredentials(keys);
  if (missing.length) {
    return {
      ok: true,
      provider: 'demo',
      demo: true,
      preview: true,
      model: 'demo',
      image: placeholderSvg(text, w, h),
      mime: 'image/svg+xml',
      ext: 'svg',
      width: w,
      height: h,
      prompt: text,
      missing,
      reason: `Cloudflare Flux is not configured here — ${missing.join(' + ')} ${missing.length === 1 ? 'is' : 'are'} missing. This is a local SVG preview, not a generated image.`,
      fix: FLUX_FIX
    };
  }

  const base = family === 'dev' ? CATALOG.flux_pro : CATALOG.flux;
  const url = base.replace('{account}', encodeURIComponent(account));
  const body = { prompt: text, steps: stepCount };
  // `flux-1-dev` takes dimensions; schnell does not (and older code sent
  // `num_steps`, which is not the field name either).
  if (family === 'dev') { body.width = w; body.height = h; }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw fluxError(`Could not reach Cloudflare Flux: ${String(e?.message || e)}`, {
      status: 502, fix: 'Check this machine’s network access to api.cloudflare.com, then retry.'
    });
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.errors?.[0]?.message || parsed?.error || parsed?.message || raw;
    } catch { /* plain text is the detail */ }
    throw fluxError(`Cloudflare Flux failed (${res.status}): ${String(detail || res.statusText || '').slice(0, 300)}`, {
      status: res.status,
      fix: fixForStatus(res.status),
      retryable: res.status === 429 || res.status >= 500
    });
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => null);
    if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length)) {
      const message = data?.errors?.[0]?.message || JSON.stringify(data).slice(0, 300);
      throw fluxError(`Cloudflare Flux returned an error: ${message}`, {
        status: 502, fix: 'Cloudflare accepted the key but rejected the render. Try a different prompt or model.'
      });
    }
    const b64 = data?.result?.image || data?.image || data?.result?.images?.[0];
    if (!b64) {
      throw fluxError('Unexpected Flux JSON payload (no image field).', {
        status: 502, fix: 'Cloudflare answered in a shape this app does not recognise. Retry, then try the other Flux model.'
      });
    }
    return {
      ok: true,
      provider: 'cloudflare-flux',
      demo: false,
      model: family,
      image: `data:image/png;base64,${b64}`,
      mime: 'image/png',
      ext: 'png',
      width: w,
      height: h,
      prompt: text
    };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw fluxError('Cloudflare Flux returned an empty image.', {
      status: 502, fix: 'Retry the render; if it keeps happening, try the other Flux model.'
    });
  }
  const mime = /^image\//.test(contentType) ? contentType.split(';')[0] : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return {
    ok: true,
    provider: 'cloudflare-flux',
    demo: false,
    model: family,
    image: `data:${mime};base64,${buf.toString('base64')}`,
    mime,
    ext,
    width: w,
    height: h,
    prompt: text
  };
}

// Deterministic SVG placeholder (no external deps) for keyless preview mode.
// The prompt only affects the hue; none of its characters enter the markup, so
// a hostile prompt cannot inject SVG. Exported so the test can assert the MIME.
export function placeholderSvg(prompt, w = 1024, h = 1024) {
  const hue = [...String(prompt || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},85%,55%)"/>
      <stop offset="55%" stop-color="hsl(${(hue + 60) % 360},80%,38%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 140) % 360},75%,22%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.18}" fill="hsla(${(hue + 200) % 360},90%,70%,0.55)"/>
  <rect x="${w * 0.08}" y="${h * 0.72}" width="${w * 0.5}" height="10" rx="5" fill="rgba(255,255,255,0.75)"/>
  <rect x="${w * 0.08}" y="${h * 0.78}" width="${w * 0.32}" height="10" rx="5" fill="rgba(255,255,255,0.45)"/>
  <text x="${w * 0.08}" y="${h * 0.66}" fill="rgba(255,255,255,0.9)" font-family="sans-serif" font-size="${Math.max(18, w * 0.032)}">ANTICODEX · Flux preview</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
