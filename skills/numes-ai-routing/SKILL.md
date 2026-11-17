---
name: numes-ai-routing
description: Route work through the Numes AI gateway and its pinned model ids. Use when choosing between the uncensored DeepSeek/GLM builds, the standard DeepSeek V4.1 Flash, Kimi K3.1 Pro, or GLM 5.3; when a Numes call fails; or when proving which model actually answered.
---

# Numes AI routing

The gateway is OpenAI-compatible at `https://api.numes.ai/api/v1`. The key is
`NUMES_API_KEY`; never print it, put it in a URL, or paste it into a chat.

## Pinned models

| Model id | Use it for | Watch out for |
|---|---|---|
| `dealignai/deepseek-v4.1-flash-uncensored-fp8` | Drafts where a refusal would hide a legitimate security question | Uncensored is not "more correct". Verify every factual claim. |
| `dealignai/glm-5.3-flash-uncensored-fp8` | Fast alternative drafts, multilingual text | Same verification burden. |
| `deepseek/deepseek-v4.1-flash` | Default coding and analysis | Reasoning tokens can arrive before the answer. |
| `moonshotai/kimi-k3.1-pro` | Long-context reading, large diffs | Long outputs cost more; ask for a bounded result. |
| `z-ai/glm-5.3-flash` | Cheap classification, extraction, summaries | Do not use for a task that needs deep planning. |
| `z-ai/glm-5.3` | Hard reasoning when DeepSeek is unavailable | Slower; stream and show progress. |

## Rules

1. Resolve the model by its full id. Do not invent a Numes id that is not in the
   six above unless `/models` returned it for this key.
2. If the host is unreachable, say exactly that. A TLS reset is not a bad API
   key, and a 401 is not an outage. Report the layer that failed.
3. Prefer a working provider over retrying a dead one. The model picker lists
   what the account can actually call.
4. When you report a result, name the model id and the endpoint that produced
   it. "The AI said so" is not evidence.
5. Uncensored models still follow the system policy. Do not use them to bypass
   safety rules; use them to avoid a spurious refusal on a legitimate task.
