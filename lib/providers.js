// AI provider engine — multi-protocol routing across the full provider directory:
// OpenAI-compatible, Anthropic Messages, Google (OpenAI-compat), Cohere v2.
// Keys resolve: desktop keychain override → request keys → env → admin runtime → hardcoded slots.

import { getKey, CATALOG } from './keys.js';
import { PROVIDER_DIRECTORY, OPENROUTER_EXTRA_MODELS, NIM_ENDPOINT, findProviderDef } from './catalog.js';

const DEMO_ID = 'anticodex/demo-core';

// --- key resolution ---------------------------------------------------------

function keyFor(envName, keysOverride) {
  if (keysOverride && keysOverride[envName]) return keysOverride[envName];
  return getKey(envName);
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
    models: def.id === 'openrouter' ? openrouterFallback() : def.models,
    models_note: def.models_note || null,
    models_dynamic: Boolean(def.models_dynamic),
    configured: providerConfigured(def, keysOverride)
  }));
}

function openrouterFallback() {
  return OPENROUTER_EXTRA_MODELS.map((id) => ({ id, label: id.split('/').slice(1).join('/') || id }));
}

export function listProviders(keysOverride) {
  const providers = [
    {
      id: 'demo', name: 'ANTICODEX Demo Core', kind: 'builtin', configured: true,
      models: [{ id: DEMO_ID, label: 'Demo Core (offline)', vision: true, tools: true }]
    }
  ];
  for (const def of PROVIDER_DIRECTORY) {
    const configured = providerConfigured(def, keysOverride);
    if (!configured && !def.primary) continue;
    providers.push({
      id: def.id, name: def.name, kind: def.protocol === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: def.endpoint, configured,
      key_env: def.key_env,
      models: def.id === 'openrouter' ? openrouterFallback() : def.models
    });
  }
  try {
    const custom = JSON.parse(getKey('CUSTOM_PROVIDERS') || '[]');
    for (const p of custom) {
      providers.push({
        id: p.id, name: p.name, kind: p.type || 'openai',
        endpoint: p.endpoint, configured: Boolean(p.api_key),
        models: (p.models || [{ id: p.default_model || 'default', label: p.default_model || 'default' }])
      });
    }
  } catch { /* ignore malformed custom list */ }
  return providers;
}

// Model reference format: "providerId::modelId" (also accepts bare modelId).
export function resolveModelRef(ref, keysOverride) {
  const [maybeProvider, ...rest] = String(ref || '').split('::');
  if (rest.length) {
    const modelId = rest.join('::');
    const def = findProviderDef(maybeProvider);
    if (def) return { provider: { ...def, api_key: keyFor(def.key_env, keysOverride), configured: true }, model: { id: modelId } };
    const custom = JSON.parse(getKey('CUSTOM_PROVIDERS') || '[]').find((p) => p.id === maybeProvider);
    if (custom) return { provider: { ...custom, kind: custom.type || 'openai' }, model: { id: modelId } };
  }
  // Bare id: search all providers (demo first, then directory order).
  const bare = String(ref || '');
  if (bare === DEMO_ID) return { provider: { id: 'demo', kind: 'builtin' }, model: { id: DEMO_ID } };
  for (const p of listProviders(keysOverride)) {
    const m = (p.models || []).find((x) => x.id === bare);
    if (m) return { provider: { ...p, api_key: keyFor(p.key_env, keysOverride) }, model: m };
  }
  // Unknown bare id with a primary key configured → send to NVIDIA NIM.
  if (keyFor('NVIDIA_API_KEY', keysOverride)) {
    return {
      provider: { id: 'nvidia', kind: 'openai', endpoint: NIM_ENDPOINT, api_key: keyFor('NVIDIA_API_KEY', keysOverride) },
      model: { id: bare }
    };
  }
  return { provider: { id: 'demo', kind: 'builtin' }, model: { id: bare } };
}

// --- chat -------------------------------------------------------------------

