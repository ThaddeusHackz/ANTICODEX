// Context compaction (Qoder 0.1.8 / 0.5.13 fixed "messages lost after repeated
// context compression" and orphaned links when forking a compacted thread).
// The rule that makes compaction safe on the OpenAI wire: never separate an
// assistant tool_calls message from its tool responses. We cut only at a SAFE
// boundary and refuse to compact rather than emit a broken request.
export const COMPACT_MARKER = '[compacted context]';
export function messageChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    n += String(m?.content || '').length;
    if (Array.isArray(m?.tool_calls)) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}
export function isSafeBoundary(messages, i) {
  const m = messages[i];
  if (!m) return false;
  if (m.role === 'tool') return false;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
  return m.role === 'user' || m.role === 'assistant';
}
export function summarize(messages) {
  const asks = []; const tools = []; const failed = []; const files = new Set();
  for (const m of messages || []) {
    if (m.role === 'user') asks.push(String(m.content || '').slice(0, 160));
    if (m.role === 'tool') {
      let r = null; try { r = JSON.parse(m.content); } catch { r = null; }
      const name = m.name || r?.tool || 'tool';
      tools.push(name);
      if (r && r.ok === false) failed.push(name + ': ' + String(r.error || 'failed').slice(0, 120));
      for (const p of (Array.isArray(r?.applied) ? r.applied.map((x) => x.path) : [r?.path])) if (p) files.add(p);
    }
  }
  const uniq = [...new Set(tools)];
  const parts = [COMPACT_MARKER + ' Earlier turns were condensed to fit the context window.'];
  if (asks.length) parts.push('Requests: ' + asks.slice(-6).map((a) => JSON.stringify(a)).join('; '));
  if (uniq.length) parts.push('Tools used: ' + uniq.slice(0, 12).join(', ') + ' (' + tools.length + ' calls)');
  if (files.size) parts.push('Files touched: ' + [...files].slice(0, 12).join(', '));
  if (failed.length) parts.push('Unresolved failures: ' + failed.slice(0, 6).join('; '));
  parts.push('Ask for a file again if you need its current content - the full text is no longer in context.');
  return parts.join('\n');
}
export function compactMessages(messages, { maxChars = 60000, keepRecent = 8 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const before = messageChars(list);
  if (before <= maxChars) return { messages: list, compacted: false, chars_before: before, chars_after: before, removed: 0 };
  let headEnd = 0;
  while (headEnd < list.length && list[headEnd]?.role === 'system') headEnd++;
  let cut = Math.max(headEnd, list.length - Math.max(2, keepRecent));
  while (cut < list.length && !isSafeBoundary(list, cut)) cut++;
  if (cut >= list.length || cut <= headEnd) return { messages: list, compacted: false, chars_before: before, chars_after: before, removed: 0, reason: 'no safe boundary' };
  const middle = list.slice(headEnd, cut);
  if (!middle.length) return { messages: list, compacted: false, chars_before: before, chars_after: before, removed: 0 };
  const summary = summarize(middle);
  const out = [...list.slice(0, headEnd), { role: 'system', content: summary }, ...list.slice(cut)];
  return { messages: out, compacted: true, summary, removed: middle.length, chars_before: before, chars_after: messageChars(out) };
}
