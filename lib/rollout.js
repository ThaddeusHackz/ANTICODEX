// Session rollouts the way Codex persists a turn: one append-only JSONL file per
// session, replayable. `anticodex resume <id>` rebuilds messages + grants from
// it. Nothing invents history - a missing id is an honest error.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH } from './keys.js';
export function rolloutDir() { return process.env.ANTICODEX_ROLLOUTS || path.join(DATA_PATH, 'rollouts'); }
export function rolloutPath(id) {
  const safe = String(id || '').replace(/[^\w.-]/g, '');
  if (!safe) throw new Error('A rollout id is required.');
  return path.join(rolloutDir(), safe + '.jsonl');
}
export function appendRollout(id, event) {
  const file = rolloutPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  return file;
}
export function readRollout(id) {
  const file = rolloutPath(id);
  if (!fs.existsSync(file)) return null;
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn last line is skipped */ }
  }
  return { id: String(id), file, events };
}
export function listRollouts(limit = 20) {
  const dir = rolloutDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { id: f.replace(/\.jsonl$/, ''), bytes: st.size, updated_at: st.mtime.toISOString() }; })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
}
export function resumeFrom(id) {
  const roll = readRollout(id);
  if (!roll) return { ok: false, error: 'No rollout named "' + id + '". List them with `anticodex resume` (no id).' };
  const messages = []; let grants = {}; let todos = []; let agent = 'build';
  for (const ev of roll.events) {
    if (ev.type === 'session') { agent = ev.agent || agent; if (ev.grants) grants = { ...grants, ...ev.grants }; }
    else if (ev.type === 'user') messages.push({ role: 'user', content: String(ev.text || '') });
    else if (ev.type === 'assistant_delta' && ev.text) messages.push({ role: 'assistant', content: String(ev.text) });
    else if (ev.type === 'done') { if (ev.grants) grants = { ...grants, ...ev.grants }; if (ev.todos) todos = ev.todos; }
  }
  return { ok: true, id: roll.id, messages, grants, todos, agent, events: roll.events.length };
}
