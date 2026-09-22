import { createHash } from "node:crypto";
import type { ProvidersConfig } from "@sentient/config";
import type { LlmProvider, SecretsStore } from "../admin/secrets-store.js";
import { getLog } from "../logging/logger.js";
import { type OllamaModelEntry, fetchOllamaCloudModels } from "../providers/catalogs/ollama-fetcher.js";
import { type OpenRouterModelEntry, fetchOpenRouterModels } from "../providers/catalogs/openrouter-fetcher.js";
import type { ModelEntry } from "../providers/catalogs/types.js";
import { type TtlCache, createTtlCache } from "../util/ttl-cache.js";
import type { ProvidersListResult } from "./handlers/providers.js";

const log = getLog(["sentient", "gateway", "api", "providers-deps"]);
const CACHE_KEY = "models";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type CatalogProvider = Extract<LlmProvider, "openrouter" | "ollama-cloud">;

export interface ProviderModelResolution {
  readonly model: ModelEntry;
  readonly visionCapabilityKnown: boolean;
  readonly toolsCapabilityKnown: boolean;
}

export interface ProvidersDeps {
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  listProviderModels: (provider: CatalogProvider) => Promise<ProvidersListResult<ModelEntry[]>>;
  resolveProviderModel: (
    provider: CatalogProvider,
    id: string,
    connection?: { readonly apiKey: string; readonly baseUrl: string },
  ) => Promise<ProviderModelResolution | null>;
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
  modelCaches?: Partial<Record<CatalogProvider, TtlCache<ModelEntry[]>>>;
  fetchers?: ProvidersFetchers;
}

interface ResolvedFetchers {
  openrouter: typeof fetchOpenRouterModels;
  ollama: typeof fetchOllamaCloudModels;
}

type InternalModelEntry = ModelEntry | OpenRouterModelEntry | OllamaModelEntry;

type ProviderState = {
  cache: TtlCache<InternalModelEntry[]>;
  generation: number;
  inflight: Map<string, Promise<ProvidersListResult<InternalModelEntry[]>>>;
};

export function createProvidersDeps(ctx: ProvidersDepsContext): ProvidersDeps {
  const fetchers = resolveFetchers(ctx.fetchers);
  const states: Record<CatalogProvider, ProviderState> = {
    openrouter: { cache: ctx.modelCaches?.openrouter ?? createTtlCache(), generation: 0, inflight: new Map() },
    "ollama-cloud": {
      cache: ctx.modelCaches?.["ollama-cloud"] ?? createTtlCache(),
      generation: 0,
      inflight: new Map(),
    },
  };

  const listInternal = (provider: CatalogProvider) => listProvider(ctx, fetchers, states, provider);
  const listProviderModels = async (provider: CatalogProvider): Promise<ProvidersListResult<ModelEntry[]>> => {
    const result = await listInternal(provider);
    return result.ok
      ? { ok: true, value: result.value.map(publicModel), ...(result.stale ? { stale: true } : {}) }
      : result;
  };
  return {
    listProviderModels,
    async resolveProviderModel(provider, id, connection) {
      const result = await listProvider(
        ctx,
        fetchers,
        states,
        provider,
        connection ? connectionCacheKey(connection) : CACHE_KEY,
        provider === "openrouter" ? connection?.apiKey : undefined,
        connection?.baseUrl,
      );
      if (!result.ok) return null;
      const model = result.value.find((entry) => entry.id === id);
      if (!model) return null;
      const ollamaKnown = !("capabilitiesKnown" in model) || model.capabilitiesKnown;
      return {
        model: publicModel(model),
        visionCapabilityKnown: "visionCapabilityKnown" in model ? model.visionCapabilityKnown : ollamaKnown,
        toolsCapabilityKnown: "toolsCapabilityKnown" in model ? model.toolsCapabilityKnown : ollamaKnown,
      };
    },
    async listModels() {
      const results = await Promise.all([listProviderModels("openrouter"), listProviderModels("ollama-cloud")]);
      const available = results.filter((result) => result.ok);
      if (available.length === 0) return { ok: false, error: { kind: "upstream-down" } };
      return {
        ok: true,
        value: available.flatMap((result) => result.value),
        ...(available.some((result) => result.stale) ? { stale: true } : {}),
      };
    },
    invalidateCatalogCache(provider) {
      if (provider !== "openrouter" && provider !== "ollama-cloud") return;
      const state = states[provider];
      state.generation++;
      state.cache.clear();
      state.inflight.clear();
    },
  };
}

