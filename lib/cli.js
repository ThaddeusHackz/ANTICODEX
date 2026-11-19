import { runAgent, resolveAgent } from './agent.js';
import { discoverAgentDocs, composeInstructions } from './workspace.js';
export function parseArgs(argv) {
  const out = { agent: 'build', target: 'local', yes: false, prompt: [], maxSteps: null };
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--agent' || a === '-a') out.agent = argv[++i];
    else if (a === '--target' || a === '-t') out.target = argv[++i];
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--max-steps') out.maxSteps = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else out.prompt.push(a); }
  out.prompt = out.prompt.join(' ').trim(); return out;
}
export const HELP = 'ANTICODEX CLI - the universal AI workspace in your terminal.\nUsage: anticodex "task" [--agent build|plan|explore] [--target local|daytona] [--yes] [--max-steps N]\nAGENTS.md loads from cwd upward; keys resolve like the app. Non-TTY without --yes fails closed.\n';
export async function runCli({ argv = [], callModel, ask, out = console.log, err = console.error, cwd = process.cwd(), account = 'cli' }) {
  const args = parseArgs(argv);
  if (args.help || !args.prompt) { out(HELP); return { ok: !!args.help, code: args.help ? 0 : 1 }; }
  const agent = resolveAgent(args.agent);
  let instructions = ''; try { instructions = composeInstructions(await discoverAgentDocs(cwd), { cwd }); } catch {}
  const messages = []; if (instructions) messages.push({ role: 'system', content: instructions });
  messages.push({ role: 'user', content: args.prompt });
  const approve = async (req) => { if (args.yes) return 'allow'; if (!ask) return 'deny'; return await ask(req); };
  let final = ''; let code = 0;
  try { for await (const ev of runAgent({ messages, agent: agent.id, target: args.target, account, callModel, askPermission: approve, maxSteps: args.maxSteps || undefined })) {
    if (ev.type === 'assistant_delta' || ev.type === 'done') { if (ev.text) { final = ev.text; out(ev.text); } }
    else if (ev.type === 'tool_start') out('  . ' + ev.tool);
    else if (ev.type === 'tool_end' && !ev.ok) err('  x ' + ev.tool + ': ' + (ev.error || 'failed'));
    else if (ev.type === 'error') { err(ev.error); code = 1; } } }
  catch (e) { err(String(e.message || e)); code = 1; }
  return { ok: code === 0, code, text: final, agent: agent.id };
}
