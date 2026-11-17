// Video generation — MiniMax Hailuo (H3 series). Async job model.
//
// A Hailuo render takes minutes, so `startVideo` only queues it and every later
// question is answered by `queryVideo`. Two production bugs lived here:
//   • status used only the server key, so a key saved in the account could start
//     a job and then every poll reported "no key" (or a fake demo success);
//   • success returned `minimax:<file_id>`, which no <video> tag can play.
// The file id is now resolved through MiniMax's documented file-retrieve call.

import { getKey, CATALOG } from './keys.js';
import { uid } from './util.js';

const jobs = new Map(); // in-memory metadata cache; the browser keeps the durable copy

// MiniMax's documented download step for a generated file. The host is MiniMax's
// API host; the video/query endpoints themselves still come from CATALOG.
export const MINIMAX_FILE_RETRIEVE = 'https://api.minimax.io/v1/files/retrieve';

export const MINIMAX_FIX =
  'Add MINIMAX_API_KEY (and optionally MINIMAX_GROUP_ID) in Settings → Media, or set the same env vars on the server.';

/** Provider status vocabulary → the three states the UI can act on. */
export function mapProviderStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['success', 'succeeded', 'ready', 'completed', 'done'].includes(s)) return 'ready';
  if (['fail', 'failed', 'failure', 'error', 'cancelled', 'canceled'].includes(s)) return 'failed';
  // Queueing / Processing / Preparing / Running / Pending / an unknown future
  // word: not terminal, so keep polling rather than declaring a result.
  return 'processing';
}

function minmaxError(message, { status, fix, retryable = true } = {}) {
  const err = new Error(message);
  err.provider = 'minimax';
  if (status) err.statusCode = status;
  err.fix = fix || MINIMAX_FIX;
  err.retryable = retryable;
  return err;
}

function fixForStatus(status) {
  if (status === 401 || status === 403) return 'MiniMax rejected the API key. Check MINIMAX_API_KEY in Settings → Media (it must be the Hailuo/video key for this account).';
  if (status === 429) return 'MiniMax rate-limited this account. Wait a minute, then check the job again.';
  if (status >= 500) return 'MiniMax is having a server problem. The job may still finish — retry the status check in a minute.';
  return MINIMAX_FIX;
}

async function readJson(res) {
  const raw = await res.text().catch(() => '');
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { _raw: raw.slice(0, 500) }; }
  return { data, raw };
}

function providerDetail(data) {
  const base = data?.base_resp || {};
  return String(base.status_msg || data?.error || data?.message || data?._raw || '').slice(0, 300);
}

export async function startVideo({ prompt, duration = 6, resolution = '768P', model = 'MiniMax-Hailuo-2.3', image, keys }) {
  const text = String(prompt || '').trim();
  if (!text) {
    throw minmaxError('A prompt is required before Hailuo can render anything.', {
      status: 400, retryable: false, fix: 'Describe the scene, then press Generate video.'
    });
  }

  const allowed = CATALOG.minimax.models || [];
  const chosen = String(model || allowed[0] || 'MiniMax-Hailuo-2.3');
  if (!allowed.includes(chosen)) {
    // The old code silently swapped an unknown model for the first catalog
    // entry — a job that looks like it used your choice but did not.
    throw minmaxError(`Unknown MiniMax model "${chosen}".`, {
      status: 400,
      retryable: false,
      fix: allowed.length ? `Choose one of: ${allowed.join(', ')}.` : 'The provider catalog lists no video models on this server.'
    });
  }

  const key = (keys && keys.MINIMAX_API_KEY) || getKey('MINIMAX_API_KEY');
  const group = (keys && keys.MINIMAX_GROUP_ID) || getKey('MINIMAX_GROUP_ID');
  const seconds = Math.max(1, Math.round(Number(duration) || 6));

  if (!key) {
    const id = uid('vid');
    const job = {
      ok: true,
      id,
      status: 'demo',
      demo: true,
      provider: 'demo',
      prompt: text,
      model: chosen,
      duration: seconds,
      resolution,
      created_at: new Date().toISOString(),
      missing: ['MINIMAX_API_KEY'],
      reason: 'MiniMax Hailuo is not configured here — MINIMAX_API_KEY is missing. This is a simulated job; no video was rendered.',
      fix: MINIMAX_FIX
    };
    jobs.set(id, job);
    return job;
  }

  let res;
  try {
    res = await fetch(CATALOG.minimax.video, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: chosen,
        prompt: text,
        duration: seconds,
        resolution,
        ...(image ? { first_frame_image: image } : {}),
        ...(group ? { group_id: group } : {})
      })
    });
  } catch (e) {
    throw minmaxError(`Could not reach MiniMax: ${String(e?.message || e)}`, {
      status: 502, fix: 'Check this machine’s network access to api.minimax.io, then retry.'
    });
  }

  const { data } = await readJson(res);
  const base = data.base_resp;
  if (!res.ok || (base && base.status_code && base.status_code !== 0)) {
    throw minmaxError(`MiniMax video failed (${res.status || 'no HTTP status'}): ${providerDetail(data) || 'no detail returned'}`, {
      status: res.status || 502,
      fix: fixForStatus(res.status || 502),
      retryable: res.status === 429 || res.status >= 500
    });
  }

  if (!data.task_id) {
    // Never fabricate a job id: a fake id can be persisted and polled forever.
    throw minmaxError('MiniMax accepted the request but returned no task_id, so this job cannot be tracked.', {
      status: 502, fix: 'Retry the render. If it keeps happening, the provider response shape has changed.'
    });
  }

  const job = {
    ok: true,
    id: String(data.task_id),
    status: 'queued',
    provider: 'minimax',
    provider_status: data.status || null,
    prompt: text,
    model: chosen,
    duration: seconds,
    resolution,
    created_at: new Date().toISOString()
  };
  jobs.set(job.id, job);
  return job;
}

