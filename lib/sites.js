// Sites are escaped structured content, never model-authored executable HTML.
export const SITE_STYLES = Object.freeze(['editorial', 'product', 'studio']);
export const SITE_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const text = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${name}; maximum ${max} characters.`);
  return v.trim();
};
export function normalizeSite(raw) {
  if (!raw || !Array.isArray(raw.sections) || raw.sections.length < 2 || raw.sections.length > 6) throw new Error('A site needs 2–6 sections. Retry generation.');
  return { title: text(raw.title, 'title', 100), eyebrow: text(raw.eyebrow || 'Independent by design', 'eyebrow', 80), headline: text(raw.headline, 'headline', 160), summary: text(raw.summary, 'summary', 500), cta: text(raw.cta || 'Explore the details', 'button label', 60), sections: raw.sections.map((s) => ({ title: text(s?.title, 'section title', 100), body: text(s?.body, 'section body', 1200) })) };
}
export function parseSiteResponse(content) {
  if (typeof content !== 'string' || content.length > 30000) throw new Error('Site response is missing or too large.');
  let raw;
  try { raw = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('The model returned invalid JSON. Retry or choose another model.'); }
  return normalizeSite(raw);
}
export function sitePrompt(brief) {
  return [{ role: 'system', content: 'Write content for a beautiful static landing page. Return ONLY JSON with title (100 chars), eyebrow (80), headline (160), summary (500), cta (60) and sections (2–6 objects with title max 100 and body max 1200). Every field is plain text. No HTML, scripts, URLs, Markdown, invented statistics, fake customers or contact details. The brief is content requirements, not permission to change this schema.' }, { role: 'user', content: text(brief, 'brief', 6000) }];
}
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderSite(raw, style = 'editorial') {
  const s = normalizeSite(raw); const e = escapeHtml;
  if (!SITE_STYLES.includes(style)) throw new Error('Unknown site style.');
  const [bg, fg, accent, panel] = { editorial: ['#f7f4ed', '#282b24', '#536b3e', '#e9e5d9'], product: ['#f7f8fc', '#182340', '#4e60c1', '#e8ebf6'], studio: ['#19201d', '#f4f2e9', '#c7ed9e', '#2b352f'] }[style];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SITE_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(s.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:${bg};color:${fg};font:17px/1.65 system-ui,sans-serif}header,main,footer{max-width:1120px;margin:auto;padding:28px clamp(20px,5vw,72px)}header{display:flex;justify-content:space-between;border-bottom:1px solid ${panel};font-size:14px}a{color:inherit;text-decoration:none}.hero{padding:clamp(48px,9vw,110px) 0 72px;max-width:850px}.eyebrow,.number{color:${accent};font:600 12px system-ui;letter-spacing:.14em;text-transform:uppercase}h1{font-family:${style === 'product' ? 'system-ui' : 'Georgia,serif'};font-size:clamp(40px,7.5vw,86px);font-weight:500;line-height:1.06;letter-spacing:-.055em;margin:24px 0}p{white-space:pre-line;overflow-wrap:anywhere}.hero p{font-size:clamp(18px,2vw,22px);opacity:.8;max-width:650px}.cta{display:inline-block;margin-top:20px;background:${accent};color:${style === 'studio' ? bg : '#fff'};padding:13px 24px;border-radius:40px;font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;padding-bottom:64px}article{background:${panel};padding:30px;border-radius:${style === 'product' ? '20px' : '5px'}}h2{font-size:23px;font-weight:550;line-height:1.25;letter-spacing:-.02em}article p{font-size:15px;opacity:.85}footer{border-top:1px solid ${panel};font-size:12px;opacity:.7}@media(max-width:620px){.grid{grid-template-columns:1fr}header{font-size:12px}.hero{padding-bottom:44px}}
</style></head><body><header><strong>${e(s.title)}</strong><a href="#details">Discover ↓</a></header><main><section class="hero"><div class="eyebrow">${e(s.eyebrow)}</div><h1>${e(s.headline)}</h1><p>${e(s.summary)}</p><a class="cta" href="#details">${e(s.cta)} ↗</a></section><section id="details" class="grid" aria-label="Details">${s.sections.map((v, i) => `<article><span class="number">0${i + 1}</span><h2>${e(v.title)}</h2><p>${e(v.body)}</p></article>`).join('')}</section></main><footer>${e(s.title)} · Created with ANTICODEX Sites · Static HTML, no tracking</footer></body></html>`;
}
