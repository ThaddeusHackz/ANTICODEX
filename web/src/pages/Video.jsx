import React, { useEffect, useRef, useState } from 'react';
import { videoStart, videoStatus, config as readConfig } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, CopyBtn, Empty } from '../ui.jsx';
import {
  appendJobEvent,
  formatElapsed,
  isTerminalVideo,
  mapVideoStatus,
  nextPollDelay,
  normalizeVideoJob,
  readJson,
  resumeVideoJobs,
  videoTimeline,
  writeJson
} from '../lib/studio.js';
import '../studio.css';

const PRESETS = [
  { label: 'Neon drone flight', prompt: 'Cinematic drone flight over a neon megacity at dusk, volumetric fog, slow push-in, rain reflections' },
  { label: 'Desert monolith', prompt: 'A black monolith on a wind-carved desert plain at golden hour, long shadows, slow orbit, anamorphic lens' },
  { label: 'Deep ocean', prompt: 'A bioluminescent jellyfish drifting through a dark deep-ocean trench, particles in the water, macro detail, slow camera' },
  { label: 'Workshop macro', prompt: 'Macro shot of a watchmaker assembling a movement, warm task light, shallow depth of field, precise mechanical detail' },
  { label: 'Storm ridge', prompt: 'A lone hiker on a storm-lit mountain ridge, clouds racing past, handheld camera, dramatic scale, cold blue palette' }
];

const RESOLUTIONS = ['768P', '1080P'];
const DURATIONS = [6, 10];

function readJobs() {
  const stored = readJson('acx_videos', []);
  return resumeVideoJobs(stored);
}

function storageShape(job) {
  const { checking, resume, ...rest } = job;
  return { ...rest, checking: false };
}

function failureFrom(e, title) {
  const data = e?.data || {};
  return {
    title,
    error: data.error || e?.message || 'The video request failed.',
    fix: data.fix || e?.fix || 'Check that this device can reach the bridge and api.minimax.io, then retry.'
  };
}

function statusLabel(status) {
  if (String(status || '').trim().toLowerCase() === 'queued') return 'Queued';
  const s = mapVideoStatus(status);
  if (s === 'demo') return 'Preview';
  if (s === 'ready') return 'Ready';
  if (s === 'failed') return 'Failed';
  return 'Rendering';
}

function statusKind(status) {
  const s = mapVideoStatus(status);
  if (s === 'ready') return 'ok';
  if (s === 'failed') return 'danger';
  return 'warn';
}

