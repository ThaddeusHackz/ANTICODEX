import React, { useState } from 'react';
import { videoStart, videoStatus } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Empty } from '../ui.jsx';

export default function VideoPage() {
  const { notify, cfg } = useApp();
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(6);
  const [resolution, setResolution] = useState('768P');
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_videos') || '[]'); } catch { return []; }
  });

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const job = await videoStart({ prompt, duration: Number(duration), resolution, model: 'MiniMax-Hailuo-2.3' });
      const item = { ...job, prompt, at: new Date().toISOString() };
      const next = [item, ...jobs].slice(0, 12);
      setJobs(next);
      localStorage.setItem('acx_videos', JSON.stringify(next));
      notify(job.demo ? 'Simulated job created (add MINIMAX_API_KEY for live Hailuo video)' : 'Hailuo video job queued');
      // Poll status a few times.
      poll(item.id);
    } catch (e) {
      notify(e.message, 'error');
    } finally { setBusy(false); }
  }

  async function poll(id) {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const s = await videoStatus(id);
        setJobs((js) => js.map((j) => j.id === id ? { ...j, ...s } : j));
        if (s.status === 'ready' || s.status === 'failed') break;
      } catch { break; }
    }
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Video Studio</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Text-to-video on <b>MiniMax Hailuo (H3)</b> — unlimited usage on your own MiniMax key.
          </p>
        </div>
        <Pill kind={cfg?.minimax_configured ? 'ok' : 'warn'}>{cfg?.minimax_configured ? 'Hailuo live' : 'preview mode'}</Pill>
      </div>

      <div className="card">
        <Field label="Scene prompt">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Cinematic drone flight over a neon megacity at dusk, volumetric fog, slow push-in…" />
        </Field>
        <div className="grid-3">
          <Field label="Duration (s)">
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option>6</option><option>10</option>
            </select>
          </Field>
          <Field label="Resolution">
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option>768P</option><option>1080P</option>
            </select>
          </Field>
          <Field label="&nbsp;">
            <button className="btn primary" style={{ width: '100%' }} disabled={busy || !prompt.trim()} onClick={generate}>
              {busy ? 'Queueing…' : 'Generate video ▶'}
            </button>
          </Field>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        {jobs.length === 0 ? (
          <Empty icon="▶" title="No videos yet">Video jobs appear here with live status polling.</Empty>
        ) : (
          <div className="grid-2">
            {jobs.map((j) => (
              <div key={j.id} className="card">
                <div className="row between">
                  <b style={{ fontSize: 13 }}>{(j.prompt || '').slice(0, 60) || 'Untitled job'}</b>
                  <Pill kind={j.status === 'ready' ? 'ok' : j.status === 'failed' ? 'danger' : 'warn'}>{j.status}</Pill>
                </div>
                <div className="tiny" style={{ margin: '6px 0' }}>{j.model || 'MiniMax-Hailuo'} · {j.duration || 6}s · {j.resolution || '768P'}</div>
                {j.status === 'ready' && j.video && j.video !== 'demo' && (
                  <div className="media-frame"><video src={j.video} controls /></div>
                )}
                {j.status === 'ready' && (j.video === 'demo' || j.demo) && (
                  <div className="media-frame" style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#12203a,#1d2b52)' }}>
                    <span className="muted">Simulated render — configure MINIMAX_API_KEY for real output</span>
                  </div>
                )}
                {j.status !== 'ready' && j.status !== 'failed' && (
                  <div className="tiny">processing… status is polled automatically</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