async function retrieveFile(fileId, { key, group }) {
  const url = `${MINIMAX_FILE_RETRIEVE}?file_id=${encodeURIComponent(fileId)}${group ? `&group_id=${encodeURIComponent(group)}` : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    throw minmaxError(`Could not reach MiniMax to resolve the finished file: ${String(e?.message || e)}`, {
      status: 502, fix: 'The render finished; retry the status check to fetch the download link.'
    });
  }
  const { data } = await readJson(res);
  const base = data.base_resp;
  if (!res.ok || (base && base.status_code && base.status_code !== 0)) {
    throw minmaxError(`MiniMax file lookup failed (${res.status || 'no HTTP status'}): ${providerDetail(data) || 'no detail returned'}`, {
      status: res.status || 502,
      fix: 'The render finished but its download link could not be resolved. Retry the status check.',
      retryable: res.status === 429 || res.status >= 500
    });
  }
  const download = data?.file?.download_url;
  if (!download) {
    throw minmaxError('MiniMax file lookup returned no download_url.', {
      status: 502, fix: 'The render finished but no playable file was returned. Retry the status check.'
    });
  }
  return { download_url: download, filename: data.file.filename || null, bytes: data.file.bytes || null };
}

export async function queryVideo(id, { keys } = {}) {
  const jobId = String(id || '').trim();
  if (!jobId) {
    throw minmaxError('A MiniMax job id is required to check a render.', {
      status: 400, retryable: false, fix: 'Open Video Studio and start a job, or retry the saved job from its card.'
    });
  }

  const cached = jobs.get(jobId);
  const key = (keys && keys.MINIMAX_API_KEY) || getKey('MINIMAX_API_KEY');
  const group = (keys && keys.MINIMAX_GROUP_ID) || getKey('MINIMAX_GROUP_ID');

  if (!key) {
    if (cached?.demo) {
      return { ...cached, ok: true, status: 'demo', demo: true };
    }
    return {
      ok: false,
      id: jobId,
      status: 'unknown',
      error: 'This bridge has no MiniMax key, so it cannot ask MiniMax about that job. If the job was real, its status is unchanged at the provider.',
      fix: MINIMAX_FIX,
      retryable: false,
      ...(cached ? { prompt: cached.prompt, model: cached.model, duration: cached.duration, resolution: cached.resolution } : {})
    };
  }

  let res;
  try {
    res = await fetch(`${CATALOG.minimax.query}?task_id=${encodeURIComponent(jobId)}${group ? `&group_id=${encodeURIComponent(group)}` : ''}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
  } catch (e) {
    throw minmaxError(`Could not reach MiniMax to check that job: ${String(e?.message || e)}`, {
      status: 502, fix: 'Your job is still at the provider. Retry the status check in a minute.'
    });
  }

  const { data } = await readJson(res);
  const base = data.base_resp;
  if (!res.ok || (base && base.status_code && base.status_code !== 0)) {
    throw minmaxError(`MiniMax status check failed (${res.status || 'no HTTP status'}): ${providerDetail(data) || 'no detail returned'}`, {
      status: res.status || 502,
      fix: fixForStatus(res.status || 502),
      retryable: res.status === 429 || res.status >= 500
    });
  }
  if (!data.status) {
    throw minmaxError('MiniMax returned no status for that job.', {
      status: 502, fix: 'The job may still be running. Retry the status check.'
    });
  }

  const status = mapProviderStatus(data.status);
  const job = {
    ok: true,
    id: jobId,
    status,
    provider: 'minimax',
    provider_status: data.status,
    model: cached?.model,
    prompt: cached?.prompt,
    duration: cached?.duration,
    resolution: cached?.resolution,
    file_id: data.file_id || null,
    video: null,
    updated_at: new Date().toISOString()
  };

  if (status === 'failed') {
    job.error = (base?.status_msg && !/^success$/i.test(base.status_msg) ? base.status_msg : null)
      || data.fail_reason || data.error || 'MiniMax reported the job failed.';
    job.fix = 'Retry the prompt as a new job. If it fails the same way, shorten the prompt or change the model/duration.';
  }

  if (status === 'ready') {
    if (data.video_url) {
      job.video = data.video_url;
    } else if (data.file_id) {
      try {
        const file = await retrieveFile(data.file_id, { key, group });
        job.video = file.download_url;
        job.filename = file.filename;
        job.bytes = file.bytes;
      } catch (e) {
        // The render itself succeeded; report the missing playable file without
        // pretending the job failed or inventing a URL.
        job.video_error = String(e?.message || e);
        job.video_fix = e?.fix || 'Retry the status check to fetch the download link.';
      }
    } else {
      job.video_error = 'MiniMax reported success but returned no file id or video URL.';
      job.video_fix = 'Retry the status check; if it persists, queue the job again.';
    }
  }

  jobs.set(jobId, { ...(cached || {}), ...job });
  if (jobs.size > 300) jobs.delete(jobs.keys().next().value);
  return job;
}
