import type { ProvidersConfig } from "@sentient/config";
import type { LlmProvider, SecretsStore } from "../admin/secrets-store.js";
import { getLog } from "../logging/logger.js";
import { fetchOllamaCloudModels } from "../providers/catalogs/ollama-fetcher.js";
import { fetchOpenRouterModels } from "../providers/catalogs/openrouter-fetcher.js";
import type { ModelEntry } from "../providers/catalogs/types.js";
import { type TtlCache, createTtlCache } from "../util/ttl-cache.js";
import type { ProvidersListResult } from "./handlers/providers.js";

const log = getLog(["sentient", "gateway", "api", "providers-deps"]);

const CACHE_KEY = "all";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ProvidersDeps {
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  invalidateCatalogCache: (provider: LlmProvider) => void;
}

export interface ProvidersFetchers {
  openrouter?: typeof fetchOpenRouterModels;
  ollama?: typeof fetchOllamaCloudModels;
}

export interface ProvidersDepsContext {
  config: ProvidersConfig;
  env: (name: string) => string | undefined;
  secretsStore?: SecretsStore | undefined;
  modelCache?: TtlCache<ModelEntry[]>;
  fetchers?: ProvidersFetchers;
}

interface ResolvedFetchers {
  openrouter: typeof fetchOpenRouterModels;
  ollama: typeof fetchOllamaCloudModels;
}

export function createProvidersDeps(ctx: ProvidersDepsContext): ProvidersDeps {
  const modelCache = ctx.modelCache ?? createTtlCache<ModelEntry[]>();
  const fetchers = resolveFetchers(ctx.fetchers);

  return {
    listModels: () => listModels(ctx, modelCache, fetchers),
    invalidateCatalogCache(provider) {
      if (provider === "openrouter" || provider === "ollama-cloud" || provider === "custom") modelCache.clear();
    },
  };
}

function resolveFetchers(injected?: ProvidersFetchers): ResolvedFetchers {
  return {
    openrouter: injected?.openrouter ?? fetchOpenRouterModels,
    ollama: injected?.ollama ?? fetchOllamaCloudModels,
  };
}

async function listModels(
  ctx: ProvidersDepsContext,
  cache: TtlCache<ModelEntry[]>,
  fetchers: ResolvedFetchers,
): Promise<ProvidersListResult<ModelEntry[]>> {
  const fresh = cache.get(CACHE_KEY);
  if (fresh !== undefined) {
    log.debug("listModels.cache-hit", { count: fresh.length });
    return { ok: true, value: fresh };
  }

  log.info("listModels.begin");
  const merged = await fetchAndMergeModels(ctx, fetchers);
  if (merged.length > 0) {
    cache.set(CACHE_KEY, merged, ctx.config.openrouter_cache_ttl_ms);
    log.info("listModels.done", { count: merged.length });
    return { ok: true, value: merged };
  }
  return staleOrError(cache, "listModels");
}

async function fetchAndMergeModels(ctx: ProvidersDepsContext, fetchers: ResolvedFetchers): Promise<ModelEntry[]> {
  const orR = await fetchers.openrouter({
    apiKey: () => ctx.secretsStore?.getActiveLlmSync()?.apiKey ?? ctx.env("OPENROUTER_API_KEY") ?? null,
    baseUrl: OPENROUTER_BASE_URL,
    timeoutMs: ctx.config.external_fetch_timeout_ms,
  });

  const ollamaR = await fetchers.ollama({
    baseUrl: ctx.config.ollama_cloud_base_url,
    timeoutMs: ctx.config.external_fetch_timeout_ms,
  });
  return mergeModelResults(orR, ollamaR);
}

function mergeModelResults(
  orR: Awaited<ReturnType<typeof fetchOpenRouterModels>>,
  ollamaR: Awaited<ReturnType<typeof fetchOllamaCloudModels>>,
): ModelEntry[] {
  const orModels = orR.ok ? orR.value : [];
  const ollamaModels = ollamaR.ok ? ollamaR.value : [];
  if (!orR.ok) log.warn("mergeModelResults.openrouter-failed", { kind: orR.error.kind });
  if (!ollamaR.ok) log.warn("mergeModelResults.ollama-failed", { kind: ollamaR.error.kind });
  return [...orModels, ...ollamaModels];
}

function staleOrError<T>(cache: TtlCache<T>, scope: string): ProvidersListResult<T> {
  const stale = cache.getStale(CACHE_KEY);
  if (stale !== undefined) {
    log.warn(`${scope}.stale-fallback`, {});
    return { ok: true, value: stale, stale: true };
  }
  log.warn(`${scope}.upstream-down`, {});
  return { ok: false, error: { kind: "upstream-down" } };
}
