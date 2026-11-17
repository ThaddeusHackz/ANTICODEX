// Media studio contract — Flux images and MiniMax Hailuo video.
//
// The failures this suite exists to prevent, all of which shipped at some point:
//   • a keyless "generation" presented as a real render;
//   • a placeholder saved as `.png` when its bytes are SVG;
//   • a provider error that becomes a toast and disappears;
//   • a video poll that gives up after 15 seconds and forgets the job on reload;
//   • a status word ("Preparing", "Running") treated as terminal.
//
// Nothing here calls a provider. Credential resolution, demo labelling and the
// pure polling state machine are what can be proven without a key.
//
// Run: node tests/test-studios.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lib/keys.js resolves its data directory at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-studios-'));
process.env.ANTICODEX_DATA = path.join(tmp, 'data');
for (const name of ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID']) delete process.env[name];

const { generateImage, placeholderSvg, fluxCredentials, FLUX_FIX, FLUX_MODELS } = await import('../lib/flux.js');
const {
  startVideo, queryVideo, mapProviderStatus, MINIMAX_FIX, MINIMAX_FILE_RETRIEVE
} = await import('../lib/minimax.js');
const {
  VIDEO_POLL_BASE_MS, VIDEO_POLL_MAX_MS, appendJobEvent, dataMime, downloadExt, extFromMime,
  formatElapsed, isTerminalVideo, makeId, mapVideoStatus, nextPollDelay, normalizeVideoJob,
  resumeVideoJobs, videoTimeline, withAvoid
} = await import('../web/src/lib/studio.js');
const { CATALOG } = await import('../lib/keys.js');

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// ---------------------------------------------------------------------------
section('Flux — credentials and the honest preview');
{
  const creds = fluxCredentials({});
  ok('no CF_ACCOUNT_ID / CF_API_TOKEN means not configured',
    creds.configured === false && creds.missing.includes('CF_ACCOUNT_ID') && creds.missing.includes('CF_API_TOKEN'));
  ok('a request-scoped key counts as configured',
    fluxCredentials({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' }).configured === true);
  ok('both Flux model ids are in the UI list and are the ones the API accepts',
    FLUX_MODELS.map((m) => m.id).join(',') === 'schnell,dev');
  ok('schnell is documented as fixed-size',
    FLUX_MODELS.find((m) => m.id === 'schnell').fixed_size === true);

  const demo = await generateImage({ prompt: 'a test prism', width: 1344, height: 768, model: 'dev' });
  ok('a keyless render answers ok, not an error', demo.ok === true);
  ok('…and is labelled provider "demo"', demo.provider === 'demo' && demo.demo === true && demo.preview === true);
  ok('…with the exact missing env vars', Array.isArray(demo.missing) && demo.missing.includes('CF_ACCOUNT_ID') && demo.missing.includes('CF_API_TOKEN'));
  ok('…and a reason that says it is a preview, not a generation',
    /preview/i.test(demo.reason) && /not a generated image/i.test(demo.reason));
  ok('its MIME is image/svg+xml (the old code said PNG and saved .png bytes)',
    demo.mime === 'image/svg+xml' && demo.ext === 'svg');
  ok('the data URL really carries that MIME', demo.image.startsWith('data:image/svg+xml;base64,'));
  ok('a dev preview keeps the requested canvas', demo.width === 1344 && demo.height === 768);

  const schnell = await generateImage({ prompt: 'square', width: 1344, height: 768, model: 'schnell' });
  ok('schnell does not claim a canvas it ignores', schnell.width === 1024 && schnell.height === 1024);

  const bad = await generateImage({ prompt: 'x', model: 'sdxl' }).then(() => null, (e) => e);
  ok('an unknown Flux model is refused, not silently swapped', bad && /Unknown Flux model/.test(bad.message));
  ok('…with a fix the page can print', bad && bad.fix && bad.retryable === false);

  const empty = await generateImage({ prompt: '   ' }).then(() => null, (e) => e);
  ok('an empty prompt is refused', empty && /prompt is required/i.test(empty.message));
  ok('the shared Flux fix names both env vars',
    FLUX_FIX.includes('CF_ACCOUNT_ID') && FLUX_FIX.includes('CF_API_TOKEN'));
}

section('the preview SVG is inert');
{
  const hostile = '<script>alert(1)</script><foreignObject onload="x()">';
  const svg = Buffer.from(placeholderSvg(hostile).split(',')[1], 'base64').toString('utf8');
  ok('no prompt characters enter the SVG markup', !svg.includes('<script') && !svg.includes('foreignObject') && !svg.includes('alert(1)'));
  ok('the SVG says it is a preview', svg.includes('Flux preview'));
  ok('the deterministic hue still uses the prompt', placeholderSvg(hostile).split(',')[1] !== placeholderSvg('other').split(',')[1]);
}

// ---------------------------------------------------------------------------
section('MiniMax — queueing, status words and the download step');
{
  ok('the queue endpoint is the catalog endpoint', CATALOG.minimax.video === 'https://api.minimax.io/v1/video_generation');
  ok('the query endpoint is the catalog endpoint', CATALOG.minimax.query === 'https://api.minimax.io/v1/query/video_generation');
  ok('the file-retrieve host is MiniMax, not an invented proxy',
    MINIMAX_FILE_RETRIEVE === 'https://api.minimax.io/v1/files/retrieve');
  ok('the video model list comes from the catalog', CATALOG.minimax.models.includes('MiniMax-Hailuo-2.3'));

  const demo = await startVideo({ prompt: 'a slow orbit of a monolith', duration: 6 });
  ok('a keyless video request returns a simulated job', demo.ok === true && demo.demo === true && demo.status === 'demo');
  ok('…with a real-looking id only because it is local', /^vid_/.test(demo.id));
  ok('…and a reason that says nothing was rendered', /no video was rendered/i.test(demo.reason));
  ok('…and the missing env var named', demo.missing.includes('MINIMAX_API_KEY'));

  const again = await queryVideo(demo.id);
  ok('polling the demo job stays a demo, not a failure', again.ok === true && again.status === 'demo' && again.demo === true);

  const unknown = await queryVideo('task_that_is_not_ours');
  ok('a real job with no key is unknown, not a fake success',
    unknown.ok === false && unknown.status === 'unknown' && unknown.retryable === false);
  ok('…and the message says the provider state is unchanged', /provider/.test(unknown.error));

  const badModel = await startVideo({ prompt: 'x', model: 'not-a-model' }).then(() => null, (e) => e);
  ok('an unknown video model is refused instead of swapped', badModel && /Unknown MiniMax model/.test(badModel.message));
  ok('…with the allowed ids in the fix',
    badModel && CATALOG.minimax.models.every((id) => badModel.fix.includes(id)));

  const empty = await startVideo({ prompt: ' ' }).then(() => null, (e) => e);
  ok('an empty scene prompt is refused', empty && /prompt is required/i.test(empty.message));
  ok('the shared MiniMax fix names the key', MINIMAX_FIX.includes('MINIMAX_API_KEY'));

  ok('provider success words map to ready',
    ['Success', 'succeeded', 'ready', 'completed', 'done'].every((s) => mapProviderStatus(s) === 'ready'));
  ok('provider failure words map to failed',
    ['Fail', 'failed', 'failure', 'error', 'cancelled', 'canceled'].every((s) => mapProviderStatus(s) === 'failed'));
  ok('queueing/preparing/running/unknown stay processing',
    ['Queueing', 'Preparing', 'Processing', 'Running', 'Pending', 'brand-new-word', ''].every((s) => mapProviderStatus(s) === 'processing'));
}

// ---------------------------------------------------------------------------
section('video polling is durable and patient');
{
  ok('a render gets minutes, not six polls',
    nextPollDelay(0) === 4000 && nextPollDelay(1) === 8000 && nextPollDelay(2) === 16000 && nextPollDelay(3) === VIDEO_POLL_MAX_MS);
  ok('backoff is capped', nextPollDelay(30) === VIDEO_POLL_MAX_MS && VIDEO_POLL_MAX_MS === 30000);
  ok('a negative attempt does not produce a negative delay', nextPollDelay(-3) === VIDEO_POLL_BASE_MS);
  ok('base and max are sane', VIDEO_POLL_BASE_MS > 0 && VIDEO_POLL_MAX_MS >= VIDEO_POLL_BASE_MS);

  ok('ready is terminal', isTerminalVideo('ready') === true && isTerminalVideo('Success') === true);
  ok('failed is terminal', isTerminalVideo('failed') === true && isTerminalVideo('FAIL') === true);
  ok('processing is not terminal', isTerminalVideo('processing') === false && isTerminalVideo('Preparing') === false);
  ok('the UI mapping is stable',
    mapVideoStatus('success') === 'ready' && mapVideoStatus('failed') === 'failed'
    && mapVideoStatus('Processing') === 'processing' && mapVideoStatus('') === 'processing');

  const stored = [
    { id: 'a', status: 'Processing', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'b', status: 'Success', created_at: '2026-01-02T00:00:00.000Z', video: 'https://example.com/b.mp4' },
    { id: 'c', status: 'Fail', created_at: '2026-01-03T00:00:00.000Z', error: 'moderation' },
    { id: 'a', status: 'Ready', created_at: '2026-01-01T00:00:00.000Z', video: 'https://example.com/a.mp4' }
  ];
  const resumed = resumeVideoJobs(stored);
  ok('a duplicate id keeps one record', resumed.length === 3);
  ok('…and keeps the newest state, not the first', resumed.find((j) => j.id === 'a').status === 'ready');
  ok('active work is marked for resume', resumed.find((j) => j.id === 'a').resume === false && resumed.find((j) => j.id === 'b').resume === false);
  const live = resumeVideoJobs([{ id: 'live', status: 'Processing', created_at: '2026-01-01T00:00:00.000Z' }]);
  ok('a processing job is marked for resume after reload', live[0].resume === true);
  ok('an unknown future status is kept alive', resumeVideoJobs([{ id: 'x', status: 'Preparing' }])[0].resume === true);
  ok('sorting is newest first',
    resumeVideoJobs([{ id: 'old', status: 'ready', created_at: '2025-01-01T00:00:00Z' }, { id: 'new', status: 'ready', created_at: '2026-01-01T00:00:00Z' }])[0].id === 'new');
  ok('a record without an id is dropped, not shown as untitled forever', resumeVideoJobs([{ status: 'processing' }, null]).length === 0);

  const normalized = normalizeVideoJob({ id: 7, status: 'success', at: '2026-01-01T00:00:00.000Z' });
  ok('an id is normalised to a string', normalized.id === '7');
  ok('created_at falls back to the record time', normalized.created_at === '2026-01-01T00:00:00.000Z');
  ok('a demo cannot be normalised into a success',
    normalizeVideoJob({ id: 'd', demo: true, status: 'success' }).status === 'demo');

  const events = appendJobEvent({ id: 'e', events: [] }, 'queued', '2026-01-01T00:00:00.000Z');
  const twice = appendJobEvent(events, 'processing', '2026-01-01T00:00:05.000Z');
  const repeated = appendJobEvent(twice, 'processing', '2026-01-01T00:00:09.000Z');
  ok('the timeline records each state once', repeated.events.length === 2);
  ok('…and does not rewrite an earlier timestamp', repeated.events[1].at === '2026-01-01T00:00:05.000Z');
  ok('the first state is queued, not processing', repeated.events[0].status === 'queued');

  const timeline = videoTimeline({ id: 't', status: 'processing', created_at: '2026-01-01T00:00:00.000Z', events: repeated.events });
  ok('the timeline has queued → rendering → result', timeline.map((s) => s.id).join(',') === 'queued,processing,ready');
  ok('queued is done and rendering is current',
    timeline[0].state === 'done' && timeline[1].state === 'current' && timeline[2].state === 'pending');
  ok('a failed job’s timeline names Failed, not Ready',
    videoTimeline({ id: 'f', status: 'failed', events: [{ status: 'failed', at: '2026-01-01T00:00:01Z' }] })[2].id === 'failed');

  ok('elapsed time is mm:ss under an hour', formatElapsed(65_000) === '1:05' && formatElapsed(0) === '0:00');
  ok('elapsed time grows to h:mm:ss', formatElapsed(3_661_000) === '1:01:01');
  ok('a negative elapsed time clamps to zero', formatElapsed(-5) === '0:00');
}

// ---------------------------------------------------------------------------
section('media records save with the right file type');
{
  ok('SVG is recognised as .svg', extFromMime('image/svg+xml') === 'svg');
  ok('JPEG, WebP and PNG get real extensions', extFromMime('image/jpeg') === 'jpg' && extFromMime('image/webp') === 'webp' && extFromMime('image/png') === 'png');
  ok('video extensions exist', extFromMime('video/mp4') === 'mp4' && extFromMime('video/webm') === 'webm');
  ok('an unknown type is not given a fake extension', extFromMime('application/octet-stream') === null);
  ok('a data URL exposes its MIME', dataMime('data:image/svg+xml;base64,AAAA') === 'image/svg+xml');
  ok('a demo result saves as .svg even with no ext field',
    downloadExt({ image: 'data:image/svg+xml;base64,AAAA' }) === 'svg');
  ok('an explicit ext wins', downloadExt({ ext: 'mp4', image: 'data:image/png;base64,AAAA' }) === 'mp4');
  ok('no usable type is "bin", not a lie', downloadExt({ image: 'blob:https://example.com/x' }) === 'bin');
  ok('the negative prompt is appended as text, not hidden', withAvoid('a cat', 'blur') === 'a cat\n\nAvoid: blur');
  ok('no negative prompt means no empty suffix', withAvoid('a cat', '   ') === 'a cat');
  ok('generated ids are prefixed and unique', makeId('img') !== makeId('img') && makeId('img').startsWith('img_'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
