// Video generation — MiniMax Hailuo (H3 series). Async job model.

import { getKey, CATALOG } from './keys.js';
import { uid } from './util.js';

const jobs = new Map(); // in-memory job registry (also mirrored to the store by the route)

export async function startVideo({ prompt, duration = 6, resolution = '768P', model = 'MiniMax-Hailuo-2.3', image }) {
  const key = getKey('MINIMAX_API_KEY');
  const group = getKey('MINIMAX_GROUP_ID');

  if (!key) {
    const id = uid('vid');
    jobs.set(id, { id, status: 'demo', prompt, model: 'demo-h3', duration, resolution, created_at: new Date().toISOString(), demo: true });
    return jobs.get(id);
  }

  const res = await fetch(CATALOG.minimax.video, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: CATALOG.minimax.models.includes(model) ? model : CATALOG.minimax.models[0],
      prompt,
      duration,
      resolution,
      ...(image ? { first_frame_image: image } : {}),
      ...(group ? { group_id: group } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax video failed: ${res.status} ${JSON.stringify(data.base_resp || data).slice(0, 300)}`);
  }
  const id = data.task_id || uid('vid');
  const job = { id, status: 'queued', prompt, model, duration, resolution, created_at: new Date().toISOString() };
  jobs.set(id, job);
  return job;
}

export async function queryVideo(id) {
  const cached = jobs.get(id);
  const key = getKey('MINIMAX_API_KEY');
  if (!key) {
    return cached
      ? { ...cached, status: 'ready', video: 'demo', demo: true, note: 'MiniMax key not configured — this is a simulated job.' }
      : { id, status: 'unknown' };
  }
  const group = getKey('MINIMAX_GROUP_ID');
  const res = await fetch(`${CATALOG.minimax.query}?task_id=${encodeURIComponent(id)}${group ? `&group_id=${encodeURIComponent(group)}` : ''}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`MiniMax query failed: ${res.status}`);
  const status = data.status === 'Success' || data.status === 'success' ? 'ready'
    : data.status === 'Fail' ? 'failed' : 'processing';
  const job = {
    id,
    status,
    model: cached?.model,
    prompt: cached?.prompt,
    video: data.file_id ? `minimax:${data.file_id}` : (data.video_url || null),
    raw: data
  };
  jobs.set(id, { ...(cached || {}), ...job });
  return job;
}
