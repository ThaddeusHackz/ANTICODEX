// AI provider engine — multi-protocol routing across the full provider directory:
// OpenAI-compatible, Anthropic Messages, Google (OpenAI-compat), Cohere v2.
// Keys resolve: desktop keychain override → request keys → env → admin runtime → hardcoded slots.

import { getKey, CATALOG } from './keys.js';
import { PROVIDER_DIRECTORY, OPENROUTER_EXTRA_MODELS, NIM_ENDPOINT, findProviderDef } from './catalog.js';
import { recordOutcome, classifyFailure, annotate, modelRef, allHealth } from './model-health.js';
import { guardedFetch } from './net-guard.js';

const DEMO_ID = 'anticodex/demo-core';
// The local Qoder CLI speaks ACP, not HTTP: it shows up as a provider so the
// picker can offer it, and `chatStream` refuses it because the bridge runs it
// through its own agent path (one process, streamed over the same SSE frames).
import { agentProviderDef, isAgentRef, qoderCliCached } from './qoder.js';

// --- how much thinking to pay for -------------------------------------------
//
// Speed is a *setting*, not a hope. The same question asked with `fast` returns
// in a second and the same question asked with `max` can think for twenty — the
// difference has to be visible and switchable, because "the models are slow" is
// usually "nobody could tell it to stop deliberating".
//
// The presets only set defaults: an explicit `max_tokens`/`temperature` from the
// caller still wins. `reasoning_effort` and Anthropic's thinking budget are sent
// only to wires known to accept them, and dropped-and-retried once if a provider
// answers 400 anyway (see postChat below) — a speed knob must never break a call.
export const EFFORTS = Object.freeze({
  fast: {
    id: 'fast', label: 'Fast', hint: 'short answers, no deliberation',
    max_tokens: 512, temperature: 0.3, reasoning: false, reasoning_effort: null, thinking_budget: 0
  },
  balanced: {
    id: 'balanced', label: 'Balanced', hint: 'the default: answers, then explains',
    max_tokens: 1200, temperature: 0.6, reasoning: true, reasoning_effort: 'low', thinking_budget: 0
  },
  max: {
    id: 'max', label: 'Max', hint: 'long answers, full deliberation',
    max_tokens: 4096, temperature: 0.7, reasoning: true, reasoning_effort: 'high', thinking_budget: 4096
  }
});
export const DEFAULT_EFFORT = 'balanced';

export function effortProfile(effort) {
  return EFFORTS[String(effort || '').toLowerCase()] || EFFORTS[DEFAULT_EFFORT];
}

/** The parameters a request actually goes out with, for one effort. */
export function effortParams(effort, { max_tokens, temperature } = {}) {
  const p = effortProfile(effort);
  return {
    id: p.id,
    max_tokens: Number.isFinite(max_tokens) ? max_tokens : p.max_tokens,
    temperature: Number.isFinite(temperature) ? temperature : p.temperature,
    reasoning_effort: p.reasoning_effort,
    thinking_budget: p.thinking_budget,
    wants_reasoning: p.reasoning
  };
}

// Wires whose operator documents `reasoning_effort`; a provider that turns out to
// reject it is remembered here so the retry is paid once, not every message.
const EFFORT_WIRES = new Set(['openai', 'openrouter', 'xai', 'groq', 'cerebras', 'together', 'fireworks', 'deepseek']);
const effortRejected = new Set();
// Model families that take `reasoning_effort` wherever an OpenAI-compatible wire
// carries them. A guess is fine here *because* the call is retried without it the
// first time a provider disagrees — the knob must never be the reason a message
// fails.
const REASONING_MODELS = /(^|[/:\-])(o[134](-|$)|o[134]-mini|gpt-5|gpt-6|deepseek-r1|deepseek-v3|deepseek-v4|qwen3|qwq|magistral|nemotron|glm-z1|kimi-k2-thinking)/i;

/** Does this request want to ask the provider for visible reasoning? */
export function effortFor(prov, effort, modelId = '') {
  const p = effortProfile(effort);
  if (!p.reasoning) return { reasoning_effort: null, thinking_budget: 0 };
  const id = String(prov?.id || '');
  const openaiWire = prov?.kind === 'openai' || prov?.protocol === 'openai' || !prov?.kind;
  const accepts = !effortRejected.has(id) && (
    EFFORT_WIRES.has(id)
    || prov?.effort === true
    || prov?.capabilities?.reasoning_effort === true
    || (openaiWire && REASONING_MODELS.test(String(modelId || '')))
  );
  const reasoning_effort = accepts ? p.reasoning_effort : null;
  const thinking_budget = (prov?.kind === 'anthropic' || prov?.protocol === 'anthropic') ? p.thinking_budget : 0;
  return { reasoning_effort, thinking_budget };
}

/** A 400 that mentions the parameter we added means "drop it", not "your key is bad". */
function optionalParamRejected(err) {
  const raw = String(err?.message || err || '');
  if (!/\b(400|422)\b/.test(raw)) return null;
  if (/reasoning_effort/i.test(raw)) return 'reasoning_effort';
  if (/thinking|budget_tokens/i.test(raw)) return 'thinking';
  if (/unsupported (parameter|value)|unknown (field|parameter)|unrecognized/i.test(raw)) return 'either';
  return null;
}

// Live model lists a provider's own endpoint has confirmed. The curated catalog
// is a guess about what exists until the endpoint says otherwise — which is why a
// real key + a guessed id used to read as "my key does not work". Everything that
// has to name a model (picker order, the default substitution, the unknown-model
// retry) prefers these.
const liveIndex = new Map();          // providerId -> { at, endpoint, models }
const LIVE_TTL_MS = 6 * 60 * 60 * 1000;

export function rememberLiveModels(providerId, models, endpoint) {
  if (!providerId || !Array.isArray(models) || !models.length) return 0;
  const clean = models.slice(0, 800).map((m) => (typeof m === 'string'
    ? { id: m, label: labelFor(m), live: true }
    : { ...m, id: m.id, live: true, label: m.label || labelFor(m.id) }));
  liveIndex.set(String(providerId), { at: Date.now(), endpoint: endpoint || null, models: clean });
  return clean.length;
}

export function liveModels(providerId, maxAge = LIVE_TTL_MS) {
  const hit = providerId ? liveIndex.get(String(providerId)) : null;
  if (!hit || Date.now() - hit.at > maxAge) return null;
  return hit.models;
}

/** Curated + live, ordered by trust: ids the endpoint itself listed come first
 *  (`live:true`); catalog-only ids stay selectable but carry `unverified:true`. */
export function tagModels(curated, live) {
  const list = Array.isArray(curated) ? curated : [];
  if (!live || !live.length) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  const out = [];
  const seen = new Set();
  for (const m of live) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ ...(byId.get(m.id) || {}), id: m.id, label: m.label || labelFor(m.id), live: true });
  }
  for (const m of list) if (!seen.has(m.id)) out.push({ ...m, unverified: true });
  return out;
}

/** The catalog for a provider, upgraded by anything its endpoint has confirmed. */
function effectiveModels(def) {
  if (!def) return [];
  const curated = def.id === 'openrouter' ? openrouterFallback() : (def.models || []);
  return tagModels(curated, liveModels(def.id));
}

function verdictFor(status) {
  if (status === 401 || status === 403) return 'key';
  if (status === 404 || status === 400) return 'model';
  if (status === 429) return 'quota';
  if (status >= 500) return 'provider';
  return 'unknown';
}

// --- key resolution ---------------------------------------------------------

function keyFor(envName, keysOverride) {
  if (keysOverride && keysOverride[envName]) return keysOverride[envName];
  return getKey(envName);
}

