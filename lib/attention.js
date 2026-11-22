// "Needs Me" (Qoder 0.5.1) and "Act Proactive" (Qoder 0.1.0): surface unresolved
// errors, changes without tests, unfinished plans and questions instead of
// letting a turn end quietly with work outstanding. Pure: derived from events a
// turn already emits, so it cannot invent an item.
export function buildAttention({ events = [], changes = [], plan = null, todos = [], question = null, stepLimited = false } = {}) {
  const items = [];
  const failed = (events || []).filter((e) => e.type === 'tool_end' && e.ok === false);
  for (const f of failed.slice(0, 8)) items.push({ kind: 'error', severity: 'high', title: (f.tool || 'tool') + ' failed', detail: String(f.error || 'failed').slice(0, 240), tool: f.tool, step: f.step });
  const ranTests = (events || []).some((e) => e.type === 'tool_start' && e.tool === 'bash' && /\b(npm test|pytest|go test|cargo test|node tests\/)/.test(String(e.args?.command || '')));
  if ((changes || []).length && !ranTests) {
    const paths = [...new Set(changes.flatMap((c) => c.paths || []))];
    items.push({ kind: 'untested', severity: 'medium', title: 'Changes without a test run', detail: paths.slice(0, 8).join(', '), paths });
  }
  if (question) items.push({ kind: 'question', severity: 'high', title: 'Waiting on your answer', detail: String(question.text || question).slice(0, 240) });
  const open = (plan || []).filter((s) => s.status !== 'completed');
  if (open.length) items.push({ kind: 'plan', severity: 'medium', title: open.length + ' plan step(s) unfinished', detail: open.map((s) => s.step).slice(0, 6).join('; ') });
  const openTodos = (todos || []).filter((t) => t.status !== 'done' && t.status !== 'completed');
  if (openTodos.length) items.push({ kind: 'todo', severity: 'low', title: openTodos.length + ' task(s) still open', detail: openTodos.map((t) => t.text).slice(0, 6).join('; ') });
  if (stepLimited) items.push({ kind: 'limit', severity: 'medium', title: 'Stopped at the step cap', detail: 'The turn hit its round limit; continue to finish the work.' });
  return items;
}
export function nextSteps(attention, { changes = [] } = {}) {
  const out = [];
  const kinds = new Set((attention || []).map((a) => a.kind));
  if (kinds.has('error')) out.push({ label: 'Fix the failures', prompt: 'Fix the tool failures from the last turn and explain the cause.' });
  if (kinds.has('untested')) out.push({ label: 'Run the tests', prompt: 'Run the test suite for the files you changed and report the results.' });
  if (kinds.has('plan') || kinds.has('todo')) out.push({ label: 'Finish the plan', prompt: 'Continue with the remaining plan steps.' });
  if (kinds.has('limit')) out.push({ label: 'Continue', prompt: 'Continue where you stopped.' });
  if (!out.length && (changes || []).length) out.push({ label: 'Review the diff', prompt: 'Summarise the changes you made and any risks.' });
  if (!out.length) out.push({ label: 'Add tests', prompt: 'Add tests covering the code we just discussed.' });
  return out.slice(0, 3);
}
export function skillSuggestion({ events = [], changes = [] } = {}) {
  const tools = (events || []).filter((e) => e.type === 'tool_end' && e.ok).map((e) => e.tool);
  const uniq = [...new Set(tools)];
  if (uniq.length < 3 || !(changes || []).length) return null;
  const paths = [...new Set(changes.flatMap((c) => c.paths || []))];
  return { title: 'Capture this workflow as a skill', reason: 'This turn used ' + uniq.length + ' different tools and changed ' + paths.length + ' file(s) - a repeatable workflow.', tools: uniq.slice(0, 8), paths: paths.slice(0, 8), writes: false };
}
