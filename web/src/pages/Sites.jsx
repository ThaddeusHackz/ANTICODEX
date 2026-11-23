import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import { streamV3 } from '../lib/v3.js';
import { normalizeSite, renderSite, SITE_STYLES } from '../../../lib/sites.js';
export default function SitesPage() {
  const { model, user } = useApp(); const key = `acx_sites_v3:${user?.id || 'signed-out'}`;
  const [brief, setBrief] = useState(''); const [style, setStyle] = useState('editorial'); const [site, setSite] = useState(null); const [siteId, setSiteId] = useState(null);
  const [saved, setSaved] = useState([]); const [mobile, setMobile] = useState(false); const [running, setRunning] = useState(false); const [error, setError] = useState(''); const [phase, setPhase] = useState('Your canvas is ready'); const ctrl = useRef(null);
  useEffect(() => { setSite(null); setSiteId(null); setSaved([]); setError(''); try { const list = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(list)) setSaved(list.slice(0, 8).flatMap((item) => { try { return [{ ...item, site: normalizeSite(item.site), style: SITE_STYLES.includes(item.style) ? item.style : 'editorial' }]; } catch { return []; } })); } catch { /* no saved sites */ } return () => ctrl.current?.abort(); }, [key]);
  const html = useMemo(() => { if (!site) return ''; try { return renderSite(site, style); } catch { return ''; } }, [site, style]);
  async function generate() {
    if (!brief.trim() || ctrl.current) return;
    const controller = new AbortController(); ctrl.current = controller; setRunning(true); setError(''); setPhase('Writing your site content');
    try { const out = await streamV3('sites', { prompt: brief.trim(), style, model }, { signal: controller.signal }); if (!controller.signal.aborted) { setSite(normalizeSite(out.site)); setSiteId(crypto.randomUUID()); setPhase('Draft ready · not published or saved yet'); } }
    catch (e) { setPhase(e.name === 'AbortError' ? 'Generation stopped' : 'Generation needs attention'); if (e.name !== 'AbortError') setError(e.message); }
    finally { if (ctrl.current === controller) ctrl.current = null; setRunning(false); }
  }
  function save() {
    try { const next = [{ id: siteId || crypto.randomUUID(), site: normalizeSite(site), style }, ...saved.filter((s) => s.id !== siteId)].slice(0, 8); localStorage.setItem(key, JSON.stringify(next)); setSaved(next); setSiteId(next[0].id); setPhase('Saved on this device · not cloud-synced'); }
    catch { setError('Could not save. Check the content or export HTML; device storage may be full.'); }
  }
  function download() {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${(site.title || 'site').replace(/[^a-z0-9-]/gi, '-').slice(0, 80)}.html`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="v3-root" aria-labelledby="sites-title">
    <header className="v3-hero"><div><div className="v3-eyebrow">ANTICODEX / Sites</div><h1 id="sites-title">An idea, with<br /><em>room to become.</em></h1><p>Shape a considered, responsive page. Preview it privately, make it yours, and take the HTML with you.</p></div><span className="v3-trust">Private preview · static export</span></header>
    <div className="v3-tabs"><Link to="/teams">Agent Teams</Link><Link className="active" to="/sites" aria-current="page">Sites</Link></div>
    <div className="v3-sites-layout"><div className="v3-panel v3-brief"><div className="v3-kicker">01 / The direction</div><h2>Start with a little context.</h2><label htmlFor="site-brief">What is this site for?</label><textarea id="site-brief" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={6000} rows={5} disabled={running} placeholder="A quiet portfolio for a ceramic artist, a product launch, a community initiative…" />
      <fieldset className="v3-style-picker"><legend>Visual direction</legend>{SITE_STYLES.map((s) => <button key={s} type="button" className={style === s ? 'selected' : ''} aria-pressed={style === s} onClick={() => setStyle(s)}><span className={`v3-swatch ${s}`} />{s}</button>)}</fieldset>
      <div className="v3-actions">{running ? <button className="v3-button secondary" onClick={() => ctrl.current?.abort()}>Stop generation</button> : <button className="v3-button" disabled={!brief.trim()} onClick={generate}>{error ? 'Retry generation' : site ? 'Generate a new draft' : 'Generate draft'} ↗</button>}</div>
      <p className="v3-caption">Uses your selected model. Static content only: no generated scripts, embeds or remote assets. No automatic hosting or deployment.</p>
      <div className="v3-starters"><span className="v3-kicker">For inspiration</span>{[['Portfolio', 'A calm portfolio for an independent ceramic artist. No invented clients or contact details.'], ['Product launch', 'A clear landing page for a new offline-first note-taking app. No invented statistics.']].map(([label, prompt]) => <button key={label} disabled={running} onClick={() => setBrief(prompt)}>{label}<span aria-hidden="true">↗</span></button>)}</div>
      {site && <details className="v3-edit"><summary>Edit the essentials</summary>{[['title', 100], ['headline', 160], ['summary', 500]].map(([field, max]) => <label key={field}>{field}<textarea rows={field === 'summary' ? 3 : 2} value={site[field]} maxLength={max} onChange={(e) => setSite({ ...site, [field]: e.target.value })} /></label>)}</details>}
      {saved.length > 0 && <div className="v3-starters"><span className="v3-kicker">Saved on this device</span>{saved.map((s) => <button key={s.id} disabled={running} onClick={() => { setSite(s.site); setStyle(s.style); setSiteId(s.id); setPhase('Opened a device-saved draft'); }}>{s.site.title}<span aria-hidden="true">↗</span></button>)}</div>}
    </div><div className="v3-canvas"><div className="v3-canvas-bar"><div className="v3-device-switch" aria-label="Preview width"><button aria-pressed={!mobile} onClick={() => setMobile(false)}>Desktop</button><button aria-pressed={mobile} onClick={() => setMobile(true)}>Mobile</button></div><div className="v3-actions"><button className="v3-button secondary small" disabled={!html || running} onClick={save}>Save on device</button><button className="v3-button small" disabled={!html || running} onClick={download}>Export HTML ↗</button></div></div>
      <div className="v3-status" role="status" aria-live="polite">{phase}</div>{error && <div className="v3-alert" role="alert">{error}</div>}
      {html ? <div className={`v3-preview ${mobile ? 'mobile' : ''}`}><iframe title="Isolated site preview" sandbox="" referrerPolicy="no-referrer" srcDoc={html} /></div> : <div className="v3-empty v3-empty-canvas"><div className="v3-page-sketch" aria-hidden="true"><i /><b /><b /><span /><div><em /><em /></div></div><h2>Your next idea lives here.</h2><p>A live preview appears after generation. No placeholder is presented as a finished site.</p></div>}
      {site && !html && <p className="v3-alert" role="alert">Complete the title, headline and summary to preview or export.</p>}
    </div></div>
  </section>;
}