// --- request-scoped gateways (the desktop app, or a user's own URLs) --------
// A packaged .exe keeps its own list of custom gateways on this machine (Ollama,
// LM Studio, a LAN vLLM box) and sends it with each request, so the app works
// with a gateway this server has never heard of. A multi-tenant deployment must
// NOT dial into those addresses on a visitor's behalf, so private/LAN targets are
// dropped unless the request provably came from the local desktop instance.
export const PROVIDER_DEFS_KEY = '__provider_defs__';
const PRIVATE_HOST = /^(localhost$|.*\.(local|internal)$|127\.|0\.0\.0\.0|\[::1\]$|\[::\]$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function isPrivateGateway(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return true;
    return PRIVATE_HOST.test(u.hostname);
  } catch { return true; }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,47}$/;

/** Sanitize client-supplied provider rows. Keys are never accepted from a client
 *  (a key_env name is fine: the value still resolves from that user's own
 *  keychain / account store). */
export function normalizeProviderDefs(list, { allowPrivate = false } = {}) {
  if (!Array.isArray(list)) return { defs: [], dropped: 0, dropped_ids: [] };
  const defs = [];
  const droppedIds = [];
  let dropped = 0;
  for (const p of list.slice(0, 40)) {
    if (!p || typeof p !== 'object') { dropped++; continue; }
    const id = String(p.id || '').trim();
    const endpoint = String(p.endpoint || '').trim().replace(/\/+$/, '').slice(0, 300);
    if (!SAFE_ID.test(id) || !/^https?:\/\//i.test(endpoint)) { dropped++; if (SAFE_ID.test(id)) droppedIds.push(id); continue; }
    if (!allowPrivate && isPrivateGateway(endpoint)) { dropped++; droppedIds.push(id); continue; }
    const models = (Array.isArray(p.models) ? p.models : []).slice(0, 200).map((m) => {
      if (typeof m === 'string') return m ? { id: m.slice(0, 180), label: m.slice(0, 80) } : null;
      if (m && m.id) return { id: String(m.id).slice(0, 180), ...(m.label ? { label: String(m.label).slice(0, 80) } : {}), ...(m.vision ? { vision: true } : {}), ...(m.reasoning ? { reasoning: true } : {}), ...(m.tools ? { tools: true } : {}) };
      return null;
    }).filter(Boolean);
    const keyEnv = String(p.key_env || '').trim();
    defs.push({
      id,
      name: String(p.name || id).slice(0, 60),
      type: ['openai', 'anthropic', 'cohere', 'google', 'bedrock', 'vertex'].includes(p.type) ? p.type : 'openai',
      protocol: ['openai', 'anthropic', 'cohere', 'google'].includes(p.type) ? p.type : 'openai',
      endpoint,
      key_env: /^[A-Z][A-Z0-9_]{2,60}$/.test(keyEnv) ? keyEnv : null,
      default_model: p.default_model ? String(p.default_model).slice(0, 180) : 'default',
      models,
      models_dynamic: true,
      custom: true,
      // A gateway can say it understands `reasoning_effort`; nothing else about
      // the row is trusted, and this only decides one optional request field.
      effort: p.effort === true,
      // `local` is the difference between "someone's shared gateway, which needs
      // its key before strangers may use it" and "the machine making this request
      // is talking about its own server", where no key may be assumed and Demo
      // Core must never answer in its place.
      local: true
    });
  }
  return { defs, dropped, dropped_ids: droppedIds };
}

/** Server-configured customs plus whatever this request brought (request wins on
 *  an id clash, so a laptop's own "ollama" row is the one used on that laptop). */
function gatewayDefs(keysOverride) {
  let fromEnv = [];
  try { fromEnv = JSON.parse(getKey('CUSTOM_PROVIDERS') || '[]') || []; } catch { /* malformed config */ }
  const fromReq = (keysOverride && keysOverride[PROVIDER_DEFS_KEY]) || [];
  const out = [];
  const seen = new Set();
  for (const p of [...fromReq, ...fromEnv]) {
    if (!p || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

// --- directory / listing ----------------------------------------------------

export function providerConfigured(def, keysOverride) {
  return Boolean(keyFor(def.key_env, keysOverride));
}

export function directoryWithStatus(keysOverride) {
  return PROVIDER_DIRECTORY.map((def) => ({
    id: def.id, name: def.name, category: def.category, protocol: def.protocol,
    endpoint: def.endpoint, key_env: def.key_env, placeholder: def.placeholder,
    homepage: def.homepage, note: def.note, primary: Boolean(def.primary),
    models: effectiveModels(def),
    models_verified: Boolean(liveModels(def.id)),
    models_note: def.models_note || null,
    models_dynamic: Boolean(def.models_dynamic),
    configured: providerConfigured(def, keysOverride)
  }));
}

function openrouterFallback() {
  return OPENROUTER_EXTRA_MODELS.map((id) => ({ id, label: id.split('/').slice(1).join('/') || id }));
}

/**
 * Providers the client can actually pick from.
 * `all: true` keeps key-less providers in the list (marked `configured:false`) so
 * the model picker can show what you would get and where to add a key — the old
 * behaviour of hiding them made a freshly saved key look ignored until reload.
 */
export function listProviders(keysOverride, opts = {}) {
  const all = opts.all === true;
  const providers = [
    {
      id: 'demo', name: 'ANTICODEX Demo Core', kind: 'builtin', configured: true,
      models: [{ id: DEMO_ID, label: 'Demo Core (offline)', vision: true, tools: true }]
    }
  ];
  // A local agent, when one is installed. Always `configured`: there is no key
  // to add, and pretending otherwise would hide it behind a "needs key" badge.
  const agent = agentProviderDef(qoderCliCached());
  if (agent) providers.push(agent);

  for (const def of PROVIDER_DIRECTORY) {
    const configured = providerConfigured(def, keysOverride);
    if (!all && !configured && !def.primary) continue;
    providers.push({
      id: def.id, name: def.name, kind: def.protocol === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: def.endpoint, configured,
      key_env: def.key_env,
      category: def.category, placeholder: def.placeholder, homepage: def.homepage,
      models_dynamic: Boolean(def.models_dynamic), models_note: def.models_note || null,
      models: effectiveModels(def), models_verified: Boolean(liveModels(def.id))
    });
  }
  // Gateways added on this server OR supplied by this request (the desktop app,
  // or a browser holding its own Ollama/LM Studio row).
  for (const p of gatewayDefs(keysOverride)) {
    providers.push({
      id: p.id, name: p.name || p.id, kind: p.type || 'openai',
      endpoint: p.endpoint, key_env: p.key_env || null,
      // A custom gateway is "configured" when a key is baked in OR the
      // account/desktop supplied one for its key_env.
      configured: Boolean((p.api_key || '') || (p.key_env && keyFor(p.key_env, keysOverride))),
      models: tagModels(
        p.models && p.models.length ? p.models : [{ id: p.default_model || 'default', label: p.default_model || 'default' }],
        liveModels(p.id)
      ),
      models_verified: Boolean(liveModels(p.id)),
      models_dynamic: true,
      // Rows that came with the request belong to that device; the rest are this
      // server's own configuration, which is a different promise to make.
      // Rows that came with the request belong to that device; the rest are this
      // server's own configuration, which is a different promise to make.
      models_note: p.local ? 'Added on this device — models come from its own /models list' : 'Custom gateway configured on this server',
    });
  }
  return providers;
}

// Model reference format: "providerId::modelId" (also accepts bare modelId).
const PLACEHOLDER_MODELS = new Set(['', 'default', 'auto', '-', 'latest', 'model']);
/** A provider rejects a literal "default" — and the old topbar menu had no model
 *  list to pick from, so it sent exactly that. Substitute the catalog's first
 *  model (or, for dynamic endpoints, say so instead of failing cryptically). */
function realModelId(def, modelId) {
  if (!PLACEHOLDER_MODELS.has(String(modelId || '').trim().toLowerCase())) return modelId;
  return (def.models && def.models[0] && def.models[0].id) || modelId;
}

export function resolveModelRef(ref, keysOverride) {
  const [maybeProvider, ...rest] = String(ref || '').split('::');
  if (rest.length) {
    const wanted = rest.join('::');
    const def = providerDefFor(maybeProvider, keysOverride);
    if (def) {
      const models = effectiveModels(def);
      return {
        provider: { ...def, models, api_key: keyFor(def.key_env, keysOverride), configured: true },
        model: { id: realModelId({ models }, wanted) }
      };
    }
  }
  // Bare id: search all providers (demo first, then directory order).
  const bare = String(ref || '');
  if (bare === DEMO_ID) return { provider: { id: 'demo', kind: 'builtin' }, model: { id: DEMO_ID } };
  for (const p of listProviders(keysOverride)) {
    const m = (p.models || []).find((x) => x.id === bare);
    if (m) return { provider: { ...p, api_key: keyFor(p.key_env, keysOverride) }, model: m };
  }
  // Unknown bare id with a primary key configured → send to NVIDIA NIM (its live
  // list, when we have one, is what makes a guessed id recoverable).
  if (keyFor('NVIDIA_API_KEY', keysOverride)) {
    return {
      provider: { id: 'nvidia', kind: 'openai', endpoint: NIM_ENDPOINT, api_key: keyFor('NVIDIA_API_KEY', keysOverride) },
      model: { id: bare }
    };
  }
  return { provider: { id: 'demo', kind: 'builtin' }, model: { id: bare } };
}

/** Omit Authorization completely when there is no key: an open local gateway
 *  (Ollama, LM Studio, a plain vLLM) answers happily, while "Bearer undefined" is
 *  how a strict one ends up looking like a bad key. */
function authHeader(key, extra = {}) {
  return { ...extra, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** Many OpenAI-compatible gateways answer 200 with {"error": …} — treat that as a
 *  failure so the caller gets a sentence instead of an empty bubble. */
function assertNoErrorBody(data, prov) {
  const err = data && (data.error || (data.choices && data.choices.error));
  if (!err) return;
  const msg = typeof err === 'string' ? err : (err.message || err.msg || JSON.stringify(err));
  throw new Error(`${(prov && (prov.name || prov.id)) || 'the provider'} said: ${String(msg).slice(0, 300)}`);
}

// --- chat -------------------------------------------------------------------

/** Everything `chat` does, without the health bookkeeping around it. */
async function chatOnce({ messages, model = DEMO_ID, temperature, max_tokens, system, provider, keys, tools, signal, effort, guardNetwork = false, allowPrivate = false }) {
  const request = guardNetwork
    ? (url, init) => guardedFetch(url, init, { allowPrivate, timeoutMs: 8000 })
    : fetch;
  const ref = provider ? `${provider}::${model}` : model;
  const resolved = resolveModelRef(ref, keys);
  const prov = resolved.provider;
  const modelId = resolved.model.id;

  if (prov.id === 'demo' || modelId === DEMO_ID) return demoChat(messages, system);

  const tuned = effortParams(effort, { max_tokens, temperature });
  max_tokens = tuned.max_tokens;
  temperature = tuned.temperature;
  const wantReasoning = effortFor(prov, tuned.id, modelId);
  const thinkingBudget = wantReasoning.thinking_budget;
  let reasoningEffort = wantReasoning.reasoning_effort;
  // Anthropic's Messages API only allows extended thinking at temperature 1.
  const wireTemperature = thinkingBudget ? 1 : temperature;

  const sys = system || 'You are ANTICODEX, a powerful AI workspace assistant. Be precise, helpful and concise.';
  const endpoint = (prov.endpoint || NIM_ENDPOINT).replace(/\/$/, '');
  const apiKey = prov.api_key || keyFor(prov.key_env, keys);
  // A shared provider without a key is a configuration gap; a gateway the calling
  // machine added for itself is not — Ollama and LM Studio need no key, and the
  // answer must never come from Demo Core behind the user's back.
  if (!apiKey && !prov.local) throw new Error(`No API key configured for ${prov.name || prov.id}. Add one in Settings → Providers.`);

  const lastUser = messages[messages.length - 1];
  const hasImages = messages.some((m) => m.images?.length);

  // --- Anthropic Messages wire ---------------------------------------------
  if (prov.kind === 'anthropic' || prov.protocol === 'anthropic') {
    const url = endpoint.includes('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
    const res = await request(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}), // dual-auth: some gateways want Bearer
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelId, max_tokens, temperature: wireTemperature,
        system: sys,
        messages: messages.map((m) => ({
          role: m.role === 'system' ? 'user' : m.role === 'tool' ? 'user' : m.role,
          content: m.role === 'tool'
            ? `Tool ${m.name || ''} result: ${m.content}`
            : m.images?.length
            ? [...(m.content ? [{ type: 'text', text: m.content }] : []),
               ...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: (img.match(/^data:(.*?);/) || [,'image/png'])[1], data: img.split(',')[1] || '' } }))]
            : m.content
        })),
        // Extended thinking, in the only shape Claude accepts: a budget, and
        // temperature 1. Dropped automatically if this endpoint refuses it.
        ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
        ...(tools?.length ? {
          tools: tools.map((t) => ({
            name: t.function?.name || t.name,
            description: t.function?.description || t.description || '',
            input_schema: t.function?.parameters || t.inputSchema || { type: 'object', properties: {} }
          }))
        } : {})
      })
    });
    if (!res.ok) throw new Error(`${prov.name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    assertNoErrorBody(data, prov);
    const reasoning = (data.content || []).filter((c) => c.type === 'thinking').map((c) => c.thinking || '').join('');
    const toolCalls = (data.content || []).filter((c) => c.type === 'tool_use').map((c, i) => ({
      id: c.id || `call_${i}`, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
    }));
    return {
      text: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      content: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      tool_calls: toolCalls.length ? toolCalls : undefined,
      ...(reasoning ? { reasoning } : {}),
      model: data.model || modelId, provider: prov.id, usage: data.usage
    };
  }

  // --- Cohere v2 wire -------------------------------------------------------
  if (prov.protocol === 'cohere') {
    const res = await request(`${endpoint}/chat`, {
      method: 'POST',
      signal,
      headers: authHeader(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'system', content: sys }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
        max_tokens, temperature
      })
    });
    if (!res.ok) throw new Error(`${prov.name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    assertNoErrorBody(data, prov);
    const textOut = data.message?.content?.map((c) => c.text).filter(Boolean).join('\n') || '';
    return { text: textOut, model: data.model || modelId, provider: prov.id, usage: data.usage };
  }

  // --- OpenAI-compatible wire (NVIDIA NIM, OpenAI, DeepSeek, Gemini openai/
  //     compat, xAI, Mistral, Qwen, Kimi, Z.ai, Groq, Together, Fireworks,
  //     Cerebras, Perplexity, OpenRouter, MiniMax, Hunyuan, Atria, Azure…) ---
  const msgs = [
    { role: 'system', content: sys },
    ...messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: String(m.content || '') };
      return {
        role: m.role,
        content: m.images?.length
          ? [...(m.content ? [{ type: 'text', text: m.content }] : []),
             ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img } }))]
          : m.content
      };
    })
  ];
  // Gemini's openai-compat lives under /v1beta/openai; others append /chat/completions.
  const url = endpoint.endsWith('/openai') || endpoint.includes('/openai')
    ? `${endpoint}/chat/completions`
    : endpoint.includes('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;

  const oaiHeaders = authHeader(apiKey, {
    'Content-Type': 'application/json',
    ...(prov.id === 'openrouter' ? { 'HTTP-Referer': 'https://anticodex.app', 'X-Title': 'ANTICODEX' } : {})
  });
  const oaiPost = (extra) => request(url, {
    method: 'POST',
    signal,
    headers: oaiHeaders,
    body: JSON.stringify({
      model: modelId, messages: msgs, temperature, max_tokens, stream: false,
      ...extra,
      ...(tools?.length ? { tools: tools.map((t) => ({
        type: 'function',
        function: {
          name: t.function?.name || t.name,
          description: t.function?.description || t.description || '',
          parameters: t.function?.parameters || t.inputSchema || { type: 'object', properties: {} }
        }
      })) } : {})
    })
  });
  // Ask for deliberation only where it is supported, and drop it once if the
  // provider disagrees rather than turning a speed knob into a failed request.
  const askEffort = (extra) => oaiPost(reasoningEffort ? { reasoning_effort: reasoningEffort, ...extra } : extra);
  let res = await askEffort({});
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`${prov.name || prov.id} returned ${res.status}: ${text}`);
    if (reasoningEffort && optionalParamRejected(err)) {
      effortRejected.add(prov.id);
      reasoningEffort = null;
      res = await askEffort({});
      if (!res.ok) throw new Error(`${prov.name || prov.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } else throw err;
  }
  const data = await res.json();
  assertNoErrorBody(data, prov);
  const msg = data.choices?.[0]?.message || {};
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  return {
    text: msg.content ?? '',
    content: msg.content ?? '',
    tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
    ...(reasoning ? { reasoning } : {}),
    model: data.model || modelId,
    provider: prov.id,
    usage: data.usage
  };
}

/**
 * A model call, measured.
 *
 * Every real call is also an answer to "does this model exist for this key, and
 * how slow is it?" — recorded in lib/model-health.js so the picker can hide ids
 * a provider has rejected and can label the slow ones instead of leaving people
 * to wonder whether anything is happening.
 */
export async function chat(opts) {
  const started = Date.now();
  const ref = modelRef(opts.model, opts.provider);
  try {
    const out = await chatOnce(opts);
    if (out && out.provider !== 'demo') {
      recordOutcome(ref, { state: 'ok', ms: Date.now() - started, provider: out.provider });
    }
    return out;
  } catch (e) {
    const state = classifyFailure(e);
    if (ref !== DEMO_ID) {
      recordOutcome(ref, { state, ms: Date.now() - started, error: String(e && e.message ? e.message : e) });
    }
    throw e;
  }
}

/**
 * A streamed model call.
 *
 * The complaint this exists for is not "the answer is wrong", it is "I cannot
 * tell whether it is going to answer at all". So the caller gets phases and
 * heartbeats as well as text: `contacting` → `waiting` (with a heartbeat every
 * few seconds) → `delta` → `done`.
 *
 * Anthropic Messages and OpenAI-compatible wires both stream. Cohere and the
 * demo core do not, and are emitted as one delta rather than pretending.
 * Tool calls are collected across the stream and returned, so the caller can
 * run its tool loop and then stream the next leg.
 */
export async function chatStream(opts, { onEvent = () => {}, signal, heartbeatMs = 5000 } = {}) {
  const { messages, model = DEMO_ID, system, provider, keys, tools, effort } = opts;
  if (isAgentRef(model)) {
    // The bridge intercepts this ref and drives `qodercli --acp` itself; reaching
    // here means a caller skipped that path, and guessing would spawn a process.
    throw new Error('The Qoder CLI agent runs through the bridge agent path, not the HTTP chat path.');
  }
  const ref = modelRef(model, provider);
  const started = Date.now();
  let firstTokenMs = null;
  let text = '';
  // Visible deliberation. The token count of the answer is unchanged by it; what
  // changes is whether silence is explained (`phase: thinking`) or just silence.
  let reasoning = '';
  let thinkingStarted = null;
  let thinkingMs = null;
  const emit = (evt) => { try { onEvent(evt); } catch { /* a dead socket must not kill the model call */ } };
  emit({ type: 'phase', phase: 'contacting', ref, at: started });

  let beat;
  let sawResponse = false;
  const startBeat = () => {
    stopBeat();
    beat = setInterval(() => {
      emit({ type: 'heartbeat', elapsed_ms: Date.now() - started, waiting_on: sawResponse ? 'tokens' : 'the provider' });
    }, heartbeatMs);
    if (typeof beat.unref === 'function') beat.unref();
  };
  const stopBeat = () => { if (beat) clearInterval(beat); beat = null; };
  startBeat();

  const done = (extra = {}) => {
    stopBeat();
    const elapsed = Date.now() - started;
    if (ref !== DEMO_ID && !extra.error) recordOutcome(ref, { state: 'ok', ms: elapsed, firstTokenMs, provider });
    emit({
      type: 'done', elapsed_ms: elapsed, first_token_ms: firstTokenMs, chars: text.length,
      ...(reasoning ? { reasoning_chars: reasoning.length, thinking_ms: thinkingMs } : {}),
      ...extra
    });
  };
  const fail = (e) => {
    stopBeat();
    const state = classifyFailure(e);
    if (ref !== DEMO_ID) recordOutcome(ref, { state, ms: Date.now() - started, error: String(e && e.message ? e.message : e) });
    emit({ type: 'error', error: String(e && e.message ? e.message : e), state });
  };

  try {
    const resolved = resolveModelRef(provider ? `${provider}::${model}` : model, keys);
    const prov = resolved.provider;
    const modelId = resolved.model.id;
    const tuned = effortParams(effort, { max_tokens: opts.max_tokens, temperature: opts.temperature });
    const max_tokens = tuned.max_tokens;
    const temperature = tuned.temperature;
    const wantReasoning = effortFor(prov, tuned.id, modelId);
    let reasoningEffort = wantReasoning.reasoning_effort;
    const thinkingBudget = wantReasoning.thinking_budget;
    if (prov.id === 'demo' || modelId === DEMO_ID) {
      const out = demoChat(messages, system);
      emit({ type: 'phase', phase: 'demo', detail: 'offline demo core — no network call' });
      emit({ type: 'delta', text: out.text });
      text = out.text;
      done({ model: out.model });
      return { ...out, first_token_ms: 0 };
    }

    const endpoint = (prov.endpoint || NIM_ENDPOINT).replace(/\/$/, '');
    const apiKey = prov.api_key || keyFor(prov.key_env, keys);
    if (!apiKey && !prov.local) throw new Error(`No API key configured for ${prov.name || prov.id}. Add one in Settings → Providers.`);
    const sys = system || 'You are ANTICODEX, a powerful AI workspace assistant. Be precise, helpful and concise.';

    const onDelta = (piece) => {
      if (!piece) return;
      if (thinkingStarted != null && thinkingMs == null) thinkingMs = Date.now() - started - thinkingStarted;
      if (firstTokenMs == null) {
        firstTokenMs = Date.now() - started;
        emit({ type: 'phase', phase: 'streaming', first_token_ms: firstTokenMs });
      }
      text += piece;
      emit({ type: 'delta', text: piece });
    };
    const onHead = () => { sawResponse = true; emit({ type: 'phase', phase: 'connected', at: Date.now() - started }); };
    // Reasoning arrives before the answer and is shown as it is produced: the
    // first thought is the difference between "thinking" and "hung".
    const onThinking = (piece) => {
      if (!piece) return;
      if (thinkingStarted == null) {
        thinkingStarted = Date.now() - started;
        emit({ type: 'phase', phase: 'thinking', at: Date.now() - started });
      }
      reasoning += piece;
      emit({ type: 'thinking', text: piece });
    };

    // --- Anthropic Messages ------------------------------------------------
    if (prov.kind === 'anthropic' || prov.protocol === 'anthropic') {
      const url = endpoint.includes('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
      const anthPost = (withThinking) => fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          // Extended thinking requires temperature 1 on this wire.
          model: modelId, max_tokens, temperature: withThinking ? 1 : temperature, system: sys, stream: true,
          ...(withThinking ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
          messages: messages.map((m) => ({
            role: m.role === 'system' || m.role === 'tool' ? 'user' : m.role,
            content: m.role === 'tool' ? `Tool ${m.name || ''} result: ${m.content}` : (m.content || '')
          })),
          ...(tools?.length ? {
            tools: tools.map((t) => ({
              name: t.function?.name || t.name,
              description: t.function?.description || t.description || '',
              input_schema: t.function?.parameters || t.inputSchema || { type: 'object', properties: {} }
            }))
          } : {})
        })
      });
      let res = await anthPost(Boolean(thinkingBudget));
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const err = new Error(`${prov.name} returned ${res.status}: ${body}`);
        if (thinkingBudget && optionalParamRejected(err)) {
          res = await anthPost(false);
          if (!res.ok) throw new Error(`${prov.name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
        } else throw err;
      }
      onHead();
      const toolUse = new Map();
      for await (const evt of sseEvents(res, signal)) {
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          toolUse.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: '' });
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          onThinking(evt.delta.thinking);
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          onDelta(evt.delta.text);
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
          const t = toolUse.get(evt.index);
          if (t) t.json += evt.delta.partial_json || '';
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message || 'the provider reported an error mid-stream');
        }
      }
      const tool_calls = [...toolUse.values()].map((t, i) => ({
        id: t.id || `call_${i}`, type: 'function',
        function: { name: t.name, arguments: t.json || '{}' }
      }));
      const out = {
        text, content: text, model: modelId, provider: prov.id,
        ...(reasoning ? { reasoning } : {}),
        ...(tool_calls.length ? { tool_calls } : {})
      };
      done({ model: modelId, tool_calls: tool_calls.length ? tool_calls : undefined });
      return { ...out, first_token_ms: firstTokenMs, thinking_ms: thinkingMs };
    }

    // --- OpenAI-compatible -------------------------------------------------
    if (prov.protocol === 'cohere') {
      // Cohere v2 has streaming, but this build does not speak its event shape;
      // say so with the real answer rather than a fake typewriter.
      emit({ type: 'phase', phase: 'non-streaming', detail: 'this wire does not stream here — the answer arrives in one piece' });
      const out = await chatOnce({ messages, model, temperature, max_tokens, system, provider, keys, tools, effort, signal });
      text = out.text || '';
      if (out.reasoning) { reasoning = out.reasoning; emit({ type: 'thinking', text: out.reasoning }); }
      if (text) emit({ type: 'delta', text });
      done({ model: out.model, tool_calls: out.tool_calls });
      return out;
    }

    const msgs = [
      { role: 'system', content: sys },
      ...messages.map((m) => {
        if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: String(m.content || '') };
        return {
          role: m.role,
          content: m.images?.length
            ? [...(m.content ? [{ type: 'text', text: m.content }] : []),
               ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img } }))]
            : m.content
        };
      })
    ];
    const url = endpoint.endsWith('/openai') || endpoint.includes('/openai')
      ? `${endpoint}/chat/completions`
      : endpoint.includes('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
    const streamHeaders = authHeader(apiKey, {
      'Content-Type': 'application/json',
      ...(prov.id === 'openrouter' ? { 'HTTP-Referer': 'https://anticodex.app', 'X-Title': 'ANTICODEX' } : {})
    });
    const streamPost = (withEffort) => fetch(url, {
      method: 'POST',
      signal,
      headers: streamHeaders,
      body: JSON.stringify({
        model: modelId, messages: msgs, temperature, max_tokens, stream: true,
        ...(withEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools?.length ? { tools: tools.map((t) => ({
          type: 'function',
          function: {
            name: t.function?.name || t.name,
            description: t.function?.description || t.description || '',
            parameters: t.function?.parameters || t.inputSchema || { type: 'object', properties: {} }
          }
        })) } : {})
      })
    });
    let res = await streamPost(Boolean(reasoningEffort));
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`${prov.name || prov.id} returned ${res.status}: ${body}`);
      if (reasoningEffort && optionalParamRejected(err)) {
        // This endpoint does not take the knob; remember that and answer anyway.
        effortRejected.add(prov.id);
        reasoningEffort = null;
        res = await streamPost(false);
        if (!res.ok) throw new Error(`${prov.name || prov.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      } else throw err;
    }
    onHead();
    const calls = [];
    let usage = null;
    for await (const chunk of sseEvents(res, signal)) {
      if (chunk.error) throw new Error(chunk.error.message || 'the provider reported an error mid-stream');
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      // NVIDIA NIM, DeepSeek, OpenRouter and friends stream the deliberation as
      // `reasoning_content` (or `reasoning`); it is not the answer, but it is the
      // thing that makes a 20-second wait legible.
      const thought = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof thought === 'string' && thought) onThinking(thought);
      const piece = choice.delta?.content;
      if (piece) onDelta(piece);
      for (const tc of choice.delta?.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] = calls[i] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name = tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
    const tool_calls = calls.filter(Boolean);
    const out = {
      text, content: text, model: modelId, provider: prov.id,
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
      ...(tool_calls.length ? { tool_calls } : {})
    };
    done({ model: modelId, tool_calls: tool_calls.length ? tool_calls : undefined });
    return { ...out, first_token_ms: firstTokenMs, thinking_ms: thinkingMs };
  } catch (e) {
    if (e?.name === 'AbortError') {
      stopBeat();
      emit({ type: 'aborted', elapsed_ms: Date.now() - started, chars: text.length });
      return { text, content: text, aborted: true, provider: null };
    }
    fail(e);
    throw e;
  }
}

/** Minimal SSE reader for `data: {...}` lines (and Anthropic's `event:` pairs). */
async function* sseEvents(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const payload = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!payload || payload === '[DONE]') continue;
        try { yield JSON.parse(payload); } catch { /* keep-alive comment or a partial frame */ }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Ask one model for eight tokens — the cheapest honest "does this exist?". */
export async function probeModel({ model, provider, keys, timeoutMs = 20000, allowPrivate = false }) {
  const started = Date.now();
  const controller = new AbortController();
  // The timeout has to reach the socket: a controller nobody passes to fetch
  // aborts nothing, and a probe against a provider that accepts the connection
  // then hangs would sit in Settings until the OS gives up on it.
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const out = await chat({
      messages: [{ role: 'user', content: 'ping' }],
      model, provider, keys, max_tokens: 8, temperature: 0, signal: controller.signal,
      guardNetwork: true, allowPrivate
    });
    return { ok: true, model, provider: out.provider || provider, ms: Date.now() - started };
  } catch (e) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false, model, provider, ms: Date.now() - started,
      error: timedOut ? `no answer in ${Math.round(timeoutMs / 1000)}s — the probe gave up and closed the connection` : String(e.message || e),
      state: timedOut ? 'network' : classifyFailure(e)
    };
  } finally {
    clearTimeout(t);
  }
}

// --- endpoint testing (Claude-desktop Developer panel equivalent) -----------

export async function testEndpoint({ endpoint, api_key, type = 'openai', provider, keys, allowPrivate = false }) {
  // providerDefFor, not findProviderDef: a user's own gateway in
  // CUSTOM_PROVIDERS has to be testable/syncable from its own row too.
  const def = provider ? providerDefFor(provider, keys) : null;
  const base = (endpoint || def?.endpoint || '').replace(/\/$/, '');
  const key = api_key || (def ? keyFor(def.key_env, keys) : '');
  const wire = type || def?.protocol || 'openai';
  if (!base) return { ok: false, error: 'endpoint required' };
  const request = (url, init) => guardedFetch(url, init, { allowPrivate, timeoutMs: 8000 });

  try {
    if (wire === 'anthropic') {
      const res = await request(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] })
      });
      return res.ok
        ? { ok: true, type: 'anthropic', verdict: 'key', message: 'Anthropic-compatible endpoint accepted the test call.' }
        : {
            ok: false, status: res.status, verdict: verdictFor(res.status),
            ...(verdictFor(res.status) === 'key' ? { settings_link: '/settings' } : {}),
            error: (await res.text()).slice(0, 200)
          };
    }
    if (wire === 'cohere') {
      const res = await request(`${base}/chat`, {
        method: 'POST',
        headers: authHeader(key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: 'command-a', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 })
      });
      return res.ok
        ? { ok: true, type: 'cohere', verdict: 'key', message: 'Cohere v2 endpoint accepted the test call.' }
        : {
            ok: false, status: res.status, verdict: verdictFor(res.status),
            ...(verdictFor(res.status) === 'key' ? { settings_link: '/settings' } : {}),
            error: (await res.text()).slice(0, 200)
          };
    }
    if (wire === 'bedrock' || wire === 'vertex') {
      return {
        ok: false,
        error: `${wire} needs ${wire === 'bedrock' ? 'AWS SigV4 credentials' : 'Google ADC'} — use the cloud console setup, or route these models through OpenRouter with one API key.`
      };
    }
    // openai-compatible + google(openai-compat)
    const list = await request(`${base}/models`, { headers: authHeader(key) });
    let models = [];
    if (list.ok) {
      const data = await list.json().catch(() => ({}));
      models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
      // Proving the key is also the moment we learn the truth about this
      // endpoint: remember the ids so the picker and the default model use them.
      if (provider && models.length) rememberLiveModels(provider, models, base);
    }
    const probeModel = realModelId({ models: [{ id: models[0] }, ...(def?.models || [])] }, models[0] || def?.models?.[0]?.id || 'default');
    const probe = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeader(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 })
    });
    const probeData = await probe.json().catch(() => ({}));
    // Many gateways (NVIDIA included) answer 200 with an error body. Counting
    // that as "key works" is exactly how a dead key ends up looking configured.
    const probeErr = probeData && (probeData.error || probeData.error_message);
    const rawErr = probeErr
      ? String(typeof probeErr === 'string' ? probeErr : (probeErr.message || JSON.stringify(probeErr)))
      : '';
    // A reasoning model refusing `max_tokens: 4` says nothing about the key, so
    // only a complaint about the *request* counts as "the key is fine".
    const parameterish = /\b(max_tokens|temperature|top_p|messages|thinking|reasoning_effort)\b|not supported|unsupported|field required|invalid_request|at least/i.test(rawErr);
    if (probe.ok && !probeErr) {
      return {
        ok: true, type: 'openai', models: models.slice(0, 200), model: probeModel, verified: models.length,
        message: `Key works — ${models.length} models listed and "${probeModel}" answered.`,
        ...(models.length ? {} : { note: 'No model ids came back, so the picker keeps the catalog list until you Sync.' })
      };
    }
    if (list.ok && probe.status === 400 && parameterish) {
      return {
        ok: true, type: 'openai', models: models.slice(0, 200), model: probeModel, verified: models.length,
        message: `Key works — ${models.length} models listed. The bare test call was refused by that model's own parameter rules, which is not a key problem.`,
        hint: 'Pick a chat model in the model menu if you want a full round-trip test.'
      };
    }
    const status = probe.status;
    const why = probeErr ? explainProviderError(rawErr, provider || 'this endpoint', probeModel) : null;
    if (why) {
      return {
        ok: false, status, verdict: why.verdict || why.fix,
        ...(why.fix === 'key' || why.fix === 'endpoint' ? { settings_link: '/settings' } : {}),
        error: `${(def && def.name) || provider} answered with an error: ${String(why.error).slice(0, 200)}`,
        listed_models: models.length, hint: 'The HTTP status was fine, so this is about the key or the model — not the URL.'
      };
    }
    return {
      ok: false, status, verdict: verdictFor(status),
      ...(verdictFor(status) === 'key' ? { settings_link: '/settings' } : {}),
      error: String((probeData && probeData.detail) || `the endpoint returned ${status}`).slice(0, 200)
    };
  } catch (e) {
    return {
      ok: false, verdict: 'unreachable', base,
      error: `this server could not reach ${base} (${String(e.message || e).slice(0, 120)}) — that is a network limit here, not a bad key`,
      fix: 'endpoint', settings_link: '/settings'
    };
  }
}

