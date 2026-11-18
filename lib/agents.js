// ANTICODEX v2.5 — Sub-agent orchestrator ("access all sub agents").
//
// The Agent Studio used to *display* a tool log while the model only wrote
// `[tool:name]` text into its reply — nothing actually ran. This module is the
// real thing: a lead agent decomposes the task into small, single-purpose
// sub-agents (researcher / analyst / writer / critic), each one a genuine
// `chat()` call with its own system prompt and its own tool surface, executed
// in parallel by a bounded worker pool. The lead then synthesizes the results,
// and an optional critic pass scores the draft so weak answers get flagged
// instead of shipped silently.
//
// Design constraints (serverless-friendly):
//  - No streaming, no long-lived sockets: one POST → one JSON result. Vercel
//    function limits are the ceiling, hence maxAgents=4 default and per-agent
//    timeouts.
//  - Tool access is exactly as scoped as chat's own MCP loop: builtins plus
//    connected MCP servers, capped at 3 rounds per agent.
//  - Every failure degrades to a per-agent error entry; one bad sub-agent never
//    kills the run.

import { chat } from './providers.js';
import { builtinTools, runBuiltin } from './extras.js';
import { collectTools, executeTool } from './mcp.js';
import { find } from './store.js';

const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 100_000);
const MAX_TOOL_ROUNDS = 3;
const TOOL_RESULT_CAP = 8000;

export const AGENT_ROLES = {
  planner: {
    label: 'Planner',
    tools: false,
    system: 'You are the ANTICODEX lead agent (planner). Decompose the user task into 1-4 focused sub-agent jobs. Prefer fewer, independent jobs. Respond with ONLY JSON: {"objective":"one sentence","briefs":[{"role":"researcher|analyst|writer|critic","goal":"specific self-contained instruction a fresh agent can execute without seeing the conversation"}]}'
  },
  researcher: {
    label: 'Researcher',
    tools: true,
    system: 'You are a research sub-agent inside ANTICODEX. Gather facts using the provided tools when useful (search, weather, connector data). Cite sources inline as [n] with a short source list at the end. Be dense and factual; no filler.'
  },
  analyst: {
    label: 'Analyst',
    tools: true,
    system: 'You are an analysis sub-agent inside ANTICODEX. Work the evidence you are given: compare options, quantify trade-offs, state assumptions and confidence. Use tools to verify anything load-bearing. Output structured findings with a clear bottom line.'
  },
  writer: {
    label: 'Writer',
    tools: false,
    system: 'You are a writing sub-agent inside ANTICODEX. Turn the supplied material into a crisp, well-formatted answer for the end user. Markdown allowed. Do not invent facts that were not in the material.'
  },
  critic: {
    label: 'Critic',
    tools: false,
    system: 'You are a critique sub-agent inside ANTICODEX. Score the draft 0-10 on accuracy, completeness and clarity against the objective. List concrete defects and required fixes. Respond with ONLY JSON: {"score":number,"verdict":"ship|revise","defects":["..."]}'
  },
  synthesizer: {
    label: 'Lead agent',
    tools: false,
    system: 'You are the ANTICODEX lead agent (synthesizer). Merge the sub-agent reports into one final answer for the user. Resolve contradictions explicitly, keep citations, drop process chatter. Your reply is shown verbatim.'
  }
};

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); })
  ]);
}

/** One sub-agent = one chat() call + its own bounded tool loop. */
async function runAgent({ role, goal, context, model, keys, conns, toolPool, temperature = 0.4, max_tokens = 1600 }) {
  const def = AGENT_ROLES[role] || AGENT_ROLES.analyst;
  const messages = [{ role: 'user', content: context ? `${context}\n\n---\nTask: ${goal}` : goal }];
  const out = { role, label: def.label, goal, ok: false, text: '', tools_used: [], ms: 0 };
  const started = Date.now();
  try {
    if (!def.tools || !toolPool?.length) {
      const r = await withTimeout(chat({ messages, model, system: def.system, temperature, max_tokens, keys }), AGENT_TIMEOUT_MS, def.label);
      out.text = String(r.text || '').trim();
    } else {
      let r;
      let rounds = 0;
      for (;;) {
        r = await withTimeout(chat({ messages, model, system: def.system, temperature, max_tokens, keys, tools: toolPool }), AGENT_TIMEOUT_MS, def.label);
        if (!r.tool_calls?.length || rounds >= MAX_TOOL_ROUNDS) break;
        rounds++;
        messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.tool_calls });
        for (const tc of r.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
          const fname = tc.function?.name || '';
          let result;
          try {
            result = toolPool.builtins?.some((b) => b.function.name === fname)
              ? await withTimeout(runBuiltin(fname, args), 25_000, fname)
              : await withTimeout(executeTool(conns, fname, args), 30_000, fname);
          } catch (e) { result = { error: String(e.message || e) }; }
          out.tools_used.push(fname);
          messages.push({ role: 'tool', tool_call_id: tc.id, name: fname, content: JSON.stringify(result).slice(0, TOOL_RESULT_CAP) });
        }
      }
      out.text = String(r?.text || '').trim();
    }
    out.ok = out.text.length > 0;
    if (!out.ok) out.error = 'empty response';
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 300);
  }
  out.ms = Date.now() - started;
  return out;
}

