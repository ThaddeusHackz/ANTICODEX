// Image generation — Cloudflare Workers AI Flux (schnell / dev).

import { getKey, CATALOG } from './keys.js';
import { guardedFetch } from './net-guard.js';

export async function generateImage({ prompt, width = 1024, height = 1024, steps = 4, model = 'schnell', keys }) {
  const account = (keys && keys.CF_ACCOUNT_ID) || getKey('CF_ACCOUNT_ID');
  const token = (keys && keys.CF_API_TOKEN) || getKey('CF_API_TOKEN');
  if (!account || !token) {
    return { provider: 'demo', demo: true, image: placeholderPng(prompt, width, height), model: 'demo' };
  }
  const base = model === 'dev' ? CATALOG.flux_pro : CATALOG.flux;
  const url = base.replace('{account}', account);
  const res = await guardedFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, num_steps: steps, width, height })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Cloudflare Flux failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    const b64 = data?.result?.image;
    if (b64) return { provider: 'cloudflare-flux', model, image: `data:image/png;base64,${b64}` };
    throw new Error('Unexpected Flux JSON payload: ' + JSON.stringify(data).slice(0, 200));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { provider: 'cloudflare-flux', model, image: `data:image/png;base64,${buf.toString('base64')}` };
}

// Deterministic SVG placeholder (no external deps) for keyless demo mode.
function placeholderPng(prompt, w, h) {
  const hue = [...prompt].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
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