// --- live model sync (OpenRouter / NIM / any /models) -----------------------

const SYNC_TTL_MS = 10 * 60 * 1000;
const syncCache = new Map();   // "provider|keyFingerprint" -> { at, models }

/** Directory entry OR a CUSTOM_PROVIDERS gateway — every listing/sync/test path
 *  must understand both, or a key you added for your own gateway is invisible. */
export function providerDefFor(id, keysOverride) {
  const def = id ? findProviderDef(String(id)) : null;
  if (def) return def;
  try {
    const custom = gatewayDefs(keysOverride).find((p) => p.id === id);
    if (!custom) return null;
    return {
      id: custom.id, name: custom.name || custom.id, protocol: custom.type || 'openai',
      endpoint: custom.endpoint, key_env: custom.key_env || null, models: custom.models || [],
      models_dynamic: true, placeholder: custom.placeholder, homepage: custom.homepage,
      // `custom` says where it came from in general; `local` says this particular
      // row was supplied by the device making the request — the flag every
      // "may I talk to it without a key" decision keys off.
      custom: true, local: Boolean(custom.local), effort: custom.effort === true
    };
  } catch { return null; }
}

function labelFor(id) {
  const tail = String(id).split('/').pop() || String(id);
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bV(\d)/g, 'V$1');
}