function resolveFetchers(injected?: ProvidersFetchers): ResolvedFetchers {
  return {
    openrouter: injected?.openrouter ?? fetchOpenRouterModels,
    ollama: injected?.ollama ?? fetchOllamaCloudModels,
  };
}

function listProvider(
  ctx: ProvidersDepsContext,
  fetchers: ResolvedFetchers,
  states: Record<CatalogProvider, ProviderState>,
  provider: CatalogProvider,
  cacheKey = CACHE_KEY,
  apiKey?: string,
  baseUrl?: string,
): Promise<ProvidersListResult<InternalModelEntry[]>> {
  const state = states[provider];
  const fresh = state.cache.get(cacheKey);
  if (fresh !== undefined) return Promise.resolve({ ok: true, value: fresh });
  const inflight = state.inflight.get(cacheKey);
  if (inflight) return inflight;

  const generation = state.generation;
  const request = fetchProvider(ctx, fetchers, provider, state.cache.getStale(cacheKey), apiKey, baseUrl)
    .catch(() => ({ ok: false as const, error: { kind: "fetch-error" } }))
    .then((result) => {
      if (result.ok) {
        if (state.generation === generation) state.cache.set(cacheKey, result.value, providerTtl(ctx.config, provider));
        return result;
      }
      const stale = state.cache.getStale(cacheKey);
      if (stale !== undefined) {
        log.warn("listProviderModels.stale-fallback", { provider, kind: result.error.kind });
        return { ok: true as const, value: stale, stale: true as const };
      }
      log.warn("listProviderModels.upstream-down", { provider, kind: result.error.kind });
      return { ok: false as const, error: { kind: "upstream-down" } };
    });
  state.inflight.set(cacheKey, request);
  void request.finally(() => {
    if (state.inflight.get(cacheKey) === request) state.inflight.delete(cacheKey);
  });
  return request;
}

function providerTtl(config: ProvidersConfig, provider: CatalogProvider): number {
  return provider === "openrouter" ? config.openrouter_cache_ttl_ms : config.ollama_cache_ttl_ms;
}

async function fetchProvider(
  ctx: ProvidersDepsContext,
  fetchers: ResolvedFetchers,
  provider: CatalogProvider,
  priorModels: readonly InternalModelEntry[] | undefined,
  apiKey?: string,
  baseUrl?: string,
): Promise<ProvidersListResult<InternalModelEntry[]>> {
  if (provider === "openrouter") {
    return fetchers.openrouter({
      apiKey: () =>
        (apiKey !== undefined
          ? apiKey
          : ctx.secretsStore?.getProviderSecretsSync("openrouter")?.apiKey || ctx.env("OPENROUTER_API_KEY")) || null,
      baseUrl: baseUrl ?? OPENROUTER_BASE_URL,
      timeoutMs: ctx.config.external_fetch_timeout_ms,
    });
  }
  return fetchers.ollama({
    baseUrl: baseUrl ?? ctx.config.ollama_cloud_base_url,
    timeoutMs: ctx.config.external_fetch_timeout_ms,
    ...(priorModels ? { priorModels } : {}),
  });
}

function connectionCacheKey(connection: { readonly apiKey: string; readonly baseUrl: string }): string {
  return `connection:${createHash("sha256").update(`${connection.baseUrl}\0${connection.apiKey}`).digest("hex")}`;
}

function publicModel(entry: InternalModelEntry): ModelEntry {
  return {
    id: entry.id,
    provider: entry.provider,
    name: entry.name,
    description: entry.description,
    contextLength: entry.contextLength,
    pricingPer1mPrompt: entry.pricingPer1mPrompt,
    pricingPer1mCompletion: entry.pricingPer1mCompletion,
    supportsTools: entry.supportsTools,
    supportsVision: entry.supportsVision,
  };
}
