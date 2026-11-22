import { runAgent, resolveAgent } from './agent.js';
import { discoverAgentDocs, composeInstructions } from './workspace.js';
import { appendRollout, resumeFrom, listRollouts } from './rollout.js';

export function parseArgs(argv) {
  const out = { agent: 'build', target: 'local', yes: false, prompt: [], maxSteps: null, json: false, resume: null, session: null, rollout: true, command: null };
  const rest = [...argv];
  if (rest[0] === 'exec' || rest[0] === 'resume') out.command = rest.shift();
  for (let i = 0; i < rest.length; i++) { const a = rest[i];
    if (a === '--agent' || a === '-a') out.agent = rest[++i];
    else if (a === '--target' || a === '-t') out.target = rest[++i];
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-rollout') out.rollout = false;
    else if (a === '--session') out.session = rest[++i];
    else if (a === '--resume') out.resume = rest[++i];
    else if (a === '--max-steps') out.maxSteps = Number(rest[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else out.prompt.push(a); }
  out.prompt = out.prompt.join(' ').trim();
  if (out.command === 'resume' && out.prompt && !out.resume) { out.resume = out.prompt; out.prompt = ''; }
  return out;
}

export const HELP = 'ANTICODEX CLI - the universal AI workspace in your terminal.\nUsage: anticodex "task" [--agent build|plan|explore] [--target local|daytona] [--yes] [--max-steps N]\n       anticodex exec "task" --json    one JSON event per line (Codex-shaped)\n       anticodex resume [id]            list rollouts, or continue one\nFlags: --session <id> name the rollout, --no-rollout skip persistence.\nAGENTS.md loads from cwd upward; keys resolve like the app. Non-TTY without --yes fails closed.\n';

export async function runCli({ argv = [], callModel, ask, out = console.log, err = console.error, cwd = process.cwd(), account = 'cli' }) {
  const args = parseArgs(argv);
  const emit = (ev) => { if (args.json) out(JSON.stringify(ev)); };
  if (args.help) { out(HELP); return { ok: true, code: 0 }; }
  if (args.command === 'resume' && !args.resume) {
    const rows = listRollouts();
    if (args.json) { out(JSON.stringify({ type: 'rollouts', rollouts: rows })); return { ok: true, code: 0, rollouts: rows }; }
    out(rows.length ? rows.map((r) => r.id + '  ' + r.updated_at + '  ' + r.bytes + 'B').join('\n') : 'No rollouts yet.');
    return { ok: true, code: 0, rollouts: rows };
  }
  let resumed = null;
  if (args.resume) {
    resumed = resumeFrom(args.resume);
    if (!resumed.ok) { err(resumed.error); emit({ type: 'error', error: resumed.error }); return { ok: false, code: 1, error: resumed.error }; }
    if (args.command === 'resume' && !args.prompt) {
      const summary = { type: 'resumed', id: resumed.id, messages: resumed.messages.length, events: resumed.events, agent: resumed.agent };
      if (args.json) out(JSON.stringify(summary));
      else out('Resumed ' + resumed.id + ': ' + resumed.messages.length + ' messages, ' + resumed.events + ' events. Add a prompt to continue.');
      return { ok: true, code: 0, ...summary };
    }
  }
  if (!args.prompt) { out(HELP); return { ok: false, code: 1 }; }
  const agent = resolveAgent(args.agent || resumed?.agent);
  let instructions = ''; try { instructions = composeInstructions(await discoverAgentDocs(cwd), { cwd }); } catch {}
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (resumed) messages.push(...resumed.messages);
  messages.push({ role: 'user', content: args.prompt });
  const sessionId = args.session || args.resume || ('cli_' + Date.now().toString(36));
  const session = { id: sessionId, grants: resumed?.grants || {}, todos: resumed?.todos || [] };
  const record = (ev) => { if (!args.rollout) return; try { appendRollout(sessionId, ev); } catch { /* read-only disk must not break the turn */ } };
  record({ type: 'session', agent: agent.id, target: args.target, sessionId, grants: session.grants });
  record({ type: 'user', text: args.prompt });
  const approve = async (req) => { if (args.yes) return 'allow'; if (!ask) return 'deny'; return await ask(req); };
  let final = ''; let code = 0; let changes = []; let plan = null;
  try {
    for await (const ev of runAgent({ messages, agent: agent.id, target: args.target, account, session, callModel, askPermission: approve, maxSteps: args.maxSteps || undefined })) {
      record(ev); emit(ev);
      if (args.json) continue;
      if (ev.type === 'assistant_delta' || ev.type === 'done') { if (ev.text) { final = ev.text; out(ev.text); } }
      else if (ev.type === 'tool_start') out('  . ' + ev.tool);
      else if (ev.type === 'tool_end' && !ev.ok) err('  x ' + ev.tool + ': ' + (ev.error || 'failed'));
      else if (ev.type === 'error') { err(ev.error); code = 1; }
      if (ev.type === 'done') { final = ev.text || final; changes = ev.changes || []; plan = ev.plan || null; }
    }
  } catch (e) { err(String(e.message || e)); emit({ type: 'error', error: String(e.message || e) }); code = 1; }
  return { ok: code === 0, code, text: final, agent: agent.id, sessionId, changes, plan };
}