/** Live model list for a provider (any OpenAI-compatible `/models`).
 *  Cached briefly per key, and mergeable with the curated catalog so a user can
 *  always pick "any model I want" even before the first sync. */
export async function syncModels({ provider, keys, api_key, endpoint, refresh, allowPrivate = false } = {}) {
  const def = providerDefFor(provider, keys);
  if (!def && !endpoint) return { ok: false, error: `unknown provider "${provider}" — pass endpoint for a custom gateway` };
  const key = api_key || (def?.key_env ? keyFor(def.key_env, keys) : '') || (def && def.api_key) || '';
  // Open local gateways list their models with no credential at all, so asking
  // for a key first would break the most common desktop setup on purpose.
  if (!key && !def?.local) return {
    ok: false,
    error: `no API key for ${(def && def.name) || provider} yet. Save yours in Settings → Providers (it applies to your account immediately).`,
    key_env: (def && def.key_env) || null, settings_link: '/settings'
  };
  const base = String(endpoint || def.endpoint).replace(/\/$/, '');
  const ck = `${provider || 'custom'}|${base}|${key.slice(-6)}`;
  const hit = syncCache.get(ck);
  if (hit && !refresh && Date.now() - hit.at < SYNC_TTL_MS) {
    const live = hit.models.filter((m) => m && m.live).length;
    return {
      ok: true, provider, models: hit.models, count: hit.models.length, source: 'cache', cached: true,
      verified: true, live: live || hit.models.length
    };
  }
  try {
    const headers = authHeader(key);
    if (def && def.protocol === 'anthropic' && key) headers['x-api-key'] = key;
    const res = await guardedFetch(`${base}/models`, { headers }, { allowPrivate, timeoutMs: 8000 });
    if (!res.ok) {
      const verdict = verdictFor(res.status);
      return {
        ok: false, provider, status: res.status, verdict, key_env: (def && def.key_env) || null,
        ...(verdict === 'key' ? { settings_link: '/settings' } : {}),
        error: res.status === 401 || res.status === 403
          ? `${(def && def.name) || provider} rejected this key for /models (${res.status}) — it is the key, not the model list.`
          : `the endpoint returned ${res.status} — check the key and endpoint in Settings → Providers.`
      };
    }
    const data = await res.json().catch(() => ({}));
    const raw = data.data || data.models || data.body || [];
    const models = raw.map((m) => {
      const id = typeof m === 'string' ? m : (m.id || m.name || m.model_id);
      if (!id) return null;
      const label = (m && (m.name || m.display_name)) && typeof m.name === 'string' && m.name !== id ? m.name : labelFor(id);
      return { id, label };
    }).filter(Boolean);
    if (!models.length) return { ok: false, provider, error: 'the endpoint answered but listed no models' };
    // Live list first (it is the truth about what this key can call), then the
    // curated extras, flagged so the UI can admit they are unproven here.
    rememberLiveModels(def?.id || provider, models, base);
    const out = tagModels(def?.models || (def?.id === 'openrouter' ? openrouterFallback() : []), models).slice(0, 800);
    syncCache.set(ck, { at: Date.now(), models: out });
    return {
      ok: true, provider, models: out, count: out.length, source: 'provider', verified: true,
      live: models.length, catalog: (def?.models || []).length
    };
  } catch (e) {
    return {
      ok: false, provider, verdict: 'unreachable',
      error: `this server could not reach ${base} (${String(e.message || e).slice(0, 120)}) — that is a network limit here, not a bad key. Try the Test button on the deployed site or in the desktop app.`
    };
  }
}