function timeOf(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Timeline({ job }) {
  return (
    <div className="studio-timeline" aria-label="Job timeline">
      {videoTimeline(job).map((step) => (
        <div key={step.id} className={`studio-step ${step.state}`}>
          <span className="studio-step-dot" />
          <div className="studio-step-body">
            <div className="studio-step-label">{step.label}</div>
            <div className="studio-step-time">{timeOf(step.at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function VideoJob({ job, now, busy, onRetry, onDelete, onCheckNow }) {
  const rawStatus = String(job.status || '').trim().toLowerCase();
  const status = rawStatus === 'queued' ? 'queued' : mapVideoStatus(job.status);
  const active = !isTerminalVideo(status);
  const rendering = status === 'processing' || status === 'queued';
  const elapsed = job.created_at ? Math.max(0, now - Date.parse(job.created_at)) : 0;
  const providerError = job.poll_error || (status === 'failed' ? job.error : '');
  const providerFix = job.poll_fix || (status === 'failed' ? job.fix : '');
  const checked = job.last_checked_at ? `last check ${timeOf(job.last_checked_at)}` : 'not checked yet';

  return (
    <div className="card studio-job">
      <div className="studio-job-head">
        <div className="studio-job-main">
          <div className="studio-job-title">{job.prompt || 'Untitled job'}</div>
          <div className="studio-job-meta">
            {job.model && <span>{job.model}</span>}
            {job.duration && <span>{job.duration}s</span>}
            {job.resolution && <span>{job.resolution}</span>}
            <span className="studio-job-id" title="MiniMax task id">{job.id}</span>
          </div>
          {job.provider_status && status !== 'demo' && (
            <div className="studio-job-meta"><span>provider status: {job.provider_status}</span></div>
          )}
        </div>
        <Pill kind={statusKind(status)}>{statusLabel(status)}</Pill>
      </div>

      <Timeline job={job} />

      {status === 'demo' && (
        <div className="studio-demo">
          <div className="studio-demo-title">Simulated job — no video was rendered</div>
          <p className="studio-demo-body">
            {job.reason || 'MiniMax Hailuo is not configured on this server.'}{' '}
            Add <b>MINIMAX_API_KEY</b> (and optionally <b>MINIMAX_GROUP_ID</b>) in Settings → Media, press
            Recheck status on this page, then queue the job again. This card never pretends the preview is a file.
          </p>
        </div>
      )}

      {rendering && (
        <div className="studio-progress">
          <span className="studio-spinner" aria-hidden="true" />
          <div className="studio-progress-main">
            <div className="studio-progress-title">
              {status === 'queued' ? 'Queued — waiting for MiniMax…' : 'Rendering with Hailuo…'}{' '}
              <span className="studio-elapsed">{formatElapsed(elapsed)}</span>
            </div>
            <div className="tiny">
              {job.checking ? 'checking status now…' : `${checked} · auto-check ${Number(job.poll_attempt) || 0}`} ·
              this job is saved in this browser, so polling resumes after a reload
            </div>
          </div>
          <button className="btn small ghost" onClick={() => onCheckNow(job.id)} disabled={job.checking}>Check now</button>
        </div>
      )}

      {status === 'ready' && job.video && (
        <div className="media-frame studio-media">
          <video className="studio-video" src={job.video} controls preload="metadata" />
        </div>
      )}

      {status === 'ready' && !job.video && (
        <div className="studio-file">
          <span>
            MiniMax finished the render{job.file_id ? <> — file <span className="mono">{job.file_id}</span></> : ''}, but no playable
            download link was returned. {job.video_error || ''}
          </span>
          <button className="btn small ghost" onClick={() => onCheckNow(job.id)} disabled={job.checking}>Refresh file</button>
        </div>
      )}

      {providerError && (
        <div className="studio-alert" role="alert">
          <div className="studio-alert-title">{status === 'failed' ? 'MiniMax reported a failed job' : 'Status check failed'}</div>
          <div className="studio-alert-body">{providerError}</div>
          {providerFix && <div className="studio-fix">Fix: {providerFix}</div>}
          <div className="studio-actions-row">
            {active && <button className="btn small ghost" onClick={() => onCheckNow(job.id)} disabled={job.checking}>Check again</button>}
            {!active && <button className="btn small ghost" onClick={() => onRetry(job)} disabled={busy}>Retry as new job</button>}
          </div>
        </div>
      )}

      <div className="studio-actions-row">
        {status === 'ready' && job.video && (
          <a className="btn small ghost" href={job.video} download={`anticodex-${job.id}.mp4`} target="_blank" rel="noreferrer">↓ Save</a>
        )}
        {(status === 'failed' || status === 'demo') && (
          <button className="btn small ghost" onClick={() => onRetry(job)} disabled={busy}>Retry</button>
        )}
        {status === 'ready' && !job.video && (
          <button className="btn small ghost" onClick={() => onCheckNow(job.id)} disabled={job.checking}>Refresh file</button>
        )}
        <CopyBtn text={job.prompt || ''} label="Copy prompt" />
        <button className="btn small danger" onClick={() => onDelete(job.id)}>Delete</button>
        {active && <span className="tiny">elapsed {formatElapsed(elapsed)}</span>}
      </div>
    </div>
  );
}

export default function VideoPage() {
  const { notify, cfg, setCfg } = useApp();
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(6);
  const [resolution, setResolution] = useState('768P');
  const [model, setModel] = useState('');
  const [jobs, setJobs] = useState(readJobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [storageError, setStorageError] = useState(null);
  const [verify, setVerify] = useState('idle');
  const [now, setNow] = useState(Date.now());

  const jobsRef = useRef(jobs);
  const timers = useRef(new Map());
  const alive = useRef(true);

  const videoModels = cfg?.media?.video_models || [];
  const configured = Boolean(cfg?.minimax_configured);
  const missing = cfg?.minimax_missing?.length ? cfg.minimax_missing : ['MINIMAX_API_KEY'];
  const active = jobs.some((job) => !isTerminalVideo(job.status));

  let badgeKind = 'warn';
  let badgeLabel = 'Preview only';
  if (!cfg) { badgeKind = ''; badgeLabel = 'Checking status'; }
  else if (verify === 'ok') { badgeKind = 'ok'; badgeLabel = 'Hailuo live'; }
  else if (verify === 'error') { badgeKind = 'danger'; badgeLabel = 'Hailuo error'; }
  else if (verify === 'demo' || !configured) { badgeKind = 'warn'; badgeLabel = 'Preview only'; }
  else { badgeKind = 'warn'; badgeLabel = 'Hailuo key found'; }

  let statusText = cfg?.minimax_reason || (cfg
    ? `Missing ${missing.join(' + ')}. Add it in Settings → Media, or set the same env var on the server.`
    : 'Reading the provider status from the bridge…');
  if (verify === 'ok') statusText = 'A live Hailuo job was accepted in this session. Polling survives a reload; the provider renders in minutes, so the timeline is the source of truth.';
  if (verify === 'error' && error) statusText = `${error.error} ${error.fix || ''}`.trim();

  useEffect(() => {
    const list = cfg?.media?.video_models || [];
    if (list.length && !list.includes(model)) setModel(list[0]);
  }, [cfg, model]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  function persist(next) {
    const saved = writeJson('acx_videos', next.map(storageShape).slice(0, 20));
    if (!saved.ok) setStorageError(saved.error);
    else setStorageError(null);
    return saved;
  }

  function commit(next) {
    jobsRef.current = next;
    setJobs(next);
    persist(next);
  }

  function addJob(job) {
    const next = [job, ...jobsRef.current.filter((j) => j.id !== job.id)].slice(0, 20);
    commit(next);
  }

  function updateJob(id, patch) {
    const next = jobsRef.current.map((job) => (job.id === id ? { ...job, ...patch } : job));
    commit(next);
  }

  function clearTimer(id) {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }

  function schedule(id, attempt = 0, delay) {
    clearTimer(id);
    if (!alive.current) return;
    const wait = Number.isFinite(delay) ? delay : nextPollDelay(attempt);
    const timer = setTimeout(() => {
      timers.current.delete(id);
      checkJob(id, attempt);
    }, wait);
    timers.current.set(id, timer);
  }

  async function checkJob(id, attempt = 0) {
    if (!alive.current) return;
    const current = jobsRef.current.find((job) => job.id === id);
    if (!current || isTerminalVideo(current.status)) return;

    updateJob(id, { checking: true, poll_error: null, poll_fix: null, last_checked_at: new Date().toISOString() });

    let r;
    try {
      r = await videoStatus(id);
    } catch (e) {
      if (!alive.current) return;
      const data = e?.data || {};
      updateJob(id, {
        checking: false,
        poll_attempt: attempt + 1,
        poll_error: data.error || e?.message || 'The status check failed.',
        poll_fix: data.fix || ''
      });
      if (data.retryable !== false) schedule(id, attempt + 1);
      return;
    }
    if (!alive.current) return;

    if (r?.ok === false) {
      updateJob(id, {
        checking: false,
        poll_attempt: attempt + 1,
        poll_error: r.error || 'The status check failed.',
        poll_fix: r.fix || ''
      });
      // An unknown id or a missing key will not fix itself by polling.
      if (r.retryable !== false && r.status !== 'unknown') schedule(id, attempt + 1);
      return;
    }

    const status = mapVideoStatus(r.status);
    if (status === 'ready') setVerify('ok');
    if (status === 'demo') setVerify('demo');

    const patch = {};
    for (const [key, value] of Object.entries(r || {})) {
      if (value !== undefined && value !== null) patch[key] = value;
    }
    if (status === 'ready') {
      // A later successful lookup clears an earlier "no download link" note.
      patch.video_error = r.video_error || null;
      patch.video_fix = r.video_fix || null;
    }
    const merged = appendJobEvent(
      { ...current, ...patch, status, checking: false, poll_error: null, poll_fix: null },
      status
    );
    updateJob(id, {
      ...merged,
      poll_attempt: status === 'processing' ? attempt + 1 : 0,
      next_check_at: null,
      last_checked_at: new Date().toISOString()
    });
    if (status === 'processing') schedule(id, attempt + 1);
  }

  function checkNow(id) {
    if (!alive.current) return;
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job || job.checking || isTerminalVideo(job.status)) return;
    clearTimer(id);
    checkJob(id, Number(job.poll_attempt) || 0);
  }

  useEffect(() => {
    alive.current = true;
    for (const job of jobsRef.current) {
      if (!isTerminalVideo(job.status)) schedule(job.id, Number(job.poll_attempt) || 0, 900);
    }
    return () => {
      alive.current = false;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
    // Mount only: `schedule`/`checkJob` read the live job list through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function recheck() {
    try {
      const next = await readConfig();
      setCfg(next);
      notify('Provider status refreshed');
    } catch (e) {
      notify(e?.message || 'Could not read provider status', 'error');
    }
  }

  async function queue(overrides = {}) {
    if (busy) return;
    const text = String(overrides.prompt ?? prompt).trim();
    const chosenModel = overrides.model || model;
    if (!text) {
      setError({ title: 'Add a scene', error: 'Hailuo needs a prompt describing the video.', fix: 'Type a scene or pick one of the presets above.' });
      return;
    }
    if (!chosenModel) {
      setError({ title: 'No video model available', error: 'The bridge did not report a MiniMax video model.', fix: 'Press Recheck status. If the list stays empty, check that the server catalog loads.' });
      return;
    }

    const seconds = Number(overrides.duration ?? duration) || 6;
    const res = overrides.resolution || resolution;
    setBusy(true);
    setError(null);
    try {
      const r = await videoStart({ prompt: text, duration: seconds, resolution: res, model: chosenModel });
      if (r?.ok === false) {
        setError({ title: 'Hailuo did not queue the job', error: r.error || 'MiniMax returned an error.', fix: r.fix || '' });
        setVerify('error');
        return;
      }
      if (!r?.id) {
        setError({ title: 'Hailuo returned no task id', error: 'The bridge answered without a job id, so this job cannot be tracked.', fix: 'Try again; if it repeats, the provider response shape has changed.' });
        setVerify('error');
        return;
      }
      const rawStatus = String(r.status || 'queued').trim().toLowerCase();
      const status = r.demo ? 'demo' : rawStatus === 'queued' ? 'queued' : mapVideoStatus(rawStatus);
      const base = normalizeVideoJob({
        ...r,
        id: String(r.id),
        status,
        demo: Boolean(r.demo),
        prompt: text,
        model: chosenModel,
        duration: seconds,
        resolution: res,
        at: r.created_at || new Date().toISOString(),
        poll_attempt: 0
      });
      const job = appendJobEvent(base, status);
      addJob(job);

      if (status === 'demo') {
        setVerify('demo');
        notify('Preview job created — add MINIMAX_API_KEY for real Hailuo video');
      } else {
        setVerify('ok');
        notify('Hailuo job queued — polling resumes after a reload');
        // Give the provider a moment, then start the durable poll loop.
        schedule(job.id, 0, 1200);
      }
    } catch (e) {
      setError(failureFrom(e, 'Could not queue the video'));
      setVerify('error');
    } finally {
      setBusy(false);
    }
  }

  function retry(job) {
    if (busy) return;
    queue({
      prompt: job.prompt || '',
      duration: job.duration || duration,
      resolution: job.resolution || resolution,
      model: job.model || model
    });
  }

  function deleteJob(id) {
    clearTimer(id);
    commit(jobsRef.current.filter((job) => job.id !== id));
    notify('Video job removed');
  }

  function clearHistory() {
    if (!jobs.length) return;
    if (!window.confirm(`Remove all ${jobs.length} video job${jobs.length === 1 ? '' : 's'} from this device? Jobs already finished at MiniMax are not deleted there.`)) return;
    for (const id of timers.current.keys()) clearTimer(id);
    commit([]);
    notify('Video history cleared');
  }

  return (
    <div className="content-wide">
      <div className="row between studio-head">
        <div className="studio-head-main">
          <h2 className="studio-title">Video Studio</h2>
          <p className="muted studio-sub">
            Text-to-video on <b>MiniMax Hailuo (H3)</b>. Renders take minutes, so jobs are saved in this browser and
            the status poll resumes after a reload. History is local; Library reads the same list.
          </p>
        </div>
        <div className="studio-head-side">
          <Pill kind={badgeKind}>{badgeLabel}</Pill>
        </div>
      </div>

      <div className="studio-status">
        <span className={`studio-status-dot ${verify === 'ok' ? 'ok' : verify === 'error' ? 'danger' : 'warn'}`} />
        <div className="studio-status-body">
          <div className="studio-status-label">{badgeLabel}</div>
          <div className="studio-status-reason">{statusText}</div>
        </div>
        <button className="btn small ghost" onClick={recheck}>Recheck status</button>
      </div>

      {storageError && (
        <div className="studio-alert" role="alert">
          <div className="studio-alert-title">Job history was not saved</div>
          <div className="studio-alert-body">{storageError}</div>
          <div className="studio-fix">Fix: clear older jobs or download finished videos, then keep this tab open until the current job reaches Ready.</div>
        </div>
      )}

      {error && (
        <div className="studio-alert" role="alert">
          <div className="studio-alert-title">{error.title}</div>
          <div className="studio-alert-body">{error.error}</div>
          {error.fix && <div className="studio-fix">Fix: {error.fix}</div>}
          <div className="studio-actions-row">
            <button className="btn small primary" onClick={() => queue()} disabled={busy || !prompt.trim() || !model}>Retry</button>
            <button className="btn small ghost" onClick={recheck}>Recheck keys</button>
          </div>
        </div>
      )}

      <div className="card studio-form">
        <Field label="Scene prompt">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Cinematic drone flight over a neon megacity at dusk, volumetric fog, slow push-in…" />
        </Field>
        <div className="studio-presets">
          {PRESETS.map((preset) => (
            <button key={preset.label} type="button" className="chip-toggle"
              onClick={() => setPrompt(preset.prompt)} title={preset.prompt}>{preset.label}</button>
          ))}
        </div>
        <div className="grid-3">
          <Field label="Model" hint={videoModels.length ? 'Ids come from the server catalog.' : 'Waiting for the server catalog — press Recheck status.'}>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!videoModels.length}>
              {videoModels.length === 0 && <option value="">Loading models…</option>}
              {videoModels.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
          <Field label="Duration (s)">
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
            </select>
          </Field>
          <Field label="Resolution">
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <div className="studio-actions">
          <button className="btn primary" disabled={busy || !prompt.trim() || !model} onClick={() => queue()}>
            {busy ? 'Queueing…' : 'Generate video ▶'}
          </button>
          <span className="tiny">
            {configured
              ? 'The badge turns green only after MiniMax accepts a job. A failed render shows the provider sentence, not a generic toast.'
              : 'No MiniMax key found: the backend returns a labelled simulated job; it does not claim a video was made.'}
          </span>
        </div>
      </div>

      <div className="studio-toolbar">
        <div className="studio-count"><b>{jobs.length}</b> job{jobs.length === 1 ? '' : 's'} saved on this device</div>
        <div className="studio-toolbar-actions">
          <button className="btn small ghost" disabled={!jobs.length} onClick={clearHistory}>Clear history</button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <Empty icon="▶" title="No video jobs yet">
          Describe a scene, choose a model and duration, then press Generate video. A real Hailuo render can take
          several minutes — you can leave this page and come back; the job and its polling state are stored here.
          Without <b>MINIMAX_API_KEY</b> you get a clearly labelled preview job, never a fake finished video.
        </Empty>
      ) : (
        <div className="grid-2">
          {jobs.map((job) => (
            <VideoJob
              key={job.id}
              job={job}
              now={now}
              busy={busy}
              onRetry={retry}
              onDelete={deleteJob}
              onCheckNow={checkNow}
            />
          ))}
        </div>
      )}
    </div>
  );
}
