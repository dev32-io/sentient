import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "ollama"]);

// Ollama exposes its cloud library at https://ollama.com/api/tags. The
// payload shape mirrors the local daemon's /api/tags but the names are the
// cloud catalog instead of pulled-locally models. Rate-limit budget is
// generous (we hit it at most once per `openrouter_cache_ttl_ms`, default
// 1h, shared with the OpenRouter cache key) but still worth caching.
//
// Tag-form rule (verified against https://docs.ollama.com/cloud and the
// daemon's own behavior): a name without `:` becomes `<name>:cloud`; a
// name with a size variant `<name>:<size>` becomes `<name>:<size>-cloud`.
//
// We don't get capability flags (tools/vision/thinking) from /api/tags —
// those live on each model's detail page. Rather than scrape 39 detail
// pages on every catalog refresh, we ship a small `KNOWN_FAMILIES` table
// keyed on the family slug (the part before any `:`). Unknown models
// default to `supportsTools=true, supportsVision=false` — most cloud
// variants are agentic-tier and tool-capable; vision is the exception.

export type OllamaFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

export interface OllamaFetcherConfig {
  /** Origin-only base, default https://ollama.com — the daemon-side
   *  base_url (which would be /v1 for OpenAI-compat completions) is a
   *  different concern. */
  baseUrl: string;
  timeoutMs: number;
}

const responseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      modified_at: z.string().optional(),
      size: z.number().int().nonnegative().optional().default(0),
      details: z
        .object({
          parameter_size: z.string().optional().default(""),
          family: z.string().optional().default(""),
        })
        .optional(),
    }),
  ),
});

type RawModel = z.infer<typeof responseSchema>["models"][number];

// Capability hints per family slug. Pulled by hand from each model's
// detail page on ollama.com — keep in alphabetical order. Unknown
// families fall through to the default at mapToModelEntry.
const KNOWN_FAMILIES: Record<string, { tools: boolean; vision: boolean; description: string }> = {
  cogito: {
    tools: true,
    vision: false,
    description: "Cogito 2.1 — instruction-tuned MIT-licensed model with strong multilingual + reasoning.",
  },
  "deepseek-v3.1": { tools: true, vision: false, description: "DeepSeek V3.1 — hybrid reasoning, large MoE." },
  "deepseek-v3.2": { tools: true, vision: false, description: "DeepSeek V3.2 — efficient sparse-attention reasoning." },
  "deepseek-v4-flash": {
    tools: true,
    vision: false,
    description: "DeepSeek V4 Flash — 284B MoE / 13B active, configurable thinking.",
  },
  "deepseek-v4-pro": {
    tools: true,
    vision: false,
    description: "DeepSeek V4 Pro — 1.6T MoE / 49B active, frontier reasoning, three thinking modes.",
  },
  "devstral-2": { tools: true, vision: false, description: "Devstral 2 — 123B agentic coding model." },
  "devstral-small-2": { tools: true, vision: true, description: "Devstral Small 2 — 24B agentic coding + vision." },
  gemini: { tools: true, vision: true, description: "Gemini 3 Flash Preview — fast multimodal frontier model." },
  gemma3: { tools: false, vision: true, description: "Gemma 3 — Google open-weight multimodal." },
  gemma4: { tools: true, vision: true, description: "Gemma 4 — flagship multimodal with configurable thinking." },
  "glm-4.6": { tools: true, vision: false, description: "GLM-4.6 — Z.ai coding + agentic model." },
  "glm-4.7": {
    tools: true,
    vision: false,
    description: "GLM-4.7 — coding-focused with agentic thinking-before-acting.",
  },
  "glm-5": { tools: true, vision: false, description: "GLM-5 — 744B MoE / 40B active, extended reasoning." },
  "glm-5.1": {
    tools: true,
    vision: false,
    description: "GLM-5.1 — flagship agentic engineering with deep tool use.",
  },
  "gpt-oss": {
    tools: true,
    vision: false,
    description: "GPT-OSS — OpenAI open-weight, function calling + chain-of-thought.",
  },
  kimi: { tools: true, vision: true, description: "Kimi — Moonshot multimodal agentic model with thinking." },
  "kimi-k2-thinking": {
    tools: true,
    vision: false,
    description: "Kimi K2 Thinking — Moonshot's best open-source reasoning model with extended tool loops.",
  },
  ministral: { tools: true, vision: true, description: "Ministral 3 — small multimodal with native function calling." },
  minimax: {
    tools: true,
    vision: false,
    description: "MiniMax M2 family — agentic coding + productivity.",
  },
  "mistral-large": {
    tools: true,
    vision: true,
    description: "Mistral Large 3 — multimodal MoE for enterprise tasks.",
  },
  "nemotron-3-nano": {
    tools: false,
    vision: false,
    description: "Nemotron 3 Nano — NVIDIA reasoning-capable hybrid MoE.",
  },
  "nemotron-3-super": {
    tools: false,
    vision: false,
    description: "Nemotron 3 Super — 120B / 12B-active MoE for agentic reasoning.",
  },
  "qwen3-coder": {
    tools: true,
    vision: false,
    description: "Qwen3 Coder — coding-focused, agentic workflow integration.",
  },
  "qwen3-coder-next": {
    tools: true,
    vision: false,
    description: "Qwen3 Coder Next — 80B/3B-active for local + agentic dev.",
  },
  "qwen3-next": {
    tools: false,
    vision: false,
    description: "Qwen3 Next — gated DeltaNet for ultra-long context.",
  },
  "qwen3-vl": {
    tools: true,
    vision: true,
    description: "Qwen3-VL — vision-language frontier with 256K-1M context.",
  },
  qwen3: { tools: true, vision: true, description: "Qwen3.5 — multimodal 397B-A17B." },
  rnj: { tools: true, vision: false, description: "RNJ-1 — 8B Essential AI model for code + STEM." },
};