/**
 * Everything the model picker needs, in one call.
 *
 * Two things are filtered out of the default list, because both of them used to
 * end in "there is nothing like this model available":
 *
 *   * ids a provider has explicitly rejected (lib/model-health.js) — unless the
 *     provider's own live list still names them, which is fresher than we are;
 *   * catalog guesses for a provider whose live list we already have. Once the
 *     endpoint has told us what it serves, sending it anything else is a guess,
 *     and a guess is what produced the error in the first place.
 *
 * Nothing is deleted: `hidden` carries both groups with the reason, so Settings
 * can show what was removed and put any of it back (`include_hidden: true`).
 */
export function modelIndex(keysOverride, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  const strictLive = opts.strictLive !== false;
  const rows = [];
  const hidden = [];

  const shape = (m, provider, live) => {
    const ann = annotate({ ...m, provider }, { liveConfirmed: live });
    return {
      id: ann.id,
      label: ann.label || ann.id,
      vision: !!ann.vision,
      reasoning: !!ann.reasoning,
      tools: !!ann.tools,
      live,
      unverified: !live,
      ...(ann.health ? { health: ann.health } : {}),
      ...(ann.dead ? { dead: true, dead_reason: ann.dead_reason } : {})
    };
  };

  // Ids someone actually tried and the provider rejected, even when they were
  // never in the catalog (a typed-in id, or a model that was removed upstream).
  // These belong in the same explanation as the filtered catalog guesses.
  const tracked = allHealth().filter((h) => h.dead);

  const build = (p) => {
    const liveIds = new Set((p.models || []).filter((m) => m.live).map((m) => m.id));
    const verified = Boolean(p.models_verified) || liveIds.size > 0;
    const kept = [];
    for (const m of p.models || []) {
      const live = m.live === true || (verified && !m.unverified);
      const row = shape(m, p.id, live);
      if (row.dead && !live) {
        if (includeHidden) kept.push(row);
        else hidden.push({ ...row, provider: p.id, hidden_because: 'rejected', reason: row.dead_reason });
        continue;
      }
      if (strictLive && verified && !live) {
        if (includeHidden) kept.push(row);
        else hidden.push({ ...row, provider: p.id, hidden_because: 'unverified', reason: `${p.name || p.id} did not list this id in its own /models answer` });
        continue;
      }
      kept.push(row);
    }
    for (const h of tracked.filter((x) => x.provider === p.id)) {
      const id = h.model || h.ref;
      if (kept.some((m) => m.id === id)) continue;
      const row = {
        id, label: id, vision: false, reasoning: false, tools: false, live: false, unverified: true,
        dead: true, dead_reason: h.last_error || 'the provider says this model does not exist',
        health: { state: h.state, checks: h.checks || 0, checked_at: h.checked_at || null, latency_ms: h.latency_ms ?? null, last_error: h.last_error || null }
      };
      if (includeHidden) kept.push(row);
      else hidden.push({ ...row, provider: p.id, hidden_because: 'rejected', reason: row.dead_reason });
    }
    return {
      id: p.id, name: p.name, kind: p.kind, configured: p.configured, key_env: p.key_env,
      category: p.category || (p.id === 'demo' ? 'Built in' : 'Gateway'),
      endpoint: p.endpoint || null, placeholder: p.placeholder || null, homepage: p.homepage || null,
      models_dynamic: Boolean(p.models_dynamic), models_note: p.models_note || null,
      verified,
      catalog_hidden: strictLive && verified ? (p.models || []).filter((m) => !m.live && !m.unverified).length + (p.models || []).filter((m) => m.unverified).length - kept.filter((m) => !m.live).length : 0,
      models: kept
    };
  };

  for (const p of listProviders(keysOverride, { all: true })) rows.push(build(p));
  for (const p of listProviders(keysOverride, { all: true })) {
    if (!String(p.id).startsWith('custom_') && !p.custom && !rows.some((x) => x.id === p.id)) {
      rows.push({ ...build({ ...p, models_note: 'Added on this server as a custom gateway' }), models_dynamic: true });
    }
  }

  return {
    providers: rows,
    total_models: rows.reduce((a, p) => a + p.models.length, 0),
    configured: rows.filter((p) => p.configured).length,
    hidden: {
      count: hidden.length,
      rejected: hidden.filter((h) => h.hidden_because === 'rejected').length,
      unverified: hidden.filter((h) => h.hidden_because === 'unverified').length,
      // Capped: this is an explanation, not a second catalog.
      models: hidden.slice(0, 60)
    }
  };
}

