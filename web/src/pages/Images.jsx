import React, { useState } from 'react';
import { image as imageApi, extras, config as readConfig } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, CopyBtn, Empty } from '../ui.jsx';
import { downloadExt, makeId, withAvoid, writeJson } from '../lib/studio.js';
import '../studio.css';

const PRESETS = [
  { label: 'Aurora prism', prompt: 'A crystalline prism refracting aurora light over a dark ocean, volumetric glow, ultra detailed, cinematic lighting' },
  { label: 'Neon megacity', prompt: 'A rain-soaked neon megacity at dusk seen from a rooftop, volumetric fog, reflective streets, cinematic wide shot' },
  { label: 'Product shot', prompt: 'A matte black wireless speaker on a seamless graphite surface, soft studio key light, subtle reflection, advertising photography' },
  { label: 'Isometric room', prompt: 'A cozy isometric reading room with warm lamps, bookshelves, a sleeping cat, miniature diorama, soft ambient occlusion' },
  { label: 'Botanical study', prompt: 'A macro botanical study of a translucent fern frond, backlit, dew drops, dark background, scientific illustration precision' },
  { label: 'Retro poster', prompt: 'A 1970s travel poster for a volcanic island, bold screen-printed shapes, limited palette, paper grain, graphic composition' }
];

const SIZES = [
  { id: '1024x1024', label: 'Square · 1024 × 1024' },
  { id: '1344x768', label: 'Wide · 1344 × 768' },
  { id: '768x1344', label: 'Tall · 768 × 1344' },
  { id: '512x512', label: 'Small · 512 × 512' }
];

function readResults() {
  try {
    const parsed = JSON.parse(localStorage.getItem('acx_images') || '[]');
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.image) : [];
  } catch { return []; }
}

