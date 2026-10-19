// ANTICODEX provider directory — every first-party endpoint + model catalog.
// Models verified 2026-10-18 (DeepSeek V4.1-Flash-1017 + NVIDIA Nemotron 3.5 line
// confirmed against live docs; the rest per the owner's curated catalog).

export const NIM_ENDPOINT = 'https://integrate.api.nvidia.com/v1';

export const PROVIDER_DIRECTORY = [
  {
    id: 'nvidia', name: 'NVIDIA NIM', category: 'Primary engine', protocol: 'openai',
    endpoint: NIM_ENDPOINT, key_env: 'NVIDIA_API_KEY', placeholder: 'nvapi-…', primary: true,
    homepage: 'https://build.nvidia.com/settings/api-keys',
    note: 'Primary ANTICODEX engine. OpenAI- and Anthropic-compatible. Free hosted keys.',
    models: [
      { id: 'nvidia/nemotron-3-nano-30b-a3b', label: 'Nemotron 3 Nano 30B A3B' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni (vision)', vision: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B', reasoning: true },
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning (1M ctx)', reasoning: true },
      { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 Super VL (multimodal)', vision: true, reasoning: true },
      { id: 'nvidia/nemotron-3.5-content-safety', label: 'Nemotron 3.5 Content Safety' },
      { id: 'nvidia/switchyard', label: 'NeMo Switchyard (router)' },
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (hosted on NIM)', vision: true },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1', reasoning: true },
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B' },
      { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B' },
      { id: 'qwen/qwen2.5-vl-7b-instruct', label: 'Qwen2.5-VL 7B (vision)', vision: true },
      { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2' },
      { id: 'mistralai/mistral-large-2-instruct', label: 'Mistral Large 2' },
      { id: 'mistralai/pixtral-12b-2409', label: 'Pixtral 12B (vision)', vision: true },
      { id: 'microsoft/phi-4', label: 'Phi-4' },
      { id: 'ibm/granite-3.3-8b-instruct', label: 'Granite 3.3 8B' }
    ],
    models_note: 'Endpoint serves 100+ NIM models — the full list auto-syncs via /v1/models when your key is set.'
  },
  {
    id: 'openai', name: 'OpenAI', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.openai.com/v1', key_env: 'OPENAI_API_KEY', placeholder: 'sk-…',
    homepage: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoning: true }, { id: 'gpt-6.1-sol-pro', label: 'GPT-6.1 Sol Pro', reasoning: true },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-6-astra-pro', label: 'GPT-6 Astra Pro', reasoning: true },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' }, { id: 'gpt-6-sol-pro', label: 'GPT-6 Sol Pro', reasoning: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6-luna-pro', label: 'GPT-6 Luna Pro', reasoning: true },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.6-sol-pro', label: 'GPT-5.6 Sol Pro', reasoning: true },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-terra-pro', label: 'GPT-5.6 Terra Pro', reasoning: true },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }, { id: 'gpt-5.6-luna-pro', label: 'GPT-5.6 Luna Pro', reasoning: true },
      { id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', reasoning: true },
      { id: 'gpt-5.4', label: 'GPT-5.4' }, { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', reasoning: true },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }, { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
      { id: 'gpt-5.4-image-2', label: 'GPT-5.4 Image 2', vision: true },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.2', label: 'GPT-5.2' }, { id: 'gpt-5.2-pro', label: 'GPT-5.2 Pro', reasoning: true }, { id: 'gpt-5.2-chat', label: 'GPT-5.2 Chat' }, { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { id: 'gpt-5.1', label: 'GPT-5.1' }, { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' }, { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' }, { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
      { id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-5-mini', label: 'GPT-5 Mini' }, { id: 'gpt-5-nano', label: 'GPT-5 Nano' }, { id: 'gpt-5-pro', label: 'GPT-5 Pro', reasoning: true },
      { id: 'gpt-5-image', label: 'GPT-5 Image', vision: true }, { id: 'gpt-5-image-mini', label: 'GPT-5 Image Mini', vision: true },
      { id: 'gpt-4.1', label: 'GPT-4.1' }, { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' }, { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
      { id: 'gpt-4o', label: 'GPT-4o', vision: true }, { id: 'gpt-4o-mini', label: 'GPT-4o Mini', vision: true },
      { id: 'gpt-sol-latest', label: 'GPT Sol Latest (rolling)' }, { id: 'gpt-astra-latest', label: 'GPT Astra Latest (rolling)' },
      { id: 'gpt-terra-latest', label: 'GPT Terra Latest (rolling)' }, { id: 'gpt-luna-latest', label: 'GPT Luna Latest (rolling)' }, { id: 'gpt-mini-latest', label: 'GPT Mini Latest (rolling)' },
      { id: 'gpt-oss-120b', label: 'gpt-oss 120B (open)' }, { id: 'gpt-oss-20b', label: 'gpt-oss 20B (open)' },
      { id: 'gpt-audio', label: 'GPT Audio' }, { id: 'gpt-audio-mini', label: 'GPT Audio Mini' },
      { id: 'o3', label: 'o3', reasoning: true }, { id: 'o3-pro', label: 'o3 Pro', reasoning: true }, { id: 'o4-mini', label: 'o4 Mini', reasoning: true },
      { id: 'o1', label: 'o1 (legacy)', reasoning: true }, { id: 'o1-pro', label: 'o1 Pro (legacy)', reasoning: true },
      { id: 'o3-mini', label: 'o3 Mini (legacy)', reasoning: true },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (legacy)' }, { id: 'gpt-4', label: 'GPT-4 (legacy)' }, { id: 'gpt-4-turbo', label: 'GPT-4 Turbo (legacy)' }
    ]
  },
  {
    id: 'anthropic', name: 'Anthropic', category: 'Frontier', protocol: 'anthropic',
    endpoint: 'https://api.anthropic.com', key_env: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…',
    homepage: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-fable-5.1', label: 'Claude Fable 5.1', reasoning: true }, { id: 'claude-fable-5', label: 'Claude Fable 5', reasoning: true },
      { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', reasoning: true }, { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', reasoning: true }, { id: 'claude-haiku-5.5', label: 'Claude Haiku 5.5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', reasoning: true },
      { id: 'claude-opus-4.8', label: 'Claude Opus 4.8' }, { id: 'claude-opus-4.7', label: 'Claude Opus 4.7' }, { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' }, { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4.5', label: 'Claude Opus 4.5 (legacy)' }, { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (legacy)' },
      { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5 (dated 20251101)' }, { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5 (dated 20250929)' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (dated 20251001)' },
      { id: 'claude-mythos-5', label: 'Claude Mythos 5 (limited)' }
    ]
  },
  {
    id: 'google', name: 'Google Gemini', category: 'Frontier', protocol: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', key_env: 'GEMINI_API_KEY', placeholder: 'AIza…',
    homepage: 'https://aistudio.google.com/apikey',
    note: 'Uses the OpenAI-compatible Gemini endpoint for one unified wire protocol.',
    models: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon (flagship)', vision: true, reasoning: true },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', vision: true }, { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live', vision: true },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', vision: true }, { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', vision: true },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', vision: true }, { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', vision: true },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', vision: true, reasoning: true },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', vision: true },
      { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', vision: true },
      { id: 'gemini-3-pro-image', label: 'Nano Banana Pro (image)', vision: true },
      { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (image)', vision: true },
      { id: 'gemma-4-31b-it', label: 'Gemma 4 31B' }, { id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B' },
      { id: 'gemini-pro-latest', label: 'Gemini Pro Latest (rolling)', vision: true }, { id: 'gemini-flash-latest', label: 'Gemini Flash Latest (rolling)', vision: true }
    ]
  },
  {
    id: 'xai', name: 'xAI (Grok)', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.x.ai/v1', key_env: 'XAI_API_KEY', placeholder: 'xai-…',
    homepage: 'https://console.x.ai',
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7 (500K ctx)', reasoning: true },
      { id: 'grok-4.6', label: 'Grok 4.6' }, { id: 'grok-4.5', label: 'Grok 4.5' },
      { id: 'grok-4.3', label: 'Grok 4.3 (1M ctx)' },
      { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning', reasoning: true }, { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20' },
      { id: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-Agent' },
      { id: 'grok-build-0.1', label: 'Grok Build 0.1 (coding)' },
      { id: 'latest', label: 'Grok Latest (rolling)' }
    ]
  },
  {
    id: 'mistral', name: 'Mistral', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.mistral.ai/v1', key_env: 'MISTRAL_API_KEY', placeholder: '…',
    homepage: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-large-4', label: 'Mistral Large 4 (1M ctx)', reasoning: true }, { id: 'mistral-large-latest', label: 'Mistral Large (latest)' },
      { id: 'mistral-large-2512', label: 'Mistral Large 3 (2512)' },
      { id: 'mistral-medium-latest', label: 'Mistral Medium 3.5 (latest)' }, { id: 'mistral-medium-2604', label: 'Mistral Medium 3.5 (2604)' }, { id: 'mistral-medium-3-1', label: 'Mistral Medium 3.1' },
      { id: 'mistral-small-latest', label: 'Mistral Small 4 (latest)' }, { id: 'mistral-small-2603', label: 'Mistral Small 4 2603' },
      { id: 'devstral-2512', label: 'Devstral 2 (coding)' }, { id: 'devstral-small-2', label: 'Devstral Small 2' },
      { id: 'codestral-2508', label: 'Codestral 2508' }, { id: 'ministral-3', label: 'Ministral 3' },
      { id: 'mistral-embed', label: 'Mistral Embed' },
      { id: 'voxtral-mini', label: 'Voxtral Mini (audio)', vision: true }, { id: 'mistral-saba', label: 'Mistral Saba' }
    ]
  },
  {
    id: 'deepseek', name: 'DeepSeek', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.deepseek.com/v1', key_env: 'DEEPSEEK_API_KEY', placeholder: 'sk-…',
    homepage: 'https://platform.deepseek.com/api_keys',
    note: 'V4.1-Flash-1017 (2026-10-17) is live: API id deepseek-flash, 1M ctx, multimodal, thinking mode. OpenAI + Anthropic + Responses wire formats.',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash 1017 ★', vision: true, reasoning: true },
      { id: 'deepseek-v4.1-flash-1017', label: 'V4.1 Flash 1017 (explicit snapshot)', vision: true, reasoning: true },
      { id: 'deepseek-v4.1-flash', label: 'V4.1 Flash (rolling)', vision: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro 0813', reasoning: true },
      { id: 'deepseek-chat', label: 'deepseek-chat (legacy alias)' }, { id: 'deepseek-reasoner', label: 'deepseek-reasoner (legacy alias)', reasoning: true },
      { id: 'deepseek-v4-flash-0731', label: 'V4 Flash 0731 (legacy)' }, { id: 'deepseek-v4-flash-vision-exp', label: 'V4 Flash Vision Exp (legacy)', vision: true },
      { id: 'deepseek-v3.2', label: 'DeepSeek V3.2 (legacy)' }, { id: 'deepseek-v3.2-exp', label: 'V3.2 Exp (legacy)' },
      { id: 'deepseek-r1', label: 'DeepSeek R1 (legacy)', reasoning: true }
    ]
  },
  {
    id: 'moonshot', name: 'Moonshot (Kimi)', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.moonshot.ai/v1', key_env: 'MOONSHOT_API_KEY', placeholder: 'sk-…',
    homepage: 'https://platform.moonshot.ai/console/api-keys',
    note: 'Anthropic-compatible mirror at https://api.moonshot.ai/anthropic (alias kimi-k3[1m]).',
    models: [
      { id: 'kimi-k3', label: 'Kimi K3 (2.8T MoE, 1M ctx)', vision: true, reasoning: true },
      { id: 'kimi-k3[1m]', label: 'Kimi K3 [1M] (anthropic alias)', vision: true },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }, { id: 'kimi-k2.6', label: 'Kimi K2.6' }, { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', reasoning: true }
    ]
  },
  {
    id: 'zai', name: 'Z.ai (Zhipu GLM)', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.z.ai/api/paas/v4', key_env: 'ZAI_API_KEY', placeholder: '…',
    homepage: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    models: [
      { id: 'glm-5.3', label: 'GLM 5.3', reasoning: true }, { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' }, { id: 'glm-5.3-flashx', label: 'GLM 5.3 FlashX' },
      { id: 'glm-5.3-prime', label: 'GLM 5.3 Prime', reasoning: true }, { id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'glm-5.1', label: 'GLM 5.1' },
      { id: 'glm-5', label: 'GLM 5' }, { id: 'glm-5-turbo', label: 'GLM 5 Turbo' },
      { id: 'glm-4.7', label: 'GLM 4.7' }, { id: 'glm-4.7-flash', label: 'GLM 4.7 Flash' }, { id: 'glm-4.6', label: 'GLM 4.6' },
      { id: 'glm-4.5', label: 'GLM 4.5' }, { id: 'glm-4.5-air', label: 'GLM 4.5 Air' }, { id: 'glm-4.5v', label: 'GLM 4.5V (vision)', vision: true }, { id: 'glm-4.6v', label: 'GLM 4.6V (vision)', vision: true },
      { id: 'glm-5v-turbo', label: 'GLM 5V Turbo (vision)', vision: true }, { id: 'glm-latest', label: 'GLM Latest (rolling)' }
    ]
  },
  {
    id: 'qwen', name: 'Alibaba Qwen', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key_env: 'DASHSCOPE_API_KEY', placeholder: 'sk-…',
    homepage: 'https://bailian.console.aliyun.com/?apiKey=1',
    note: 'China endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max-0902', label: 'Qwen3.8 Max 0902', reasoning: true }, { id: 'qwen3.8-max-prime', label: 'Qwen3.8 Max Prime', reasoning: true },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' }, { id: 'qwen3.8-omni-flash', label: 'Qwen3.8 Omni Flash', vision: true },
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max' }, { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' }, { id: 'qwen3.7-flash', label: 'Qwen3.7 Flash' },
      { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus' }, { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash' }, { id: 'qwen-plus', label: 'Qwen Plus' },
      { id: 'qwen3-coder', label: 'Qwen3 Coder' }, { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next' }, { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash' }
    ]
  },
  {
    id: 'doubao', name: 'ByteDance (Doubao/Seed)', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3', key_env: 'ARK_API_KEY', placeholder: '…',
    homepage: 'https://console.volcengine.com/ark',
    note: 'Volcano Ark — reference your console endpoint id as the model. International: BytePlus.',
    models: [
      { id: 'doubao-seed-2.0-pro', label: 'Doubao Seed 2.0 Pro' }, { id: 'doubao-seed-2.0-lite', label: 'Doubao Seed 2.0 Lite' },
      { id: 'doubao-seed-2.0-mini', label: 'Doubao Seed 2.0 Mini' }, { id: 'seed-2.0-code', label: 'Seed 2.0 Code' }, { id: 'seed-2.1-turbo', label: 'Seed 2.1 Turbo (Dola)' }
    ]
  },
  {
    id: 'minimax', name: 'MiniMax', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.minimaxi.com/v1', key_env: 'MINIMAX_CHAT_API_KEY', placeholder: '…',
    homepage: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    note: 'Chat models (video uses the Hailuo key in Media settings).',
    models: [
      { id: 'minimax-m3', label: 'MiniMax M3', reasoning: true }, { id: 'minimax-m2.7', label: 'MiniMax M2.7' },
      { id: 'minimax-m2.5', label: 'MiniMax M2.5' }, { id: 'minimax-m2.1', label: 'MiniMax M2.1' },
      { id: 'minimax-m2', label: 'MiniMax M2' }, { id: 'minimax-m2-her', label: 'MiniMax M2-her' }, { id: 'minimax-m1', label: 'MiniMax M1' }
    ]
  },
  {
    id: 'hunyuan', name: 'Tencent Hunyuan', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1', key_env: 'HUNYUAN_API_KEY', placeholder: '…',
    homepage: 'https://console.cloud.tencent.com/hunyuan/api-key',
    models: [
      { id: 'hy4-preview', label: 'Hunyuan Hy4 Preview', reasoning: true }, { id: 'hy3', label: 'Hunyuan Hy3' }, { id: 'hy3-preview', label: 'Hunyuan Hy3 Preview' },
      { id: 'hy-mt2-7b', label: 'Hy-MT2 7B (translation)' }, { id: 'hy-mt2-30b-a3b', label: 'Hy-MT2 30B (translation)' }, { id: 'hy-mt2-1.8b', label: 'Hy-MT2 1.8B (translation)' },
      { id: 'hunyuan-a13b-instruct', label: 'Hunyuan A13B (open)' }
    ]
  },
  {
    id: 'meta', name: 'Meta (Model API)', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.meta.ai', key_env: 'META_API_KEY', placeholder: '…',
    homepage: 'https://api.meta.ai',
    note: 'Hosted Muse family (closed weights). Open Llama weights self-host or use Groq/Together/Fireworks.',
    models: [
      { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', vision: true }, { id: 'muse-spark-1.2', label: 'Muse Spark 1.2' },
      { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor' }, { id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor' },
      { id: 'muse-spark-1.1', label: 'Muse Spark 1.1' }, { id: 'muse-glimmer-30b', label: 'Muse Glimmer 30B', vision: true },
      { id: 'muse-wonder', label: 'Muse Wonder' }, { id: 'muse-spark-open', label: 'Muse Spark Open' }
    ]
  },
  {
    id: 'openrouter', name: 'OpenRouter', category: 'Aggregator', protocol: 'openai',
    endpoint: 'https://openrouter.ai/api/v1', key_env: 'OPENROUTER_API_KEY', placeholder: 'sk-or-…',
    homepage: 'https://openrouter.ai/settings/keys',
    note: 'One key → the whole 470+ model catalog (prefix each id with its vendor). The list auto-syncs live via /api/v1/models.',
    models: [], models_dynamic: true
  },
  {
    id: 'groq', name: 'Groq', category: 'Fast inference', protocol: 'openai',
    endpoint: 'https://api.groq.com/openai/v1', key_env: 'GROQ_API_KEY', placeholder: 'gsk_…',
    homepage: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-4-maverick', label: 'Llama 4 Maverick' }, { id: 'llama-4-scout', label: 'Llama 4 Scout' },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B' }, { id: 'mistral-saba', label: 'Mistral Saba' }, { id: 'gemma2-9b-it', label: 'Gemma 2 9B' }
    ]
  },
  {
    id: 'together', name: 'Together AI', category: 'Fast inference', protocol: 'openai',
    endpoint: 'https://api.together.xyz/v1', key_env: 'TOGETHER_API_KEY', placeholder: '…',
    homepage: 'https://api.together.ai/settings/api-keys',
    models: [
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick 17B' },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' }, { id: 'Qwen/Qwen3-235B-A22B-fp8', label: 'Qwen3 235B' }
    ]
  },
  {
    id: 'fireworks', name: 'Fireworks', category: 'Fast inference', protocol: 'openai',
    endpoint: 'https://api.fireworks.ai/inference/v1', key_env: 'FIREWORKS_API_KEY', placeholder: 'fw_…',
    homepage: 'https://fireworks.ai/account/api-keys',
    models: [
      { id: 'accounts/fireworks/models/deepseek-v3p2', label: 'DeepSeek V3.2' }, { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b', label: 'Qwen3 235B' }
    ]
  },
  {
    id: 'cerebras', name: 'Cerebras', category: 'Fast inference', protocol: 'openai',
    endpoint: 'https://api.cerebras.ai/v1', key_env: 'CEREBRAS_API_KEY', placeholder: 'csk-…',
    homepage: 'https://cloud.cerebras.ai/',
    models: [
      { id: 'llama-4-maverick', label: 'Llama 4 Maverick' }, { id: 'qwen-3-32b', label: 'Qwen 3 32B' }, { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B', reasoning: true }
    ]
  },
  {
    id: 'cohere', name: 'Cohere', category: 'Enterprise', protocol: 'cohere',
    endpoint: 'https://api.cohere.com/v2', key_env: 'COHERE_API_KEY', placeholder: '…',
    homepage: 'https://dashboard.cohere.com/api-keys',
    models: [
      { id: 'command-a', label: 'Command A' }, { id: 'command-a-plus', label: 'Command A+' },
      { id: 'command-r-plus-08-2024', label: 'Command R+ (legacy)' }, { id: 'command-r-08-2024', label: 'Command R (legacy)' },
      { id: 'command-r7b-12-2024', label: 'Command R7B (legacy)' }
    ]
  },
  {
    id: 'perplexity', name: 'Perplexity', category: 'Search-native', protocol: 'openai',
    endpoint: 'https://api.perplexity.ai', key_env: 'PERPLEXITY_API_KEY', placeholder: 'pplx-…',
    homepage: 'https://www.perplexity.ai/settings/api',
    models: [
      { id: 'sonar', label: 'Sonar' }, { id: 'sonar-pro', label: 'Sonar Pro' }, { id: 'sonar-pro-search', label: 'Sonar Pro Search' },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', reasoning: true }, { id: 'sonar-deep-research', label: 'Sonar Deep Research', reasoning: true }
    ]
  },
  {
    id: 'thinkingmachines', name: 'Thinking Machines', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.thinkingmachines.ai', key_env: 'THINKING_MACHINES_API_KEY', placeholder: '…',
    homepage: 'https://api.thinkingmachines.ai',
    models: [
      { id: 'inkling', label: 'Inkling', reasoning: true }, { id: 'inkling-small', label: 'Inkling Small' }
    ]
  },
  {
    id: 'atria', name: 'Atria ASI', category: 'Frontier', protocol: 'openai',
    endpoint: 'https://api.atria-asi.ai/v1', key_env: 'ATRIA_API_KEY', placeholder: 'atr_…',
    homepage: 'https://atria-asi.ai',
    note: 'Atria Dawn (2026-10-16). OpenAI Chat + Anthropic Messages + OpenAI Responses wire protocols. China: https://discovery-api.intern-ai.org.cn/v1',
    models: [
      { id: 'Atria-Dawn', label: 'Atria Dawn (512K, agentic)', reasoning: true },
      { id: 'Atria-Dawn-Preview', label: 'Atria Dawn Preview (256K, MIT weights)', reasoning: true }
    ]
  },
  {
    id: 'azure', name: 'Azure OpenAI', category: 'Enterprise', protocol: 'openai',
    endpoint: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}', key_env: 'AZURE_OPENAI_API_KEY', placeholder: '…',
    homepage: 'https://portal.azure.com',
    note: 'Enter your resource + deployment names in the endpoint field; uses api-key header.',
    models: [
      { id: 'gpt-6', label: 'GPT-6 (deployment)' }, { id: 'gpt-5.4', label: 'GPT-5.4 (deployment)' }, { id: 'o4-mini', label: 'o4-mini (deployment)', reasoning: true }
    ]
  },
  {
    id: 'vertex', name: 'Google Vertex AI', category: 'Enterprise', protocol: 'vertex',
    endpoint: 'https://{region}-aiplatform.googleapis.com/v1', key_env: 'GOOGLE_APPLICATION_CREDENTIALS', placeholder: 'ADC / service account',
    homepage: 'https://console.cloud.google.com/vertex-ai',
    note: 'Vertex Gemini + Claude-on-GCP. For simple key auth use Gemini (AI Studio) or OpenRouter.',
    models: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', vision: true }, { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (GCP)' }
    ]
  },
  {
    id: 'bedrock', name: 'Amazon Bedrock (Nova)', category: 'Enterprise', protocol: 'bedrock',
    endpoint: 'https://bedrock-runtime.{region}.amazonaws.com', key_env: 'AWS_ACCESS_KEY_ID', placeholder: 'AWS credentials',
    homepage: 'https://console.aws.amazon.com/bedrock',
    note: 'AWS SigV4 auth. Nova family; for simple keys route via OpenRouter.',
    models: [
      { id: 'amazon.nova-premier-v1:0', label: 'Nova Premier' }, { id: 'amazon.nova-pro-v1:0', label: 'Nova Pro' },
      { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite' }, { id: 'amazon.nova-micro-v1:0', label: 'Nova Micro' },
      { id: 'amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite (per-region)' }
    ]
  }
];

// Full OpenRouter static fallback (471 ids) lives in openrouter_models.js —
// the live list auto-syncs via /models whenever an OpenRouter key is configured.
export { OPENROUTER_EXTRA_MODELS } from './openrouter_models.js';

export function allKeyEnvs() {
  return [...new Set(PROVIDER_DIRECTORY.map((p) => p.key_env).concat([
    'TAVILY_API_KEY', 'EXA_API_KEY', 'CF_ACCOUNT_ID', 'CF_API_TOKEN',
    'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'AUTH_REDIRECT',
    'ELEVENLABS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'OPENWEATHER_API_KEY', 'WINDY_API_KEY',
    'YOUTUBE_API_KEY', 'YOUTUBE_CACHE_SECONDS', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
    'TRUST_PROXY', 'CF_R2_ACCESS_KEY_ID', 'CF_R2_SECRET_ACCESS_KEY', 'CF_R2_ENDPOINT', 'SITE_URL'
  ]))];
}

export function findProviderDef(id) {
  return PROVIDER_DIRECTORY.find((p) => p.id === id);
}