/** Turn a raw provider failure into something a person can act on. */
export function explainProviderError(err, providerName, modelId) {
  const raw = String(err && err.message ? err.message : err || '');
  const name = providerName || 'the provider';
  // `verdict` is what the UI paints with: key | model | quota | retry | endpoint.
  const withVerdict = (o) => ({ verdict: o.fix === 'key' ? 'key' : o.fix, ...o });
  if (/No API key configured/i.test(raw)) return { error: `${name} has no API key yet. Add one in Settings → Providers, then pick a model.`, fix: 'key' };
  if (/(\b401\b|unauthorized|invalid API key|invalid api key|incorrect API key|authentication)/i.test(raw)) return { error: `${name} rejected your API key. Re-paste it in Settings → Providers (keys are per account, and they expire).`, fix: 'key' };
  if (/(\b403\b|forbidden|permission)/i.test(raw)) return { error: `${name} refused this request (403) — your key may not include this model or endpoint.`, fix: 'key' };
  // A 404 is not automatically about the model. NVIDIA NIM answers
  // {"status":404,"title":"Not Found","detail":"Function '<uuid>': Not found for
  // account '…'"} for *every* model when the key is unknown or the account lacks
  // the "Public API Endpoints" entitlement. Sending that user to the model picker
  // swaps ids that were never the problem — and the swap fails the same way.
  if (/\b404\b/.test(raw) && !/\bmodel\b/i.test(raw)
    && /(not found for account|function [^.]{0,60}not found|page not found|endpoint not found|route not found)/i.test(raw)) {
    const detail = (raw.match(/"detail"\s*:\s*"([^"]{4,160})"/i) || raw.match(/"message"\s*:\s*"([^"]{4,160})"/i) || [])[1];
    return {
      error: `${name} answered 404 for the request itself, not for the model${detail ? ` — its own words: “${detail}”` : ''}. That is the key or the account behind it (on NVIDIA NIM this is the “Public API Endpoints” entitlement), so check the API key and Base URL in Settings → Providers; another model will fail the same way.`,
      fix: 'key'
    };
  }
  if (/(\b404\b|not found|does not exist|unknown model|invalid model|model_not_found)/i.test(raw)) return { error: `${name} has no model called "${modelId}". Pick another model in the picker (or Sync models for the live list).`, fix: 'model' };
  if (/(\b429\b|rate ?limit|quota|insufficient (?:funds|balance))/i.test(raw)) return { error: `${name} rate-limited or ran out of quota (429). Wait a moment or switch model.`, fix: 'quota' };
  if (/(\b5\d\d\b|overloaded|bad gateway|server error)/i.test(raw)) return { error: `${name} is having trouble right now (${raw.match(/\b5\d\d\b/)?.[0] || 'server error'}). Try again or pick another model.`, fix: 'retry' };
  // A server with no route to the provider looks identical to a dead key unless
  // you say so out loud — so this branch never blames the user's key.
  if (/abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|network|could not reach/i.test(raw)) {
    return {
      error: `Can't reach ${name} from this server — nothing answered, so your key was never actually tested. Check the Base URL in Settings → Providers; if you are running ANTICODEX somewhere with no outbound access, the same key will work on the deployed site or the desktop app.`,
      fix: 'endpoint', verdict: 'unreachable'
    };
  }
  return withVerdict({ error: raw.slice(0, 300) || `${name} failed`, fix: 'none' });
}