const DEFAULT_CAPS = { tools: true, vision: false } as const;

function familyKey(name: string): string {
  // "kimi-k2.6" → "kimi"; "gpt-oss:20b" → "gpt-oss"; "deepseek-v3.1:671b" → "deepseek-v3.1".
  // Multi-token slugs like "deepseek-v4-flash" should match their full slug, not just the
  // first dash-segment, so we walk longest→shortest prefix against the family table.
  const baseName = name.split(":")[0] ?? name;
  if (KNOWN_FAMILIES[baseName]) return baseName;
  // Fallback: progressively shorter dash-prefixes ("kimi-k2-thinking" → "kimi-k2" → "kimi").
  const parts = baseName.split("-");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("-");
    if (KNOWN_FAMILIES[prefix]) return prefix;
  }
  return baseName;
}

function toCloudTag(name: string): string {
  // Per https://docs.ollama.com/cloud — the daemon translates a tag of the
  // form `<name>:cloud` or `<name>:<size>-cloud` to the ollama.com cloud
  // routing path. Names returned by /api/tags omit the `cloud` suffix.
  if (name.includes(":")) return `${name}-cloud`;
  return `${name}:cloud`;
}

function displayName(name: string): string {
  // "deepseek-v4-flash" → "deepseek-v4-flash"; "gpt-oss:120b" → "gpt-oss (120B)".
  const idx = name.indexOf(":");
  if (idx === -1) return name;
  const family = name.slice(0, idx);
  const size = name.slice(idx + 1).toUpperCase();
  return `${family} (${size})`;
}

function mapToModelEntry(m: RawModel): ModelEntry {
  const family = familyKey(m.name);
  const caps = KNOWN_FAMILIES[family] ?? { ...DEFAULT_CAPS, description: "" };
  return {
    id: toCloudTag(m.name),
    provider: "ollama-cloud",
    name: displayName(m.name),
    description: caps.description,
    contextLength: 0,
    pricingPer1mPrompt: "included",
    pricingPer1mCompletion: "included",
    supportsTools: caps.tools,
    supportsVision: caps.vision,
  };
}

async function performFetch(config: OllamaFetcherConfig): Promise<Result<Response, OllamaFetchError>> {
  // The shared `ollama_cloud_base_url` config defaults to .../v1 (the
  // OpenAI-compat completions path used by the daemon). The catalog
  // endpoint sits at the origin, not /v1 — strip a trailing /v1 so a
  // single config knob covers both.
  const origin = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const url = `${origin}/api/tags`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
    return { ok: true, value: resp };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("fetchOllamaCloudModels.timeout", { afterMs: config.timeoutMs });
      return { ok: false, error: { kind: "timeout", afterMs: config.timeoutMs } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchOllamaCloudModels.fetchFailed", { reason });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
}

export async function fetchOllamaCloudModels(
  config: OllamaFetcherConfig,
): Promise<Result<ModelEntry[], OllamaFetchError>> {
  const start = Date.now();
  log.info("fetchOllamaCloudModels.begin", { baseUrl: config.baseUrl });

  const fetched = await performFetch(config);
  if (!fetched.ok) return fetched;
  const resp = fetched.value;

  if (!resp.ok) {
    log.warn("fetchOllamaCloudModels.nonOk", { status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchOllamaCloudModels.parseFailed", { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("fetchOllamaCloudModels.parseFailed", { reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }

  const models = parsed.data.models.map(mapToModelEntry);
  log.info("fetchOllamaCloudModels.done", { count: models.length, elapsedMs: Date.now() - start });
  return { ok: true, value: models };
}
