// Codex's apply_patch envelope, parsed and applied here so a patch written for
// Codex works in ANTICODEX with no conversion step. Pure functions; the
// filesystem side lives in lib/agent.js, which owns workspace roots.
export const PATCH_BEGIN = '*** Begin Patch';
export const PATCH_END = '*** End Patch';

export function parseApplyPatch(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === PATCH_BEGIN);
  if (start < 0) return { ok: false, files: [], error: 'Missing "*** Begin Patch".' };
  const end = lines.findIndex((l, i) => i > start && l.trim() === PATCH_END);
  if (end < 0) return { ok: false, files: [], error: 'Missing "*** End Patch".' };
  const files = []; let cur = null; let hunk = null;
  const pushHunk = () => { if (cur && hunk && hunk.lines.length) { cur.hunks.push(hunk); hunk = null; } };
  const pushFile = () => { pushHunk(); if (cur) files.push(cur); cur = null; };
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]; const t = line.trim();
    if (t.startsWith('*** Add File: ')) { pushFile(); cur = { type: 'add', path: t.slice(14).trim(), move_to: null, hunks: [] }; hunk = { hint: '', lines: [] }; continue; }
    if (t.startsWith('*** Update File: ')) { pushFile(); cur = { type: 'update', path: t.slice(17).trim(), move_to: null, hunks: [] }; continue; }
    if (t.startsWith('*** Delete File: ')) { pushFile(); cur = { type: 'delete', path: t.slice(17).trim(), move_to: null, hunks: [] }; continue; }
    if (t.startsWith('*** Move to: ')) {
      if (!cur || cur.type !== 'update') return { ok: false, files: [], error: '"*** Move to:" must follow an Update File section (line ' + (i + 1) + ').' };
      cur.move_to = t.slice(13).trim(); continue;
    }
    if (!cur) { if (!t) continue; return { ok: false, files: [], error: 'Line ' + (i + 1) + ' is outside any file section: ' + t.slice(0, 60) }; }
    if (t.startsWith('@@')) { pushHunk(); hunk = { hint: t.slice(2).trim(), lines: [] }; continue; }
    if (cur.type === 'delete') { if (!t) continue; return { ok: false, files: [], error: 'A Delete File section takes no content lines (line ' + (i + 1) + ').' }; }
    if (!hunk) hunk = { hint: '', lines: [] };
    const sign = line[0];
    if (sign !== '+' && sign !== '-' && sign !== ' ') {
      if (!t) { hunk.lines.push({ kind: 'context', text: '' }); continue; }
      return { ok: false, files: [], error: 'Line ' + (i + 1) + ' must start with "+", "-" or a space: ' + t.slice(0, 60) };
    }
    hunk.lines.push({ kind: sign === '+' ? 'add' : sign === '-' ? 'del' : 'context', text: line.slice(1) });
  }
  pushFile();
  if (!files.length) return { ok: false, files: [], error: 'The envelope contains no file sections.' };
  for (const f of files) {
    if (!f.path) return { ok: false, files: [], error: 'A file section has an empty path.' };
    if (f.type === 'add' && !f.hunks.length) return { ok: false, files: [], error: 'Add File ' + f.path + ' has no content.' };
    if (f.type === 'update' && !f.hunks.length) return { ok: false, files: [], error: 'Update File ' + f.path + ' has no hunks.' };
    if (f.type === 'add' && f.hunks.some((h) => h.lines.some((l) => l.kind !== 'add'))) return { ok: false, files: [], error: 'Add File ' + f.path + ' may only contain "+" lines.' };
  }
  return { ok: true, files, error: null };
}

/** Apply one section to the current text. Context must match exactly once or the
 *  call is refused, naming the line - the discipline `edit` already applies.
 *  Never returns partial content. */
export function applyPatchToContent(before, file) {
  const text = String(before ?? '');
  if (file.type === 'delete') return { ok: true, content: '', deleted: true };
  if (file.type === 'add') {
    const body = file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('\n');
    return { ok: true, content: body.endsWith('\n') ? body : body + '\n', created: true };
  }
  let lines = text.split('\n');
  for (const hunk of file.hunks) {
    const oldSeq = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
    const newSeq = hunk.lines.filter((l) => l.kind !== 'del').map((l) => l.text);
    if (!oldSeq.length) { lines = [...lines, ...newSeq]; continue; }
    const hits = [];
    for (let i = 0; i + oldSeq.length <= lines.length; i++) {
      let match = true;
      for (let j = 0; j < oldSeq.length; j++) { if (lines[i + j] !== oldSeq[j]) { match = false; break; } }
      if (match) hits.push(i);
    }
    if (!hits.length) return { ok: false, error: 'Context not found in ' + file.path + ': ' + JSON.stringify(oldSeq[0]).slice(0, 80) + (hunk.hint ? ' (near ' + hunk.hint + ')' : '') };
    if (hits.length > 1) return { ok: false, error: 'Context is ambiguous in ' + file.path + ' (' + hits.length + ' matches at lines ' + hits.slice(0, 4).map((n) => n + 1).join(', ') + '). Add more context lines.' };
    const at = hits[0];
    lines = [...lines.slice(0, at), ...newSeq, ...lines.slice(at + oldSeq.length)];
  }
  return { ok: true, content: lines.join('\n') };
}