/** When an endpoint says "no model called X", what should we send instead?
 *  Scores its own live list: same words, chat-tuned, and free tiers. */
export function pickLiveModel(providerId, wanted) {
  const live = liveModels(providerId);
  if (!live || !live.length) return null;
  const tokens = String(wanted || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  let best = null;
  let score = -1;
  for (const m of live) {
    const id = String(m.id).toLowerCase();
    let sc = tokens.reduce((a, t) => a + (id.includes(t) ? 1 : 0), 0);
    if (/instruct|chat|-it\b|final/.test(id)) sc += 0.5;
    if (/(-free|:free)$/.test(id)) sc += 0.25;
    if (m.label && m.label !== m.id) sc += 0.1;
    if (sc > score) { score = sc; best = m; }
  }
  return best && best.id !== wanted ? best.id : null;
}

/** Up to N ids this endpoint really serves, for one-click switching in the UI. */
export function liveAlternatives(providerId, except, n = 6) {
  const live = liveModels(providerId) || [];
  return live.filter((m) => m.id !== except).slice(0, n).map((m) => ({ id: m.id, label: m.label || m.id }));
}

// --- Built-in demo core -----------------------------------------------------

function demoChat(messages, system) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const lower = last.toLowerCase();
  let text;

  if (/^(hi|hello|hey|yo|sup)\b/.test(lower)) {
    text = 'Hello! I am **ANTICODEX Demo Core** — the offline engine that keeps this workspace fully functional before you connect API keys.\n\nHead to **Settings → Providers** to plug in NVIDIA NIM, DeepSeek, OpenAI, Anthropic, Gemini, Grok, Kimi, Qwen… any of the 25+ built-in endpoints.';
  } else if (lower.includes('what can you do') || lower.includes('features')) {
    text = `ANTICODEX workspace capabilities:

- **Chat** — 25+ provider endpoints (NVIDIA NIM primary), vision attachments, web search (Tavily/Exa), thread history
- **Codex** — file tree, diff proposals, sandbox terminal, approval modes
- **Agent Studio** — plans, project memory (\`ANTICODEX.md\`), skills, tool log
- **Images** — Cloudflare Workers AI Flux · **Video** — MiniMax Hailuo (H3)
- **MCP connectors** — GitHub, Drive, Slack, Notion, Postgres, Playwright… with OAuth-style connect pages
- **Computer-use** — desktop pairing, screen vision, mouse/keyboard control
- **Admin** — users, global keys, feature flags, releases`;
  } else if (lower.includes('deepseek')) {
    text = 'DeepSeek is fully wired: **DeepSeek V4.1 Flash 1017** (released 2026-10-17, API id `deepseek-flash`, 1M context, multimodal + thinking) and **V4 Pro** on `https://api.deepseek.com/v1`. Add your `DEEPSEEK_API_KEY` in Settings → Providers — or reach the same models through NVIDIA NIM or OpenRouter.';
  } else if (lower.includes('nvidia') || lower.includes('nemotron')) {
    text = 'NVIDIA NIM is the primary engine: **Nemotron 3.5 Lightning** (1M ctx, 3B active), **Nemotron 3.5 Super VL** (multimodal reasoning), **Nemotron 3 Ultra 550B**, **Nano/Super** and **NeMo Switchyard** routing — plus 100+ hosted models (DeepSeek V4.1 Flash, Llama, Qwen, Kimi…). Keys are free at build.nvidia.com.';
  } else if (lower.includes('code') || lower.includes('function') || lower.includes('javascript') || lower.includes('python')) {
    text = 'Here is a starter example:\n\n```javascript\n// Fibonacci with memoization\nconst memo = new Map();\nfunction fib(n) {\n  if (n < 2) return n;\n  if (memo.has(n)) return memo.get(n);\n  const value = fib(n - 1) + fib(n - 2);\n  memo.set(n, value);\n  return value;\n}\nconsole.log(fib(50));\n```\n\nConnect any live model in **Settings → Providers** for full generative coding.';
  } else if (lower.includes('mcp')) {
    text = 'The **MCP Connectors** page lets you connect external tool servers exactly like ChatGPT connectors: pick a server from the catalog, sign in on the authorization page, edit the granted permissions, then call its tools from chat, Codex, or the Agent Studio.';
  } else if (last.trim()) {
    text = `I received your message in **demo mode**:\n\n> ${last.slice(0, 400)}\n\nThe full routing stack is live: **25+ providers** (NVIDIA NIM, DeepSeek V4.1 Flash 1017, OpenAI GPT-6.x, Claude, Gemini 4, Grok 4.7, Kimi K3, GLM 5.3, Qwen3.8, MiniMax M3, OpenRouter…), vision, web search, Flux images and Hailuo video. Add keys in **Settings** and the same conversation goes to the live model you pick.`;
  } else {
    text = 'Send me a message to begin.';
  }

  return { text, model: DEMO_ID, provider: 'demo', usage: { prompt_tokens: 0, completion_tokens: text.length / 4 | 0 } };
}

export { DEMO_ID };
