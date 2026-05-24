import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-types.ts";
import { createOpenRouterProvider } from "../providers/openrouter.ts";

const log = getLog(["sentient", "bootstrap", "llm"]);

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/**
 * Build the gateway-side LLM client. Today this is consumed only by the
 * emotion-tagger; Hermes owns chat. Both supported providers (openrouter,
 * ollama-cloud) speak OpenAI-compatible REST, so we reuse the same
 * underlying OpenAI client with provider-specific base_url + api_key.
 */
export function createLlmService(cfg: StartupConfig): LLMProvider | null {
  if (!cfg.llm) {
    log.warn("service-disabled", { reason: "no api key for selected provider" });
    return null;
  }
  const provider = cfg.llm.provider;
  const baseUrl = cfg.llm.base_url?.trim() || defaultBaseUrlFor(provider);
  log.info("service-enabled", { provider, chatModel: cfg.llm.chat_model, baseUrl });
  return createOpenRouterProvider({
    apiKey: cfg.llm.apiKey,
    baseUrl,
    siteName: "Sentient",
  });
}

function defaultBaseUrlFor(provider: "openrouter" | "ollama-cloud"): string {
  if (provider === "ollama-cloud") return DEFAULT_OLLAMA_CLOUD_BASE_URL;
  return DEFAULT_OPENROUTER_BASE_URL;
}
