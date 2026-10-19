// ANTICODEX service extras — real integrations behind the unified keychain.
// Voice (ElevenLabs TTS / OpenAI Whisper STT), image search (Unsplash),
// live data (OpenWeather, Windy maps, OpenSky flights, YouTube). Every call
// degrades gracefully when its key is not configured.

import { getKey } from './keys.js';

async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  return { status: res.status, data };
}

const missing = (name) => ({ ok: false, error: `${name} is not configured — add the key in Admin → Keys` });

// --- Unsplash image search ----------------------------------------------------
export async function imageSearch({ query, per_page = 12 }) {
  const key = getKey('UNSPLASH_ACCESS_KEY');
  if (!key) return missing('UNSPLASH_ACCESS_KEY');
  const r = await getJson(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${per_page}`, {
    headers: { Authorization: `Client-ID ${key}` }
  });
  if (r.status >= 300) return { ok: false, error: r.data?.errors?.[0] || 'Unsplash search failed' };
  return {
    ok: true,
    results: (r.data.results || []).map((p) => ({
      id: p.id, thumb: p.urls?.small, full: p.urls?.regular, width: p.width, height: p.height,
      author: p.user?.name, link: p.links?.html, alt: p.alt_description
    }))
  };
}

// --- ElevenLabs text-to-speech ------------------------------------------------
const EL_VOICES = { nova: '21m00Tcm4TlvDq8ikWAM', alloy: 'EXAVITQu4vr4xnSDxMaL', onyx: 'TX3LPaxmHKxFdv7VOQHJ' };
export async function tts({ text, voice = 'nova' }) {
  const key = getKey('ELEVENLABS_API_KEY');
  if (!key) return missing('ELEVENLABS_API_KEY');
  if (!text) return { ok: false, error: 'text required' };
  const voiceId = EL_VOICES[voice] || EL_VOICES.nova;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: String(text).slice(0, 2500), model_id: 'eleven_multilingual_v2' })
  });
  if (!res.ok) return { ok: false, error: `ElevenLabs ${res.status}: ${(await res.text()).slice(0, 160)}` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, audio_base64: buf.toString('base64'), mime: 'audio/mpeg', voice };
}

// --- OpenAI Whisper speech-to-text -------------------------------------------
export async function stt({ audio_base64, mime = 'audio/webm' }) {
  const key = getKey('OPENAI_API_KEY');
  if (!key) return missing('OPENAI_API_KEY');
  if (!audio_base64) return { ok: false, error: 'audio_base64 required' };
  try {
    const bytes = Buffer.from(String(audio_base64).split(',').pop(), 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), 'speech.webm');
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message || `Whisper ${res.status}` };
    return { ok: true, text: data.text };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// --- OpenWeather current + forecast ------------------------------------------
export async function weather({ q, units = 'metric' }) {
  const key = getKey('OPENWEATHER_API_KEY');
  if (!key) return missing('OPENWEATHER_API_KEY');
  const r = await getJson(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&units=${units}&appid=${key}`);
  if (r.status >= 300) return { ok: false, error: r.data?.message || 'OpenWeather lookup failed' };
  const d = r.data;
  return {
    ok: true,
    place: d.name, country: d.sys?.country,
    temp: d.main?.temp, feels: d.main?.feels_like, humidity: d.main?.humidity,
    wind: d.wind?.speed, description: d.weather?.[0]?.description, icon: d.weather?.[0]?.icon
  };
}

// --- Windy map overlay URL ----------------------------------------------------
export function windyMap({ lat, lon, zoom = 8 }) {
  const key = getKey('WINDY_API_KEY');
  if (!key) return missing('WINDY_API_KEY');
  return {
    ok: true,
    url: `https://www.windy.com/embed?location=coordinates&lat=${lat}&lon=${lon}&zoom=${zoom}&detailLat=${lat}&detailLon=${lon}&marker=true&overlay=wind&product=ecmwf&key=${key}`,
    note: 'Embeddable Windy forecast map.'
  };
}

