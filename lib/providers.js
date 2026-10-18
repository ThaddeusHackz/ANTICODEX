// AI provider engine: NVIDIA NIM (primary), custom OpenAI-/Anthropic-compatible
// endpoints, and an always-works local demo model so the product never breaks.

import { getKey, CATALOG } from './keys.js';

const DEMO_ID = 'anticodex/demo-core';

export function listProviders() {
  const providers = [
    {
      id: 'demo',
      name: 'ANTICODEX Demo Core',
      kind: 'builtin',
      configured: true,
      models: [{ id: DEMO_ID, label: 'Demo Core (offline)', vision: true, tools: true }]
    },
    {
      id: 'nvidia',
      name: 'NVIDIA NIM (all models)',
      kind: 'openai',
      endpoint: CATALOG.nvidia_endpoint,
      configured: Boolean(getKey('NVIDIA_API_KEY')),
      models: CATALOG.nvidia_models
    }
  ];
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

export function findModel(modelId) {
  for (const p of listProviders()) {
    const m = (p.models || []).find((x) => x.id === modelId);
    if (m) return { provider: p, model: m };
  }
  return null;
}

// --- Chat -------------------------------------------------------------------

export async function chat({ messages, model = DEMO_ID, temperature = 0.7, max_tokens = 2048, system }) {
  const found = findModel(model);
  const provider = found?.provider || listProviders()[0];
  const modelId = found?.model?.id || model;

  if (provider.id === 'demo' || modelId === DEMO_ID) {
    return demoChat(messages, system);
  }

  const sys = system || 'You are ANTICODEX, a powerful AI workspace assistant. Be precise, helpful and concise.';
  const msgs = [
    { role: 'system', content: sys },
    ...messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [...(m.content ? [{ type: 'text', text: m.content }] : []),
           ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img } }))]
        : m.content
    }))
  ];

  const headers = { 'Content-Type': 'application/json' };
  let url;
  let body;

  if (provider.kind === 'anthropic') {
    url = `${provider.endpoint.replace(/\/$/, '')}/v1/messages`;
    headers['x-api-key'] = provider.api_key;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: modelId, max_tokens, temperature,
      system: sys,
      messages: messages.map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content }))
    };
  } else {
    // OpenAI-compatible (NVIDIA NIM + most gateways incl. OpenRouter, Groq, Ollama, LM Studio…)
    const endpoint = (provider.endpoint || CATALOG.nvidia_endpoint).replace(/\/$/, '');
    url = `${endpoint}/chat/completions`;
    headers['Authorization'] = `Bearer ${provider.api_key}`;
    body = { model: modelId, messages: msgs, temperature, max_tokens, stream: false };
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Provider ${provider.name} returned ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  if (provider.kind === 'anthropic') {
    const textOut = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { text: textOut, model: modelId, provider: provider.id, usage: data.usage };
  }
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    model: data.model || modelId,
    provider: provider.id,
    usage: data.usage
  };
}

export async function testEndpoint({ endpoint, api_key, type = 'openai' }) {
  const base = (endpoint || '').replace(/\/$/, '');
  if (!base) return { ok: false, error: 'endpoint required' };
  try {
    if (type === 'anthropic') {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] })
      });
      return res.ok
        ? { ok: true, type, message: 'Anthropic-compatible endpoint accepted the test call.' }
        : { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
    }
    const list = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${api_key}` } });
    let models = [];
    if (list.ok) {
      const data = await list.json().catch(() => ({}));
      models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    }
    const probe = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify({ model: models[0] || 'default', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 })
    });
    return probe.ok || list.ok
      ? { ok: true, type: 'openai', models: models.slice(0, 100), message: 'Endpoint reachable.' }
      : { ok: false, status: probe.status, error: (await probe.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// --- Built-in demo core -----------------------------------------------------
// Deterministic, honest assistant so every UI path works before API keys exist.

function demoChat(messages, system) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const lower = last.toLowerCase();
  let text;

  if (/^(hi|hello|hey|yo|sup)\b/.test(lower)) {
    text = 'Hello! I am **ANTICODEX Demo Core** — the offline engine that keeps this workspace fully functional before you connect API keys.\n\nHead to **Settings → Providers** to plug in NVIDIA NIM or any OpenAI-/Anthropic-compatible endpoint and I will hand the conversation over to your live models.';
  } else if (lower.includes('what can you do') || lower.includes('features')) {
    text = `ANTICODEX workspace capabilities:

- **Chat** — multi-model conversations, vision attachments, web search (Tavily/Exa), thread history
- **Codex** — code agent workspace with file tree, diff proposals, sandbox terminal, approval modes
- **Claude-style agent** — plans, project memory (\`ANTICODEX.md\`), skills, tool-use log
- **Images** — Cloudflare Workers AI Flux (schnell/dev)
- **Video** — MiniMax Hailuo (H3) generation
- **MCP connectors** — GitHub, Drive, Slack, Notion, Postgres, Playwright… with OAuth-style connect pages
- **Computer-use** — desktop pairing, screen vision, mouse/keyboard control
- **Admin** — users, global keys, feature flags, releases`;
  } else if (lower.includes('code') || lower.includes('function') || lower.includes('javascript') || lower.includes('python')) {
    text = 'Here is a starter example:\n\n```javascript\n// Fibonacci with memoization\nconst memo = new Map();\nfunction fib(n) {\n  if (n < 2) return n;\n  if (memo.has(n)) return memo.get(n);\n  const value = fib(n - 1) + fib(n - 2);\n  memo.set(n, value);\n  return value;\n}\nconsole.log(fib(50));\n```\n\nConnect a live model in **Settings → Providers** (NVIDIA NIM is the default engine) for full generative coding.';
  } else if (lower.includes('mcp')) {
    text = 'The **MCP Connectors** page lets you connect external tool servers exactly like ChatGPT connectors: pick a server from the catalog (or add a custom stdio/HTTP endpoint), sign in on the authorization page, edit the granted permissions, then call its tools from chat, Codex, or the Claude-style agent.';
  } else if (last.trim()) {
    text = `I received your message in **demo mode**:\n\n> ${last.slice(0, 400)}\n\nThe full model routing stack is already wired: **NVIDIA NIM** (primary), custom OpenAI-/Anthropic-compatible endpoints, vision, web search, Flux images, and MiniMax video. Add keys in **Settings** (or the **Admin** panel for global keys) and this exact conversation will be answered by the live model you choose in the model picker.`;
  } else {
    text = 'Send me a message to begin.';
  }

  return {
    text,
    model: DEMO_ID,
    provider: 'demo',
    usage: { prompt_tokens: 0, completion_tokens: text.length / 4 | 0 }
  };
}
