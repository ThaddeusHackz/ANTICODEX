// ANTICODEX — key & runtime configuration.
// Resolution order per key: (1) request/desktop keychain, (2) process.env,
// (3) admin-managed runtime config (data/config.json), (4) hardcoded slots below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTICODEX_DATA || path.resolve(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Configuration defaults. Secret slots deliberately remain empty.
// Supply secrets through protected environment variables or account settings.
// All provider keys can also be entered per-user in Settings → Providers or
// globally in Admin → Keys (stored in data/config.json / Supabase).
// ---------------------------------------------------------------------------
export const HARDCODED = {
  // search
  TAVILY_API_KEY: '',
  EXA_API_KEY: '',
  // media
  CF_ACCOUNT_ID: '',
  CF_API_TOKEN: '',
  CF_R2_ACCESS_KEY_ID: '',
  CF_R2_SECRET_ACCESS_KEY: '',
  CF_R2_ENDPOINT: '',
  MINIMAX_API_KEY: '',
  MINIMAX_GROUP_ID: '',
  // voice / images / data services
  ELEVENLABS_API_KEY: '',
  UNSPLASH_ACCESS_KEY: '',
  OPENWEATHER_API_KEY: '',
  WINDY_API_KEY: '',
  YOUTUBE_API_KEY: '',
  YOUTUBE_CACHE_SECONDS: '10800',
  OPENSKY_CLIENT_ID: '',
  OPENSKY_CLIENT_SECRET: '',
  TRUST_PROXY: '1',
  SITE_URL: 'https://anticodex.vercel.app',
  // providers (see lib/catalog.js for the full directory)
  NVIDIA_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  GEMINI_API_KEY: '',
  XAI_API_KEY: '',
  MISTRAL_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  MOONSHOT_API_KEY: '',
  ZAI_API_KEY: '',
  DASHSCOPE_API_KEY: '',
  ARK_API_KEY: '',
  MINIMAX_CHAT_API_KEY: '',
  HUNYUAN_API_KEY: '',
  META_API_KEY: '',
  OPENROUTER_API_KEY: '',
  GROQ_API_KEY: '',
  TOGETHER_API_KEY: '',
  FIREWORKS_API_KEY: '',
  CEREBRAS_API_KEY: '',
  COHERE_API_KEY: '',
  PERPLEXITY_API_KEY: '',
  THINKING_MACHINES_API_KEY: '',
  ATRIA_API_KEY: '',
  EXPLABS_API_KEY: '',
  AZURE_OPENAI_API_KEY: '',
  // auth
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
  AUTH_REDIRECT: '',
  // Signs the GitHub OAuth `state` so the callback can be verified without a
  // database. Leave empty to derive it from SITE_URL + GITHUB_CLIENT_SECRET.
  AUTH_STATE_SECRET: '',
  // 'true' → sign-up must be finished with the emailed code before sign-in.
  // Default off, so a normal email address can sign in immediately.
  REQUIRE_EMAIL_VERIFICATION: '',
  // 'true' → return one-time codes to the client (dev/desktop where no mailer
  // exists). Auto-enabled whenever no Supabase mailer is configured.
  EXPOSE_RESET_CODES: '',
  // Second admin: an ANTICODEX sign-in for the owner (web + desktop app). The
  // admin CONSOLE keeps ADMIN_USERNAME / ADMIN_PASSWORD below — untouched.
  OWNER_EMAIL: '',
  OWNER_PASSWORD: '',
  OWNER_NAME: 'Thaddeus',
  OWNER_ROLE: 'admin',
  // admin
  ADMIN_USERNAME: 'Thaddeusadmin',
  ADMIN_PASSWORD: ''
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

export const VERSION = '0.1.8';

export const CATALOG = {
  nvidia_endpoint: 'https://integrate.api.nvidia.com/v1',
  search: { tavily: 'https://api.tavily.com/search', exa: 'https://api.exa.ai/search' },
  flux: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-schnell',
  flux_pro: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-dev',
  minimax: {
    video: 'https://api.minimax.io/v1/video_generation',
    query: 'https://api.minimax.io/v1/query/video_generation',
    models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'minimax-h3']
  }
};
