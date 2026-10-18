// ANTICODEX — key & runtime configuration.
// Resolution order per key: (1) process.env, (2) admin-managed runtime config (data/db.json or Supabase),
// (3) hardcoded fallback slots below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTICODEX_DATA || path.resolve(__dirname, '../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ---------------------------------------------------------------------------
// HARDCODED KEY SLOTS
// The owner designated Tavily + Exa keys as freely usable, non-expiring keys to
// ship inside the product. Paste the literal key strings here (or set the env
// vars / admin panel). They are read at boot and take effect immediately.
// ---------------------------------------------------------------------------
export const HARDCODED = {
  TAVILY_API_KEY: '',   // <-- paste tvly-... key here
  EXA_API_KEY: '',      // <-- paste exa-... key here
  NVIDIA_API_KEY: '',   // optional nvapi-...
  CF_ACCOUNT_ID: '',    // Cloudflare account for Workers AI (Flux)
  CF_API_TOKEN: '',     // Cloudflare API token with Workers AI:run
  MINIMAX_API_KEY: '',  // MiniMax (Hailuo video)
  MINIMAX_GROUP_ID: '',
  ADMIN_USERNAME: 'Thaddeusadmin',
  ADMIN_PASSWORD: 'Thaddeusk12'
};

let runtimeConfig = null;
function loadRuntime() {
  if (runtimeConfig) return runtimeConfig;
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    runtimeConfig = {};
  }
  return runtimeConfig;
}

export function saveRuntime(patch) {
  const cur = loadRuntime();
  runtimeConfig = { ...cur, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(runtimeConfig, null, 2));
  return runtimeConfig;
}

export function getKey(name) {
  return process.env[name] || loadRuntime()[name] || HARDCODED[name] || '';
}

export const DATA_PATH = DATA_DIR;

export const VERSION = '0.1.0';

export const CATALOG = {
  nvidia_endpoint: 'https://integrate.api.nvidia.com/v1',
  nvidia_models: [
    { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (reasoning)', vision: false },
    { id: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek V3.1', vision: false },
    { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', vision: false },
    { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', vision: false },
    { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B', vision: false },
    { id: 'qwen/qwen2.5-vl-7b-instruct', label: 'Qwen2.5-VL 7B (vision)', vision: true },
    { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2', vision: false },
    { id: 'mistralai/mistral-large-2-instruct', label: 'Mistral Large 2', vision: false },
    { id: 'mistralai/pixtral-12b-2409', label: 'Pixtral 12B (vision)', vision: true },
    { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B', vision: false },
    { id: 'nvidia/nemotron-nano-9b-v2', label: 'Nemotron Nano 9B', vision: false },
    { id: 'microsoft/phi-4', label: 'Phi-4', vision: false },
    { id: 'ibm/granite-3.3-8b-instruct', label: 'Granite 3.3 8B', vision: false },
    { id: 'nvidia/vila', label: 'NVIDIA VILA (vision)', vision: true }
  ],
  search: { tavily: 'https://api.tavily.com/search', exa: 'https://api.exa.ai/search' },
  flux: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-schnell',
  flux_pro: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-dev',
  minimax: {
    video: 'https://api.minimax.io/v1/video_generation',
    query: 'https://api.minimax.io/v1/query/video_generation',
    models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'minimax-h3']
  }
};