function failureFrom(e, title = 'Image generation failed') {
  const data = e?.data || {};
  return {
    title,
    error: data.error || e?.message || 'The image request failed.',
    fix: data.fix || e?.fix || 'Check that this device can reach the bridge and api.cloudflare.com, then retry.'
  };
}

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
  const { notify, cfg, setCfg } = useApp();
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [model, setModel] = useState('schnell');
  const [seed, setSeed] = useState('');
  const [batch, setBatch] = useState(1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [verify, setVerify] = useState('idle');
  const [results, setResults] = useState(readResults);

  const configured = Boolean(cfg?.flux_configured);
  const missing = cfg?.flux_missing?.length ? cfg.flux_missing : ['CF_ACCOUNT_ID', 'CF_API_TOKEN'];
  const sizes = model === 'dev' ? SIZES : SIZES.slice(0, 1);
  const previewResult = results[0]?.demo ? results[0] : null;

  let badgeKind = 'warn';
  let badgeLabel = 'Preview only';
  if (!cfg) { badgeKind = ''; badgeLabel = 'Checking status'; }
  else if (verify === 'ok') { badgeKind = 'ok'; badgeLabel = 'Flux live'; }
  else if (verify === 'error') { badgeKind = 'danger'; badgeLabel = 'Flux error'; }
  else if (verify === 'demo' || !configured) { badgeKind = 'warn'; badgeLabel = 'Preview only'; }
  else { badgeKind = 'warn'; badgeLabel = 'Flux key found'; }

  let statusText = cfg?.flux_reason || (cfg
    ? `Missing ${missing.join(' + ')}. Add them in Settings → Media, or set the same env vars on the server.`
    : 'Reading the provider status from the bridge…');
  if (verify === 'ok') statusText = 'A real Cloudflare Flux render succeeded in this session. These credentials are verified on this machine; the results below are not previews.';
  if (verify === 'demo') statusText = 'The last render returned a local SVG preview, so no Cloudflare image was produced. Add the credentials below, then generate again.';
  if (verify === 'error' && error) statusText = `${error.error} ${error.fix || ''}`.trim();

  function changeModel(next) {
    setModel(next);
    // flux-1-schnell is fixed at 1024×1024; only dev honours a custom canvas.
    if (next === 'schnell' && size !== '1024x1024') setSize('1024x1024');
  }

  async function recheck() {
    try {
      const next = await readConfig();
      setCfg(next);
      notify('Provider status refreshed');
    } catch (e) {
      notify(e?.message || 'Could not read provider status', 'error');
    }
  }

  async function generate() {
    if (busy) return;
    const basePrompt = prompt.trim();
    if (!basePrompt) {
      setError({ title: 'Add a prompt', error: 'Flux needs at least a sentence describing the image.', fix: 'Type a prompt, or pick one of the presets above the field.' });
      return;
    }

    setBusy(true);
    setError(null);
    setProgress(`0 / ${batch}`);
    const [w, h] = size.split('x').map(Number);
    const combined = withAvoid(basePrompt, negative);
    const seedNumber = Number(seed);
    const wantedSeed = Number.isFinite(seedNumber) && String(seed).trim() !== '' ? Math.max(0, Math.trunc(seedNumber)) : undefined;
    const created = [];
    let failure = null;

    try {
      for (let i = 0; i < batch; i++) {
        setProgress(`Image ${i + 1} of ${batch}…`);
        const r = await imageApi({ prompt: combined, width: w, height: h, model });
        if (r?.ok === false) {
          failure = { title: 'Flux rejected the request', error: r.error || 'Cloudflare returned an error.', fix: r.fix || '' };
          break;
        }
        if (!r?.image) {
          failure = { title: 'Flux returned no image', error: 'The bridge answered without an image field.', fix: 'Retry; if it repeats, check the server log for the Flux response.' };
          break;
        }
        created.push({
          ...r,
          id: makeId('img'),
          prompt: basePrompt,
          negative: negative.trim() || undefined,
          seed: wantedSeed,
          requested_model: model,
          width: r.width || w,
          height: r.height || h,
          at: new Date().toISOString()
        });
      }

      if (created.length) {
        const next = [...created, ...results].slice(0, 24);
        const saved = writeJson('acx_images', next);
        setResults(next);
        setVerify(created.some((r) => !r.demo) ? 'ok' : 'demo');
        if (!saved.ok) {
          setError({ title: 'History was not saved', error: saved.error, fix: 'Download the images you want to keep, then clear older history.' });
        } else {
          notify(created.some((r) => !r.demo)
            ? `Generated ${created.length} image${created.length === 1 ? '' : 's'} with Cloudflare Flux`
            : 'Preview only — Cloudflare Flux keys are missing');
        }
      }

      if (failure) {
        setError(failure);
        if (!created.some((r) => !r.demo)) setVerify('error');
      }
    } catch (e) {
      setError(failureFrom(e));
      setVerify('error');
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  function deleteResult(id) {
    const next = results.filter((r) => r.id !== id);
    const saved = writeJson('acx_images', next);
    setResults(next);
    if (!saved.ok) setError({ title: 'History was not saved', error: saved.error, fix: 'Download anything you want to keep before clearing more.' });
  }

  function clearHistory() {
    if (!results.length) return;
    if (!window.confirm(`Remove all ${results.length} image${results.length === 1 ? '' : 's'} from this device? The files already downloaded are not affected.`)) return;
    const saved = writeJson('acx_images', []);
    setResults([]);
    setVerify('idle');
    if (!saved.ok) setError({ title: 'History was not cleared', error: saved.error, fix: 'Close other tabs and try again.' });
  }

  function saveOne(result) {
    const link = document.createElement('a');
    link.href = result.image;
    link.download = `anticodex-${result.id}.${downloadExt(result)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadAll() {
    // Browsers may throttle a burst of programmatic downloads; spacing them
    // keeps the user gesture alive long enough for each save.
    results.forEach((result, i) => setTimeout(() => saveOne(result), i * 320));
  }

  return (
    <div className="content-wide">
      <div className="row between studio-head">
        <div className="studio-head-main">
          <h2 className="studio-title">Image Studio</h2>
          <p className="muted studio-sub">
            <b>Cloudflare Workers AI · Flux</b> — schnell for speed, dev for a custom canvas.
            Results and their prompt/seed metadata are stored in this browser; Library reads the same list.
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

      {previewResult && (
        <div className="studio-notice" role="status">
          <div className="studio-notice-title">Preview, not a Cloudflare render</div>
          <div className="studio-notice-body">
            {previewResult.reason || 'Cloudflare Flux is not configured on this server.'}{' '}
            Add <code>CF_ACCOUNT_ID</code> + <code>CF_API_TOKEN</code> in Settings → Media (or set those env vars
            on the server), press <b>Recheck status</b>, then generate again. The preview file is an SVG placeholder;
            it is labelled <b>preview</b> everywhere and is never counted as a real generation.
          </div>
        </div>
      )}

      {error && (
        <div className="studio-alert" role="alert">
          <div className="studio-alert-title">{error.title}</div>
          <div className="studio-alert-body">{error.error}</div>
          {error.fix && <div className="studio-fix">Fix: {error.fix}</div>}
          <div className="studio-actions-row">
            <button className="btn small primary" onClick={generate} disabled={busy || !prompt.trim()}>Retry</button>
            <button className="btn small ghost" onClick={recheck}>Recheck keys</button>
          </div>
        </div>
      )}

      <div className="card studio-form">
        <Field label="Prompt">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="A crystalline prism refracting aurora light over a dark ocean, ultra detailed…" />
        </Field>
        <div className="studio-presets">
          {PRESETS.map((preset) => (
            <button key={preset.label} type="button" className="chip-toggle"
              onClick={() => setPrompt(preset.prompt)} title={preset.prompt}>{preset.label}</button>
          ))}
        </div>
        <Field label="Negative prompt (optional)"
          hint="Flux has no separate negative-prompt parameter. This is appended to the prompt as an “Avoid: …” list — it is text, not a hidden setting.">
          <input value={negative} onChange={(e) => setNegative(e.target.value)}
            placeholder="washed-out colours, text, watermark, distorted hands…" />
        </Field>
        <div className="grid-3">
          <Field label="Size / aspect">
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              {sizes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Model" hint={model === 'schnell' ? 'flux-1-schnell is fixed at 1024 × 1024.' : 'flux-1-dev accepts the selected canvas.'}>
            <select value={model} onChange={(e) => changeModel(e.target.value)}>
              <option value="schnell">Flux 1 schnell (fast)</option>
              <option value="dev">Flux 1 dev (quality + size)</option>
            </select>
          </Field>
          <Field label="Batch">
            <select value={batch} onChange={(e) => setBatch(Number(e.target.value))}>
              <option value={1}>1 image</option>
              <option value={2}>2 images</option>
              <option value={4}>4 images</option>
            </select>
          </Field>
        </div>
        <Field label="Seed (metadata only)"
          hint="Cloudflare Flux does not accept a seed. It is saved with the result for your own bookkeeping; it does not change the render.">
          <input value={seed} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" placeholder="e.g. 42" />
        </Field>
        <div className="studio-actions">
          <button className="btn primary" disabled={busy || !prompt.trim()} onClick={generate}>
            {busy ? (progress || 'Generating…') : `Generate${batch > 1 ? ` ${batch} images` : ''} ⚡`}
          </button>
          <span className="tiny">
            {configured
              ? 'Credentials are resolved at request time. The badge turns green only after a real Flux render succeeds.'
              : 'No Cloudflare key found: generation returns a labelled local SVG preview, not a fake success.'}
          </span>
        </div>
      </div>

      <div className="studio-toolbar">
        <div className="studio-count"><b>{results.length}</b> saved on this device · Library reads the same list</div>
        <div className="studio-toolbar-actions">
          <button className="btn small ghost" disabled={!results.length} onClick={downloadAll}>↓ Download all</button>
          <button className="btn small ghost" disabled={!results.length} onClick={clearHistory}>Clear history</button>
        </div>
      </div>

      {results.length === 0 ? (
        <Empty icon="▦" title="No images yet">
          Pick a preset or write a prompt, choose a size, then press Generate. Without Flux keys you still get a
          labelled preview to test layout and downloads; add <b>CF_ACCOUNT_ID</b> + <b>CF_API_TOKEN</b> in Settings → Media
          for real renders.
        </Empty>
      ) : (
        <div className="gallery">
          {results.map((r) => (
            <div key={r.id} className="media-frame studio-card">
              <div className="studio-media">
                <a href={r.image} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={r.image} alt={r.prompt || 'Generated image'} loading="lazy" />
                </a>
                {r.demo && <span className="studio-preview-badge">preview</span>}
              </div>
              <div className="studio-meta">
                <div className="studio-prompt" title={r.prompt}>{r.prompt || 'Untitled'}</div>
                <div className="studio-tags">
                  <Pill kind={r.demo ? 'warn' : 'ok'}>{r.demo ? 'preview' : (r.provider || 'flux')}</Pill>
                  <span className="tiny">{(r.model || r.requested_model || 'flux')} · {(r.width || '?')}×{(r.height || '?')} · {new Date(r.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {r.seed !== undefined && <span className="studio-seed">seed {r.seed}</span>}
                </div>
                <div className="studio-actions-row">
                  <a className="btn small ghost" href={r.image} download={`anticodex-${r.id}.${downloadExt(r)}`}>↓ Save</a>
                  <CopyBtn text={r.prompt || ''} label="Copy prompt" />
                  <button className="btn small danger" onClick={() => deleteResult(r.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <UnsplashSearch />
    </div>
  );
}
