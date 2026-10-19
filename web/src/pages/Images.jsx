import React, { useState } from 'react';
import { image as imageApi, extras } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, CopyBtn, Empty } from '../ui.jsx';

function UnsplashSearch() {
  const { notify } = useApp();
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Search Unsplash photos</h3>
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="mountains, neon city, abstract…"
          onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('unsplash-go')?.click(); }} style={{ flex: 1 }} />
        <button id="unsplash-go" className="btn primary" disabled={busy || !q.trim()} onClick={async () => {
          setBusy(true);
          try {
            const r = await extras({ op: 'image_search', query: q });
            if (r.ok === false) { notify(r.error); return; }
            setItems(r.results || []);
          } catch (e) { notify(e.message); }
          finally { setBusy(false); }
        }}>{busy ? 'Searching…' : 'Search'}</button>
      </div>
      {items.length > 0 && (
        <div className="gallery" style={{ marginTop: 14 }}>
          {items.map((p) => (
            <a key={p.id} className="media-frame" href={p.link} target="_blank" rel="noreferrer" title={p.author}>
              <img src={p.thumb} alt={p.alt || ''} loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ImagesPage() {
  const { notify, cfg } = useApp();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [model, setModel] = useState('schnell');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(() => {
    try { return JSON.parse(localStorage.getItem('acx_images') || '[]'); } catch { return []; }
  });

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const [w, h] = size.split('x').map(Number);
      const r = await imageApi({ prompt, width: w, height: h, model });
      const item = { id: Date.now(), prompt, image: r.image, provider: r.provider, demo: r.demo, at: new Date().toISOString() };
      const next = [item, ...results].slice(0, 24);
      setResults(next);
      localStorage.setItem('acx_images', JSON.stringify(next));
      notify(r.demo ? 'Preview generated (add Cloudflare keys for real Flux output)' : 'Image generated with Cloudflare Flux');
    } catch (e) {
      notify(e.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Image Studio</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Powered by <b>Cloudflare Workers AI · Flux</b> (schnell/dev){cfg?.flux_configured ? '' : ' — add CF_ACCOUNT_ID + CF_API_TOKEN to enable live generation.'}
          </p>
        </div>
        <Pill kind={cfg?.flux_configured ? 'ok' : 'warn'}>{cfg?.flux_configured ? 'Flux live' : 'preview mode'}</Pill>
      </div>

      <div className="card">
        <Field label="Prompt">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="A crystalline prism refracting aurora light over a dark ocean, ultra detailed…" />
        </Field>
        <div className="grid-3">
          <Field label="Size">
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option>1024x1024</option><option>768x1344</option><option>1344x768</option><option>512x512</option>
            </select>
          </Field>
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="schnell">Flux schnell (fast)</option>
              <option value="dev">Flux dev (quality)</option>
            </select>
          </Field>
          <Field label="&nbsp;">
            <button className="btn primary" style={{ width: '100%' }} disabled={busy || !prompt.trim()} onClick={generate}>
              {busy ? 'Generating…' : 'Generate ⚡'}
            </button>
          </Field>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        {results.length === 0 ? (
          <Empty icon="▦" title="No images yet">Your generations appear here with one-click copy and download.</Empty>
        ) : (
          <div className="gallery">
            {results.map((r) => (
              <div key={r.id} className="media-frame">
                <img src={r.image} alt={r.prompt} />
                <div style={{ padding: 12 }}>
                  <div className="tiny" style={{ marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.prompt}</div>
                  <div className="row">
                    <Pill kind={r.demo ? 'warn' : 'ok'}>{r.provider}</Pill>
                    <div style={{ flex: 1 }} />
                    <CopyBtn text={r.image} label="Copy data" />
                    <a className="btn small ghost" href={r.image} download={`anticodex-${r.id}.png`}>↓</a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