/** Bounded-concurrency map preserving input order. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function safeJsonParse(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

const DEFAULT_BRIEFS = [
  { role: 'researcher', goal: '' },
  { role: 'analyst', goal: '' }
];

/**
 * Full orchestration: plan → parallel sub-agents → synthesize → (optional) critic.
 * Returns { ok, objective, agents[], answer, score?, verdict?, model, ms }.
 */
export async function runSubagents({ task, model, keys, briefs, use_mcp = true, critique = true, concurrency = 3 }) {
  const t0 = Date.now();
  const prompt = String(task || '').trim();
  if (!prompt) return { ok: false, error: 'task required' };

  // Tool surface — same scoping rules as the chat bridge handler.
  let toolPool = [];
  let builtins = [];
  let conns = [];
  if (use_mcp !== false) {
    conns = (await find('mcp_connections', (c) => c.status === 'connected' && c.enabled !== false, 50)).slice(0, 8);
    builtins = builtinTools();
    const mcpTools = conns.length ? (await collectTools(conns)).filter((t) => !t._error) : [];
    toolPool = [...builtins, ...mcpTools].slice(0, 24);
  }
  toolPool.builtins = builtins;

  // 1. Plan (skipped when the caller supplies explicit briefs — cheaper, and
  //    lets the UI run a fixed pipeline like /research).
  let objective = prompt.slice(0, 200);
  let jobs;
  if (Array.isArray(briefs) && briefs.length) {
    jobs = briefs.slice(0, 6).map((b) => ({ role: AGENT_ROLES[b.role] ? b.role : 'analyst', goal: String(b.goal || prompt) }));
  } else {
    const planned = await runAgent({ role: 'planner', goal: prompt, model, keys, conns, toolPool: [], temperature: 0.2, max_tokens: 700 });
    const pj = safeJsonParse(planned.text);
    if (pj && Array.isArray(pj.briefs) && pj.briefs.length) {
      objective = pj.objective || objective;
      jobs = pj.briefs.slice(0, 4).map((b) => ({ role: AGENT_ROLES[b.role] ? b.role : 'analyst', goal: String(b.goal || prompt) }));
    } else {
      jobs = DEFAULT_BRIEFS.map((b) => ({ ...b, goal: prompt }));
    }
  }

  // 2. Fan out — every sub-agent runs independently and in parallel.
  const agents = await pool(jobs, concurrency, (job) =>
    runAgent({ role: job.role, goal: job.goal, model, keys, conns, toolPool }));

  const report = agents
    .map((a, i) => `## Agent ${i + 1} — ${a.label}${a.ok ? '' : ' (FAILED: ' + a.error + ')'}\nGoal: ${a.goal}\n${a.tools_used.length ? 'Tools: ' + [...new Set(a.tools_used)].join(', ') + '\n' : ''}${a.ok ? a.text : '(no output)'}`)
    .join('\n\n');

  // 3. Synthesize.
  const synth = await runAgent({
    role: 'synthesizer',
    goal: `Objective: ${objective}\n\nSub-agent reports:\n\n${report}\n\nWrite the final answer for the user.`,
    model, keys, conns, toolPool: [], max_tokens: 2200
  });
  let answer = synth.ok ? synth.text : agents.filter((a) => a.ok).map((a) => a.text).join('\n\n');
  agents.push(synth);

  // 4. Optional critic pass — flags quality instead of pretending it's perfect.
  let score = null, verdict = null, defects = [];
  if (critique && answer) {
    const crit = await runAgent({
      role: 'critic',
      goal: `Objective: ${objective}\n\nDraft:\n\n${answer.slice(0, 12000)}`,
      model, keys, conns, toolPool: [], max_tokens: 500
    });
    const cj = safeJsonParse(crit.text);
    if (cj && typeof cj.score === 'number') {
      score = Math.max(0, Math.min(10, cj.score));
      verdict = cj.verdict === 'ship' ? 'ship' : 'revise';
      defects = Array.isArray(cj.defects) ? cj.defects.slice(0, 6) : [];
      agents.push(crit);
    }
  }

  return {
    ok: !!answer,
    objective,
    model,
    answer,
    agents: agents.map((a) => ({ role: a.role, label: a.label, goal: a.goal, ok: a.ok, error: a.error || null, ms: a.ms, tools_used: [...new Set(a.tools_used)], chars: a.text.length })),
    score, verdict, defects,
    tools_available: toolPool.length,
    ms: Date.now() - t0
  };
}
