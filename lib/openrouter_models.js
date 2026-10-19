// Full OpenRouter static fallback catalog — transcribed 2026-10-18 (471 ids).
// When OPENROUTER_API_KEY is set the live /api/v1/models list supersedes this.

export const OPENROUTER_EXTRA_MODELS = [
  // openai (104)
  'openai/gpt-3.5-turbo', 'openai/gpt-3.5-turbo-0613', 'openai/gpt-3.5-turbo-16k', 'openai/gpt-3.5-turbo-instruct',
  'openai/gpt-3.5-turbo:batch', 'openai/gpt-4', 'openai/gpt-4-turbo', 'openai/gpt-4-turbo:batch',
  'openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/gpt-4.1-mini:batch', 'openai/gpt-4.1-nano', 'openai/gpt-4.1-nano:batch',
  'openai/gpt-4.1:batch', 'openai/gpt-4o', 'openai/gpt-4o-2024-05-13', 'openai/gpt-4o-2024-08-06', 'openai/gpt-4o-2024-11-20',
  'openai/gpt-4o-mini', 'openai/gpt-4o-mini-2024-07-18', 'openai/gpt-4o-mini:batch', 'openai/gpt-4o:batch',
  'openai/gpt-5', 'openai/gpt-5-image', 'openai/gpt-5-image-mini', 'openai/gpt-5-mini', 'openai/gpt-5-mini:batch',
  'openai/gpt-5-nano', 'openai/gpt-5-nano:batch', 'openai/gpt-5-pro', 'openai/gpt-5-pro:batch', 'openai/gpt-5:batch',
  'openai/gpt-5.1', 'openai/gpt-5.1-codex', 'openai/gpt-5.1-codex-max', 'openai/gpt-5.1-codex-mini', 'openai/gpt-5.1:batch',
  'openai/gpt-5.2', 'openai/gpt-5.2-chat', 'openai/gpt-5.2-codex', 'openai/gpt-5.2-pro', 'openai/gpt-5.2-pro:batch', 'openai/gpt-5.2:batch',
  'openai/gpt-5.3-codex', 'openai/gpt-5.4', 'openai/gpt-5.4-image-2', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-mini:batch',
  'openai/gpt-5.4-nano', 'openai/gpt-5.4-nano:batch', 'openai/gpt-5.4-pro', 'openai/gpt-5.4-pro:batch', 'openai/gpt-5.4:batch',
  'openai/gpt-5.5', 'openai/gpt-5.5-pro', 'openai/gpt-5.5-pro:batch', 'openai/gpt-5.5:batch',
  'openai/gpt-5.6-luna', 'openai/gpt-5.6-luna-pro', 'openai/gpt-5.6-luna-pro:batch', 'openai/gpt-5.6-luna:batch',
  'openai/gpt-5.6-sol', 'openai/gpt-5.6-sol-pro', 'openai/gpt-5.6-sol-pro:batch', 'openai/gpt-5.6-sol:batch',
  'openai/gpt-5.6-terra', 'openai/gpt-5.6-terra-pro', 'openai/gpt-5.6-terra-pro:batch', 'openai/gpt-5.6-terra:batch',
  'openai/gpt-6-astra', 'openai/gpt-6-astra-pro', 'openai/gpt-6-astra-pro:batch', 'openai/gpt-6-astra:batch',
  'openai/gpt-6-luna', 'openai/gpt-6-luna-pro', 'openai/gpt-6-luna-pro:batch', 'openai/gpt-6-luna:batch',
  'openai/gpt-6-sol', 'openai/gpt-6-sol-pro', 'openai/gpt-6-sol-pro:batch', 'openai/gpt-6-sol:batch',
  'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro', 'openai/gpt-6.1-sol-pro:batch', 'openai/gpt-6.1-sol:batch',
  'openai/gpt-audio', 'openai/gpt-audio-mini', 'openai/gpt-chat-latest',
  'openai/gpt-oss-120b', 'openai/gpt-oss-120b:batch', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b:batch', 'openai/gpt-oss-safeguard-20b',
  'openai/o1', 'openai/o1-pro', 'openai/o3', 'openai/o3-mini', 'openai/o3-mini-high', 'openai/o3-mini:batch',
  'openai/o3-pro', 'openai/o3:batch', 'openai/o4-mini', 'openai/o4-mini-high', 'openai/o4-mini:batch',
  // google (44)
  'google/gemini-2.5-flash', 'google/gemini-2.5-flash-image', 'google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite:batch',
  'google/gemini-2.5-flash:batch', 'google/gemini-2.5-pro', 'google/gemini-2.5-pro-preview', 'google/gemini-2.5-pro:batch',
  'google/gemini-3-flash-preview', 'google/gemini-3-flash-preview:batch',
  'google/gemini-3-pro-image', 'google/gemini-3-pro-image-preview',
  'google/gemini-3.1-flash-image', 'google/gemini-3.1-flash-image-preview',
  'google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite:batch',
  'google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview-customtools', 'google/gemini-3.1-pro-preview:batch',
  'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite', 'google/gemini-3.5-flash-lite:batch', 'google/gemini-3.5-flash:batch',
  'google/gemini-3.6-flash', 'google/gemini-3.6-flash:batch', 'google/gemini-3.7-flash', 'google/gemini-3.7-flash:batch',
  'google/gemini-3.8-flash', 'google/gemini-3.8-flash:batch', 'google/gemini-4-argon', 'google/gemini-4-argon:batch',
  'google/gemini-nano-banana-2.1', 'google/gemma-2-27b-it',
  'google/gemma-3-12b-it', 'google/gemma-3-27b-it', 'google/gemma-3-4b-it',
  'google/gemma-4-26b-a4b-it', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it', 'google/gemma-4-31b-it:free',
  'google/lyria-3-clip-preview', 'google/lyria-3-pro-preview',
  // qwen (43)
  'qwen/qwen-2.5-72b-instruct', 'qwen/qwen-2.5-7b-instruct', 'qwen/qwen-2.5-coder-32b-instruct', 'qwen/qwen-plus',
  'qwen/qwen2.5-vl-72b-instruct', 'qwen/qwen3-14b',
  'qwen/qwen3-235b-a22b-2507', 'qwen/qwen3-235b-a22b-thinking-2507',
  'qwen/qwen3-30b-a3b', 'qwen/qwen3-30b-a3b-instruct-2507', 'qwen/qwen3-32b',
  'qwen/qwen3-coder', 'qwen/qwen3-coder-30b-a3b-instruct', 'qwen/qwen3-coder-flash', 'qwen/qwen3-coder-next',
  'qwen/qwen3-next-80b-a3b-instruct', 'qwen/qwen3-next-80b-a3b-thinking',
  'qwen/qwen3-vl-235b-a22b-instruct', 'qwen/qwen3-vl-30b-a3b-instruct', 'qwen/qwen3-vl-30b-a3b-thinking', 'qwen/qwen3-vl-8b-instruct',
  'qwen/qwen3.5-122b-a10b', 'qwen/qwen3.5-27b', 'qwen/qwen3.5-35b-a3b', 'qwen/qwen3.5-397b-a17b', 'qwen/qwen3.5-9b',
  'qwen/qwen3.5-flash-02-23', 'qwen/qwen3.5-plus-02-15', 'qwen/qwen3.5-plus-20260420',
  'qwen/qwen3.6-27b', 'qwen/qwen3.6-35b-a3b', 'qwen/qwen3.6-flash', 'qwen/qwen3.6-plus',
  'qwen/qwen3.7-flash', 'qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-plus:batch',
  'qwen/qwen3.8-2.4t-a95b', 'qwen/qwen3.8-27b', 'qwen/qwen3.8-flash', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-omni-flash',
  // anthropic (30)
  'anthropic/claude-fable-5', 'anthropic/claude-fable-5.1', 'anthropic/claude-fable-5.1:batch', 'anthropic/claude-fable-5:batch',
  'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5:batch', 'anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5:batch',
  'anthropic/claude-opus-4.1', 'anthropic/claude-opus-4.1:batch', 'anthropic/claude-opus-4.5', 'anthropic/claude-opus-4.5:batch',
  'anthropic/claude-opus-4.6', 'anthropic/claude-opus-4.6:batch', 'anthropic/claude-opus-4.7', 'anthropic/claude-opus-4.7:batch',
  'anthropic/claude-opus-4.8', 'anthropic/claude-opus-4.8:batch', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5.5',
  'anthropic/claude-opus-5.5:batch', 'anthropic/claude-opus-5:batch',
  'anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5:batch', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6:batch',
  'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5:batch', 'anthropic/claude-sonnet-5:batch',
  // mistralai (26)
  'mistralai/codestral-2508', 'mistralai/codestral-2508:batch', 'mistralai/devstral-2512',
  'mistralai/ministral-14b-2512', 'mistralai/ministral-3b-2512', 'mistralai/ministral-8b-2512', 'mistralai/ministral-8b-2512:batch',
  'mistralai/mistral-large', 'mistralai/mistral-large-2407', 'mistralai/mistral-large-2512', 'mistralai/mistral-large-2512:batch',
  'mistralai/mistral-large-4-0', 'mistralai/mistral-medium-3', 'mistralai/mistral-medium-3-5', 'mistralai/mistral-medium-3-5:batch',
  'mistralai/mistral-medium-3.1', 'mistralai/mistral-medium-3.1:batch', 'mistralai/mistral-nemo', 'mistralai/mistral-saba',
  'mistralai/mistral-small-24b-instruct-2501', 'mistralai/mistral-small-2603', 'mistralai/mistral-small-2603:batch',
  'mistralai/mistral-small-3.1-24b-instruct', 'mistralai/mistral-small-3.2-24b-instruct',
  'mistralai/mixtral-8x22b-instruct', 'mistralai/voxtral-small-24b-2507',
  // z-ai (18)
  'z-ai/glm-4.5', 'z-ai/glm-4.5-air', 'z-ai/glm-4.5v', 'z-ai/glm-4.6', 'z-ai/glm-4.6v', 'z-ai/glm-4.7', 'z-ai/glm-4.7-flash',
  'z-ai/glm-5', 'z-ai/glm-5-turbo', 'z-ai/glm-5.1', 'z-ai/glm-5.2', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash:batch',
  'z-ai/glm-5.3-flashx', 'z-ai/glm-5.3-prime', 'z-ai/glm-5.3:batch', 'z-ai/glm-5v-turbo',
  // deepseek (16)
  'deepseek/deepseek-chat', 'deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-r1',
  'deepseek/deepseek-r1-0528', 'deepseek/deepseek-v3.1-terminus', 'deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2-exp',
  'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash:batch',
  // nvidia (13)
  'nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-content-safety', 'nvidia/nemotron-3.5-content-safety:free', 'nvidia/nemotron-3.5-lightning',
  'nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3.5-super-vl', 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/switchyard',
  // meta (8)
  'meta/muse-glimmer-30b', 'meta/muse-spark-1.1', 'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3', 'meta/muse-spark-1.3-contributor', 'meta/muse-spark-open', 'meta/muse-wonder',
  // x-ai (8)
  'x-ai/grok-4.20', 'x-ai/grok-4.20-multi-agent', 'x-ai/grok-4.3', 'x-ai/grok-4.3:batch', 'x-ai/grok-4.5', 'x-ai/grok-4.6',
  'x-ai/grok-4.7', 'x-ai/grok-build-0.1',
  // moonshotai (8)
  'moonshotai/kimi-k2', 'moonshotai/kimi-k2-0905', 'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.7-code', 'moonshotai/kimi-k3', 'moonshotai/kimi-k3:batch',
  // minimax (8)
  'minimax/minimax-01', 'minimax/minimax-m1', 'minimax/minimax-m2', 'minimax/minimax-m2-her', 'minimax/minimax-m2.1',
  'minimax/minimax-m2.5', 'minimax/minimax-m2.7', 'minimax/minimax-m3',
  // meta-llama (8)
  'meta-llama/llama-3.1-70b-instruct', 'meta-llama/llama-3.1-8b-instruct', 'meta-llama/llama-3.2-1b-instruct',
  'meta-llama/llama-3.2-3b-instruct', 'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-scout', 'meta-llama/llama-guard-4-12b',
  // tencent (7)
  'tencent/hunyuan-a13b-instruct', 'tencent/hy-mt2-1.8b', 'tencent/hy-mt2-30b-a3b', 'tencent/hy-mt2-7b',
  'tencent/hy3', 'tencent/hy3-preview', 'tencent/hy4-preview',
  // aion-labs (6)
  'aion-labs/aion-2.0', 'aion-labs/aion-3.0', 'aion-labs/aion-3.0-mini', 'aion-labs/aion-3.5', 'aion-labs/aion-3.5-mini',
  'aion-labs/aion-rp-llama-3.1-8b',
  // cohere (6)
  'cohere/command-a', 'cohere/command-a-plus', 'cohere/command-r-08-2024', 'cohere/command-r-plus-08-2024',
  'cohere/command-r7b-12-2024', 'cohere/north-mini-code:free',
  // bytedance-seed (6)
  'bytedance-seed/seed-1.6', 'bytedance-seed/seed-1.6-flash', 'bytedance-seed/seed-2-1-turbo',
  'bytedance-seed/seed-2.0-code', 'bytedance-seed/seed-2.0-lite', 'bytedance-seed/seed-2.0-mini',
  // openrouter (6)
  'openrouter/auto', 'openrouter/auto-beta', 'openrouter/bodybuilder', 'openrouter/free', 'openrouter/fusion', 'openrouter/pareto-code',
  // xiaomi (5)
  'xiaomi/mimo-v2.5', 'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro-ultraspeed',
  // ~openai (5)
  '~openai/gpt-astra-latest', '~openai/gpt-luna-latest', '~openai/gpt-mini-latest', '~openai/gpt-sol-latest', '~openai/gpt-terra-latest',
  // amazon (5)
  'amazon/nova-2-lite-v1', 'amazon/nova-lite-v1', 'amazon/nova-micro-v1', 'amazon/nova-premier-v1', 'amazon/nova-pro-v1',
  // perplexity (5)
  'perplexity/sonar', 'perplexity/sonar-deep-research', 'perplexity/sonar-pro', 'perplexity/sonar-pro-search', 'perplexity/sonar-reasoning-pro',
  // sakana (4)
  'sakana/fugu-max', 'sakana/fugu-ultra', 'sakana/fugu-ultra-v2', 'sakana/sakana-namazu',
  // thinkingmachines (4)
  'thinkingmachines/inkling', 'thinkingmachines/inkling-small', 'thinkingmachines/inkling-small:free', 'thinkingmachines/inkling:free',
  // poolside (4)
  'poolside/laguna-s-2.1', 'poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1', 'poolside/laguna-xs-2.1:free',
  // ~anthropic (4)
  '~anthropic/claude-fable-latest', '~anthropic/claude-haiku-latest', '~anthropic/claude-opus-latest', '~anthropic/claude-sonnet-latest',
  // stepfun (3)
  'stepfun/step-3.5-flash', 'stepfun/step-3.7-flash', 'stepfun/step-5-preview',
  // inclusionai (3)
  'inclusionai/ling-3.0-flash', 'inclusionai/ling-3.0-flash-vl', 'inclusionai/ling-3.1-flash',
  // upstage (3)
  'upstage/solar-mini4', 'upstage/solar-pro-3', 'upstage/solar-pro4',
  // ~deepseek (3)
  '~deepseek/deepseek-flash-latest', '~deepseek/deepseek-pro-latest', '~deepseek/deepseek-v4-flash-latest',
  // thedrummer (3)
  'thedrummer/cydonia-24b-v4.1', 'thedrummer/skyfall-36b-v2', 'thedrummer/unslopnemo-12b',
  // nousresearch (3)
  'nousresearch/hermes-3-llama-3.1-405b', 'nousresearch/hermes-3-llama-3.1-70b', 'nousresearch/hermes-4-405b',
  // sao10k (3)
  'sao10k/l3-lunaris-8b', 'sao10k/l3.1-euryale-70b', 'sao10k/l3.3-euryale-70b',
  // moondream (2)
  'moondream/moondream3-preview', 'moondream/moondream3.1-9b-a2b',
  // unbiased (2)
  'unbiased/pareto-26.10', 'unbiased/pareto-26.9',
  // liquid (2)
  'liquid/lfm-2.5-2.6b:free', 'liquid/lfm-2.5-24b-a2b',
  // scaledown (2)
  'scaledown/extract', 'scaledown/summarize',
  // perceptron (2)
  'perceptron/perceptron-mk1', 'perceptron/perceptron-mk1.5',
  // inference-net (2)
  'inference-net/schematron-v2-small', 'inference-net/schematron-v2-turbo',
  // inception (2)
  'inception/mercury-2', 'inception/mercury-2.5',
  // nex-agi (2)
  'nex-agi/nex-n2.5-mini', 'nex-agi/nex-n2.5-pro',
  // ibm-granite (2)
  'ibm-granite/granite-4.0-h-micro', 'ibm-granite/granite-4.2-8b',
  // ~z-ai (2)
  '~z-ai/glm-flash-latest', '~z-ai/glm-latest',
  // ~google (2)
  '~google/gemini-flash-latest', '~google/gemini-pro-latest',
  // rekaai (2)
  'rekaai/reka-edge', 'rekaai/reka-flash-3',
  // relace (2)
  'relace/relace-apply-3', 'relace/relace-search',
  // morph (2)
  'morph/morph-v3-fast', 'morph/morph-v3-large',
  // microsoft (2)
  'microsoft/phi-4', 'microsoft/wizardlm-2-8x22b',
  // singles (19)
  'elorian/glimpse', 'xingchen-agi/xing4.0-29b-a4b:free', 'reflection/beam-1.0-501b-a23b', '~unbiased/pareto-latest',
  'typesafe/jev-router', 'fireworks/ember-1', 'prism-ml/ternary-bonsai-2-27b', 'dots-studio/dots-3-note-preview:free',
  'meituan/longcat-2.0', '~x-ai/grok-latest', '~moonshotai/kimi-latest', 'arcee-ai/trinity-large-thinking',
  'writer/palmyra-x5', 'bytedance/ui-tars-1.5-7b', 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'anthracite-org/magnum-v4-72b', 'mancer/weaver', 'undi95/remm-slerp-l2-13b', 'gryphe/mythomax-l2-13b'
];
