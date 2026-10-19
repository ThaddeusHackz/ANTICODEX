import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

// Render markdown → HTML with a lightweight sanitizer (no raw script/style).
export function renderMarkdown(src) {
  const html = marked.parse(src || '');
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, 'blocked:');
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
