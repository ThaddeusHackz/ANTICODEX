import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

// Model output is untrusted text, and it is rendered with innerHTML. So the HTML
// marked produces is passed through an allowlist here:
//
//   * only the tags markdown itself emits survive — a model that writes
//     `<img onerror=…>`, `<svg onload=…>`, `<iframe>`, or `<script>` gets nothing;
//   * only a short list of attributes survives, and href/src go through one URL
//     allowlist, so `[click](javascript:…)` and `data:text/html` images do nothing;
//   * text and code are untouched: marked already escapes them, and doing it again
//     here is how `<div>` inside a fence turned into `&lt;div&gt;` on screen.
//
// The previous version stripped a few tags with regexes after parsing. A blocklist
// misses unquoted attributes, handlers on tags nobody thought of, and anything
// split across lines — the exact shapes that get around one.
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|\/|#|\.\.?\/)/i;
const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img', 'span', 'input', 'sup', 'sub', 'kbd', 'details', 'summary'
]);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'start', 'type', 'disabled', 'checked', 'align', 'colspan', 'rowspan']);
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sanitizeTag(closing, name, attrs, selfClose) {
  const tag = name.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return '';
  const kept = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrs || ''))) {
    const attr = m[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(attr)) continue;
    const raw = m[3] ?? m[4] ?? m[5] ?? '';
    if ((attr === 'href' || attr === 'src') && !SAFE_URL.test(String(raw).trim())) {
      kept.push(`${attr}="#"`);
      continue;
    }
    kept.push(`${attr}="${escapeAttr(raw)}"`);
  }
  return `<${closing}${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose ? ' /' : ''}>`;
}

export function renderMarkdown(src) {
  const html = marked.parse(String(src || ''));
  return html.replace(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g,
    (tag, closing, name, attrs, selfClose) => sanitizeTag(closing, name, attrs, selfClose));
}

// Split fenced code blocks for the copy-aware renderer.
export function splitCode(md) {
  const parts = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(md))) {
    if (m.index > last) parts.push({ type: 'text', value: md.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || 'text', value: m[2] });
    last = re.lastIndex;
  }
  if (last < md.length) parts.push({ type: 'text', value: md.slice(last) });
  return parts;
}