export async function chat({ messages, model = DEMO_ID, temperature = 0.7, max_tokens = 2048, system, provider, keys, tools }) {
  const ref = provider ? `${provider}::${model}` : model;
  const resolved = resolveModelRef(ref, keys);
  const prov = resolved.provider;
  const modelId = resolved.model.id;

  if (prov.id === 'demo' || modelId === DEMO_ID) return demoChat(messages, system);

  const sys = system || 'You are ANTICODEX, a powerful AI workspace assistant. Be precise, helpful and concise.';
  const endpoint = (prov.endpoint || NIM_ENDPOINT).replace(/\/$/, '');
  const apiKey = prov.api_key || keyFor(prov.key_env, keys);
  if (!apiKey) throw new Error(`No API key configured for ${prov.name || prov.id}. Add one in Settings → Providers.`);

  const lastUser = messages[messages.length - 1];
  const hasImages = messages.some((m) => m.images?.length);

  // --- Anthropic Messages wire ---------------------------------------------
  if (prov.kind === 'anthropic' || prov.protocol === 'anthropic') {
    const url = endpoint.includes('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`, // dual-auth: some gateways want Bearer
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelId, max_tokens, temperature,
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
    const toolCalls = (data.content || []).filter((c) => c.type === 'tool_use').map((c, i) => ({
      id: c.id || `call_${i}`, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
    }));
    return {
      text: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      content: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      tool_calls: toolCalls.length ? toolCalls : undefined,
      model: data.model || modelId, provider: prov.id, usage: data.usage
    };
  }

  // --- Cohere v2 wire -------------------------------------------------------
  if (prov.protocol === 'cohere') {
    const res = await fetch(`${endpoint}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'system', content: sys }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
        max_tokens, temperature
      })
    });
    if (!res.ok) throw new Error(`${prov.name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(prov.id === 'openrouter' ? { 'HTTP-Referer': 'https://anticodex.app', 'X-Title': 'ANTICODEX' } : {})
    },
    body: JSON.stringify({
      model: modelId, messages: msgs, temperature, max_tokens, stream: false,
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
  if (!res.ok) throw new Error(`${prov.name || prov.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    text: msg.content ?? '',
    content: msg.content ?? '',
    tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
    model: data.model || modelId,
    provider: prov.id,
    usage: data.usage
  };
}

// --- endpoint testing (Claude-desktop Developer panel equivalent) -----------

export async function testEndpoint({ endpoint, api_key, type = 'openai', provider, keys }) {
  const def = provider ? findProviderDef(provider) : null;
  const base = (endpoint || def?.endpoint || '').replace(/\/$/, '');
  const key = api_key || (def ? keyFor(def.key_env, keys) : '');
  const wire = type || def?.protocol || 'openai';
  if (!base) return { ok: false, error: 'endpoint required' };

  try {
    if (wire === 'anthropic') {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] })
      });
      return res.ok
        ? { ok: true, type: 'anthropic', message: 'Anthropic-compatible endpoint accepted the test call.' }
        : { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
    }
    if (wire === 'cohere') {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'command-a', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 })
      });
      return res.ok
        ? { ok: true, type: 'cohere', message: 'Cohere v2 endpoint accepted the test call.' }
        : { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
    }
    if (wire === 'bedrock' || wire === 'vertex') {
      return {
        ok: false,
        error: `${wire} needs ${wire === 'bedrock' ? 'AWS SigV4 credentials' : 'Google ADC'} — use the cloud console setup, or route these models through OpenRouter with one API key.`
      };
    }
    // openai-compatible + google(openai-compat)
    const list = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    let models = [];
    if (list.ok) {
      const data = await list.json().catch(() => ({}));
      models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    }
    const probeModel = models[0] || def?.models?.[0]?.id || 'default';
    const probe = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 })
    });
    return probe.ok || list.ok
      ? {
          ok: true, type: 'openai', models: models.slice(0, 200),
          message: models.length
            ? `Endpoint reachable — ${models.length} models available.`
            : 'Endpoint reachable.'
        }
      : { ok: false, status: probe.status, error: (await probe.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// --- live model sync (OpenRouter / NIM / any /models) -----------------------

export async function syncModels({ provider, keys }) {
  const def = findProviderDef(provider);
  if (!def) return { ok: false, error: 'unknown provider' };
  const key = keyFor(def.key_env, keys);
  if (!key) return { ok: false, error: `no key for ${def.name}` };
  try {
    const res = await fetch(`${def.endpoint.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const models = (data.data || data.models || []).map((m) => ({ id: m.id || m.name, label: m.id || m.name }));
    return { ok: true, provider, models: models.slice(0, 600) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
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
