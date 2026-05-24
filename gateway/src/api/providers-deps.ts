import type { ProvidersConfig } from "@sentient/config";
import type { LlmProvider, SecretsStore } from "../admin/secrets-store.js";
import { getLog } from "../logging/logger.js";
import { fetchFishVoiceById, fetchFishVoices } from "../providers/catalogs/fish-fetcher.js";
import type { FishVoicePage } from "../providers/catalogs/fish-fetcher.js";
import { fetchOllamaCloudModels } from "../providers/catalogs/ollama-fetcher.js";
import { fetchOpenRouterModels } from "../providers/catalogs/openrouter-fetcher.js";
import type { ModelEntry, VoiceEntry } from "../providers/catalogs/types.js";
import { type TtlCache, createTtlCache } from "../util/ttl-cache.js";
import type { ProvidersListResult, VoicePage } from "./handlers/providers.js";

const log = getLog(["sentient", "gateway", "api", "providers-deps"]);

const CACHE_KEY = "all";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const FISH_BASE_URL = "https://api.fish.audio";

export interface ListVoicesOptions {
  /** Substring query against voice title. When set, bypasses catalog cache. */
  title?: string;
  /** 1-indexed page; bypasses catalog cache when > 1. */
  page?: number;
}

export interface ProvidersDeps {
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  listVoices: (opts?: ListVoicesOptions) => Promise<ProvidersListResult<VoicePage>>;
  getVoice: (id: string) => Promise<ProvidersListResult<VoiceEntry>>;
  invalidateCatalogCache: (provider: LlmProvider | "fish") => void;
}

export interface ProvidersFetchers {
  openrouter?: typeof fetchOpenRouterModels;
  ollama?: typeof fetchOllamaCloudModels;
  fish?: typeof fetchFishVoices;
  fishById?: typeof fetchFishVoiceById;
}

export interface ProvidersDepsContext {
  config: ProvidersConfig;
  env: (name: string) => string | undefined;
  secretsStore?: SecretsStore | undefined;
  modelCache?: TtlCache<ModelEntry[]>;
  voiceCache?: TtlCache<FishVoicePage>;
  fetchers?: ProvidersFetchers;
}

interface ResolvedFetchers {
  openrouter: typeof fetchOpenRouterModels;
  ollama: typeof fetchOllamaCloudModels;
  fish: typeof fetchFishVoices;
  fishById: typeof fetchFishVoiceById;
}

export function createProvidersDeps(ctx: ProvidersDepsContext): ProvidersDeps {
  const modelCache = ctx.modelCache ?? createTtlCache<ModelEntry[]>();
  const voiceCache = ctx.voiceCache ?? createTtlCache<FishVoicePage>();
  const fetchers = resolveFetchers(ctx.fetchers);

  return {
    listModels: () => listModels(ctx, modelCache, fetchers),
    listVoices: (opts) => listVoices(ctx, voiceCache, fetchers, opts),
    getVoice: (id) => getVoice(ctx, fetchers, id),
    invalidateCatalogCache(provider) {
      // LLM providers invalidate the model catalog cache; fish invalidates voices
      if (provider === "openrouter" || provider === "ollama-cloud" || provider === "custom") modelCache.clear();
      if (provider === "fish") voiceCache.clear();
    },
  };
}

const FIRST_PAGE = 1;

function resolveFetchers(injected?: ProvidersFetchers): ResolvedFetchers {
  return {
    openrouter: injected?.openrouter ?? fetchOpenRouterModels,
    ollama: injected?.ollama ?? fetchOllamaCloudModels,
    fish: injected?.fish ?? fetchFishVoices,
    fishById: injected?.fishById ?? fetchFishVoiceById,
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

async function listVoices(
  ctx: ProvidersDepsContext,
  cache: TtlCache<FishVoicePage>,
  fetchers: ResolvedFetchers,
  opts?: ListVoicesOptions,
): Promise<ProvidersListResult<VoicePage>> {
  const title = opts?.title?.trim() ?? "";
  const page = opts?.page && opts.page > FIRST_PAGE ? opts.page : FIRST_PAGE;
  const titleSearch = title !== "";
  const cacheable = !titleSearch && page === FIRST_PAGE;

  // Only the "default" view (no title, page 1) is worth caching — per-keystroke
  // searches and deeper pages would pollute the shared "all" key.
  if (cacheable) {
    const fresh = cache.get(CACHE_KEY);
    if (fresh !== undefined) {
      log.debug("listVoices.cache-hit", { count: fresh.voices.length, hasMore: fresh.hasMore });
      return { ok: true, value: fresh };
    }
  }

  log.info("listVoices.begin", { titleSearch, page });
  const fishConfig: Parameters<typeof fetchers.fish>[0] = {
    apiKey: () => ctx.secretsStore?.getFishAudioKeySync() ?? ctx.env("FISH_AUDIO_API_KEY") ?? null,
    baseUrl: FISH_BASE_URL,
    timeoutMs: ctx.config.external_fetch_timeout_ms,
  };
  if (titleSearch) fishConfig.title = title;
  if (page > FIRST_PAGE) fishConfig.page = page;
  const r = await fetchers.fish(fishConfig);
  if (r.ok) {
    if (cacheable) {
      cache.set(CACHE_KEY, r.value, ctx.config.fish_cache_ttl_ms);
    }
    log.info("listVoices.done", {
      count: r.value.voices.length,
      hasMore: r.value.hasMore,
      titleSearch,
      page,
    });
    return { ok: true, value: r.value };
  }
  log.warn("listVoices.upstream-failed", { kind: r.error.kind, titleSearch, page });
  if (!cacheable) {
    return { ok: false, error: { kind: "upstream-down" } };
  }
  return staleOrError(cache, "listVoices");
}

async function getVoice(
  ctx: ProvidersDepsContext,
  fetchers: ResolvedFetchers,
  id: string,
): Promise<ProvidersListResult<VoiceEntry>> {
  log.info("getVoice.begin", { id });
  const r = await fetchers.fishById(
    {
      apiKey: () => ctx.secretsStore?.getFishAudioKeySync() ?? ctx.env("FISH_AUDIO_API_KEY") ?? null,
      baseUrl: FISH_BASE_URL,
      timeoutMs: ctx.config.external_fetch_timeout_ms,
    },
    id,
  );
  if (r.ok) {
    log.info("getVoice.done", { id, title: r.value.title });
    return { ok: true, value: r.value };
  }
  log.warn("getVoice.upstream-failed", { id, kind: r.error.kind });
  return { ok: false, error: { kind: r.error.kind } };
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