// --- OpenSky live flights -----------------------------------------------------
export async function flights({ lat, lon, radius_km = 250 }) {
  const id = getKey('OPENSKY_CLIENT_ID');
  const secret = getKey('OPENSKY_CLIENT_SECRET');
  if (!id || !secret) return missing('OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET');
  try {
    const tokenRes = await getJson('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString()
    });
    const token = tokenRes.data?.access_token;
    if (!token) return { ok: false, error: tokenRes.data?.error_description || 'OpenSky auth failed' };
    const dLat = radius_km / 111;
    const dLon = radius_km / (111 * Math.max(0.2, Math.cos((lat || 0) * Math.PI / 180)));
    const r = await getJson(`https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lamax=${lat + dLat}&lomin=${lon - dLon}&lomax=${lon + dLon}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const states = (r.data.states || []).slice(0, 25).map((s) => ({
      callsign: (s[1] || '').trim(), origin: s[2], lon: s[5], lat: s[6], altitude_m: s[7], velocity_ms: s[9]
    }));
    return { ok: true, count: states.length, flights: states };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// --- YouTube search (with short cache) ----------------------------------------
const ytCache = new Map();
export async function youtubeSearch({ q, max_results = 8 }) {
  const key = getKey('YOUTUBE_API_KEY');
  if (!key) return missing('YOUTUBE_API_KEY');
  const ttl = Number(getKey('YOUTUBE_CACHE_SECONDS') || 10800) * 1000;
  const ck = `yt:${q}:${max_results}`;
  const hit = ytCache.get(ck);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const r = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${max_results}&q=${encodeURIComponent(q)}&key=${key}`);
  if (r.status >= 300) return { ok: false, error: r.data?.error?.message || 'YouTube search failed' };
  const value = {
    ok: true,
    results: (r.data.items || []).map((i) => ({
      video_id: i.id?.videoId,
      title: i.snippet?.title,
      channel: i.snippet?.channelTitle,
      published: i.snippet?.publishedAt,
      thumb: i.snippet?.thumbnails?.default?.url,
      url: `https://www.youtube.com/watch?v=${i.id?.videoId}`
    }))
  };
  ytCache.set(ck, { at: Date.now(), value });
  return value;
}

// --- dispatcher --------------------------------------------------------------
export async function handleExtras(body) {
  const op = body.op;
  switch (op) {
    case 'image_search': return imageSearch(body);
    case 'tts': return tts(body);
    case 'stt': return stt(body);
    case 'weather': return weather(body);
    case 'windy': return windyMap(body);
    case 'flights': return flights(body);
    case 'youtube': return youtubeSearch(body);
    case 'status': return {
      ok: true,
      services: {
        unsplash: Boolean(getKey('UNSPLASH_ACCESS_KEY')),
        elevenlabs: Boolean(getKey('ELEVENLABS_API_KEY')),
        whisper: Boolean(getKey('OPENAI_API_KEY')),
        openweather: Boolean(getKey('OPENWEATHER_API_KEY')),
        windy: Boolean(getKey('WINDY_API_KEY')),
        opensky: Boolean(getKey('OPENSKY_CLIENT_ID') && getKey('OPENSKY_CLIENT_SECRET')),
        youtube: Boolean(getKey('YOUTUBE_API_KEY')),
        tavily: Boolean(getKey('TAVILY_API_KEY')),
        flux: Boolean(getKey('CF_API_TOKEN') && getKey('CF_ACCOUNT_ID')),
        minimax: Boolean(getKey('MINIMAX_API_KEY')),
        groq: Boolean(getKey('GROQ_API_KEY')),
        nvidia: Boolean(getKey('NVIDIA_API_KEY'))
      }
    };
    default: return { ok: false, error: `unknown extras op: ${op}` };
  }
}

/** Built-in chat tools backed by these services (merged with MCP tools). */
export function builtinTools() {
  const tools = [];
  if (getKey('OPENWEATHER_API_KEY')) tools.push({
    type: 'function',
    function: {
      name: 'weather_lookup', description: 'Current weather for a city (OpenWeather).',
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'City name' } }, required: ['q'] }
    },
    _builtin: 'weather'
  });
  if (getKey('YOUTUBE_API_KEY')) tools.push({
    type: 'function',
    function: {
      name: 'youtube_search', description: 'Search YouTube videos.',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    },
    _builtin: 'youtube'
  });
  if (getKey('UNSPLASH_ACCESS_KEY')) tools.push({
    type: 'function',
    function: {
      name: 'image_search', description: 'Search Unsplash for photos.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    _builtin: 'unsplash'
  });
  return tools;
}

export async function runBuiltin(name, args) {
  if (name === 'weather_lookup') return weather({ q: args.q });
  if (name === 'youtube_search') return youtubeSearch({ q: args.q });
  if (name === 'image_search') return imageSearch({ query: args.query });
  return { error: `unknown builtin tool ${name}` };
}
