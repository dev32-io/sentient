import type { ProvidersConfig } from "@sentient/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider, SecretsStore } from "../admin/secrets-store.js";
import type { OllamaModelEntry } from "../providers/catalogs/ollama-fetcher.js";
import type { OpenRouterModelEntry } from "../providers/catalogs/openrouter-fetcher.js";
import type { ModelEntry } from "../providers/catalogs/types.js";
import { type ProvidersFetchers, createProvidersDeps } from "./providers-deps.js";

const config: ProvidersConfig = {
  openrouter_cache_ttl_ms: 10_000,
  ollama_cloud_base_url: "https://ollama.example/v1",
  ollama_cache_ttl_ms: 10_000,
  external_fetch_timeout_ms: 1_000,
  fish_browse_enabled: false,
  fish_cache_ttl_ms: 10_000,
};

afterEach(() => {
  vi.useRealTimers();
});

function model(provider: "openrouter", id: string): OpenRouterModelEntry;
function model(provider: "ollama-cloud", id: string): OllamaModelEntry;
function model(provider: "openrouter" | "ollama-cloud", id: string): ModelEntry | OllamaModelEntry {
  return {
    id,
    provider,
    name: id,
    description: "",
    contextLength: 1,
    pricingPer1mPrompt: provider === "ollama-cloud" ? "included" : 0,
    pricingPer1mCompletion: provider === "ollama-cloud" ? "included" : 0,
    supportsTools: false,
    supportsVision: false,
    ...(provider === "ollama-cloud"
      ? { metadataComplete: true, capabilitiesKnown: true }
      : { visionCapabilityKnown: true, toolsCapabilityKnown: true }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function resolvedOpenRouterKey(options: {
  activeProvider: LlmProvider;
  activeKey: string;
  openRouterKey: string | null;
  envKey?: string;
}): Promise<string | null> {
  let resolved: string | null = null;
  const secretsStore = {
    getActiveLlmSync: () => ({ provider: options.activeProvider, apiKey: options.activeKey, baseUrl: "" }),
    getProviderSecretsSync: (provider: LlmProvider) =>
      provider === "openrouter" ? { provider, apiKey: options.openRouterKey ?? "", baseUrl: "" } : null,
  } as SecretsStore;
  const fetchers: ProvidersFetchers = {
    openrouter: async (fetchConfig) => {
      resolved = fetchConfig.apiKey();
      return { ok: true, value: [] };
    },
    ollama: async () => ({ ok: true, value: [] }),
  };

  await createProvidersDeps({
    config,
    secretsStore,
    env: (name) => (name === "OPENROUTER_API_KEY" ? options.envKey : undefined),
    fetchers,
  }).listModels();

  return resolved;
}

describe("createProvidersDeps OpenRouter credentials", () => {
  it.each(["ollama-cloud", "custom"] as const)(
    "does not forward active %s credentials to OpenRouter",
    async (activeProvider) => {
      expect(
        await resolvedOpenRouterKey({
          activeProvider,
          activeKey: "active-provider-credential",
          openRouterKey: "openrouter-credential",
          envKey: "environment-fallback",
        }),
      ).toBe("openrouter-credential");
    },
  );

  it("uses designated environment fallback when OpenRouter credential is empty", async () => {
    expect(
      await resolvedOpenRouterKey({
        activeProvider: "custom",
        activeKey: "active-provider-credential",
        openRouterKey: null,
        envKey: "environment-fallback",
      }),
    ).toBe("environment-fallback");
  });

  it("passes no credential when neither designated source has one", async () => {
    expect(
      await resolvedOpenRouterKey({
        activeProvider: "ollama-cloud",
        activeKey: "active-provider-credential",
        openRouterKey: null,
      }),
    ).toBeNull();
  });
});

describe("createProvidersDeps catalog cache", () => {
  it("uses independent provider TTLs", async () => {
    vi.useFakeTimers();
    const openrouter = vi.fn(async () => ({ ok: true as const, value: [model("openrouter", "or")] }));
    const ollama = vi.fn(async () => ({ ok: true as const, value: [model("ollama-cloud", "ol")] }));
    const deps = createProvidersDeps({
      config: { ...config, openrouter_cache_ttl_ms: 10_000, ollama_cache_ttl_ms: 20_000 },
      env: () => undefined,
      fetchers: { openrouter, ollama },
    });

    await deps.listModels();
    vi.advanceTimersByTime(10_000);
    await deps.listModels();

    expect(openrouter).toHaveBeenCalledTimes(2);
    expect(ollama).toHaveBeenCalledTimes(1);
  });

  it("keeps each provider stale independently during partial outage", async () => {
    vi.useFakeTimers();
    let failOpenRouter = false;
    let ollamaId = "ol-old";
    const deps = createProvidersDeps({
      config,
      env: () => undefined,
      fetchers: {
        openrouter: async () =>
          failOpenRouter
            ? { ok: false, error: { kind: "fetch-error" as const, status: 503 } }
            : { ok: true, value: [model("openrouter", "or-old")] },
        ollama: async () => ({ ok: true, value: [model("ollama-cloud", ollamaId)] }),
      },
    });

    await deps.listModels();
    failOpenRouter = true;
    ollamaId = "ol-new";
    vi.advanceTimersByTime(10_000);
    const result = await deps.listModels();

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: "or-old" }), expect.objectContaining({ id: "ol-new" })],
      stale: true,
    });
  });

  it("coalesces concurrent lookups per provider", async () => {
    const pending = deferred<{ ok: true; value: OpenRouterModelEntry[] }>();
    const openrouter = vi.fn(() => pending.promise);
    const deps = createProvidersDeps({ config, env: () => undefined, fetchers: { openrouter } });

    const lookups = Array.from({ length: 3 }, () => deps.listProviderModels("openrouter"));
    expect(openrouter).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, value: [model("openrouter", "shared")] });

    expect(await Promise.all(lookups)).toEqual(
      Array.from({ length: 3 }, () => ({ ok: true, value: [expect.objectContaining({ id: "shared" })] })),
    );
  });

  it("does not let invalidated in-flight results overwrite newer cache data", async () => {
    const first = deferred<{ ok: true; value: OpenRouterModelEntry[] }>();
    const openrouter = vi
      .fn<NonNullable<ProvidersFetchers["openrouter"]>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: [model("openrouter", "new")] });
    const deps = createProvidersDeps({ config, env: () => undefined, fetchers: { openrouter } });

    const oldLookup = deps.listProviderModels("openrouter");
    deps.invalidateCatalogCache("openrouter");
    expect(await deps.listProviderModels("openrouter")).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: "new" })],
    });
    first.resolve({ ok: true, value: [model("openrouter", "old")] });
    await oldLookup;

    expect(await deps.listProviderModels("openrouter")).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: "new" })],
    });
    expect(openrouter).toHaveBeenCalledTimes(2);
  });

  it("keeps internal Ollama capability status out of public model DTOs", async () => {
    const deps = createProvidersDeps({
      config,
      env: () => undefined,
      fetchers: {
        ollama: async () => ({
          ok: true,
          value: [
            {
              ...model("ollama-cloud", "vision:cloud"),
              supportsVision: true,
              metadataComplete: false,
              capabilitiesKnown: true,
            },
          ],
        }),
      },
    });

    expect(await deps.resolveProviderModel("ollama-cloud", "vision:cloud")).toMatchObject({
      visionCapabilityKnown: true,
      toolsCapabilityKnown: true,
      model: { supportsVision: true },
    });
    const listed = await deps.listProviderModels("ollama-cloud");
    expect(listed.ok && listed.value[0]).not.toHaveProperty("metadataComplete");
    expect(listed.ok && listed.value[0]).not.toHaveProperty("capabilitiesKnown");
  });

  it("keeps separate OpenRouter capability status private", async () => {
    const deps = createProvidersDeps({
      config,
      env: () => undefined,
      fetchers: {
        openrouter: async () => ({
          ok: true,
          value: [
            {
              ...model("openrouter", "partial"),
              supportsTools: true,
              visionCapabilityKnown: false,
              toolsCapabilityKnown: true,
            },
          ],
        }),
      },
    });

    expect(await deps.resolveProviderModel("openrouter", "partial")).toMatchObject({
      visionCapabilityKnown: false,
      toolsCapabilityKnown: true,
    });
    const listed = await deps.listProviderModels("openrouter");
    expect(listed.ok && listed.value[0]).not.toHaveProperty("visionCapabilityKnown");
    expect(listed.ok && listed.value[0]).not.toHaveProperty("toolsCapabilityKnown");
  });

  it("uses snapshot credential and endpoint for main catalog lookup", async () => {
    const seen: Array<{ key: string | null; baseUrl: string }> = [];
    const deps = createProvidersDeps({
      config,
      env: () => "ambient-key",
      fetchers: {
        openrouter: async (fetchConfig) => {
          seen.push({ key: fetchConfig.apiKey(), baseUrl: fetchConfig.baseUrl });
          return { ok: true, value: [model("openrouter", "m")] };
        },
      },
    });

    await deps.resolveProviderModel("openrouter", "m", {
      apiKey: "snapshot-key",
      baseUrl: "https://snapshot.example/v1",
    });
    expect(seen).toEqual([{ key: "snapshot-key", baseUrl: "https://snapshot.example/v1" }]);
  });

  it("isolates same-key endpoint rotation from stale and in-flight catalog data", async () => {
    vi.useFakeTimers();
    const pendingA = deferred<{
      ok: false;
      error: { kind: "fetch-error"; status: number };
    }>();
    let callsA = 0;
    const openrouter = vi.fn<NonNullable<ProvidersFetchers["openrouter"]>>((fetchConfig) => {
      if (fetchConfig.baseUrl === "https://a.example/v1") {
        callsA++;
        if (callsA === 1) {
          return Promise.resolve({
            ok: true,
            value: [{ ...model("openrouter", "m"), supportsVision: true }],
          });
        }
        return pendingA.promise;
      }
      return Promise.resolve({ ok: true, value: [model("openrouter", "m")] });
    });
    const deps = createProvidersDeps({ config, env: () => undefined, fetchers: { openrouter } });
    const connectionA = { apiKey: "same-key", baseUrl: "https://a.example/v1" };
    const connectionB = { apiKey: "same-key", baseUrl: "https://b.example/v1" };

    expect((await deps.resolveProviderModel("openrouter", "m", connectionA))?.model.supportsVision).toBe(true);
    vi.advanceTimersByTime(config.openrouter_cache_ttl_ms);
    const staleA = deps.resolveProviderModel("openrouter", "m", connectionA);
    const freshB = await deps.resolveProviderModel("openrouter", "m", connectionB);
    pendingA.resolve({ ok: false, error: { kind: "fetch-error", status: 503 } });

    expect(freshB?.model.supportsVision).toBe(false);
    expect((await staleA)?.model.supportsVision).toBe(true);
    expect((await deps.resolveProviderModel("openrouter", "m", connectionB))?.model.supportsVision).toBe(false);
    expect(openrouter.mock.calls.map(([fetchConfig]) => fetchConfig.baseUrl)).toEqual([
      "https://a.example/v1",
      "https://a.example/v1",
      "https://b.example/v1",
    ]);
  });

  it("keeps endpoint scopes distinct and passes prior metadata only to Ollama", async () => {
    vi.useFakeTimers();
    const openrouter = vi.fn<NonNullable<ProvidersFetchers["openrouter"]>>(async () => ({
      ok: true,
      value: [model("openrouter", "or")],
    }));
    const ollama = vi.fn<NonNullable<ProvidersFetchers["ollama"]>>(async () => ({
      ok: true,
      value: [model("ollama-cloud", "ol")],
    }));
    const deps = createProvidersDeps({ config, env: () => undefined, fetchers: { openrouter, ollama } });

    await deps.listModels();
    vi.advanceTimersByTime(10_000);
    await deps.listProviderModels("ollama-cloud");

    expect(openrouter.mock.calls[0]?.[0].baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(ollama.mock.calls[0]?.[0].baseUrl).toBe(config.ollama_cloud_base_url);
    expect(ollama.mock.calls[1]?.[0].priorModels).toEqual([expect.objectContaining({ id: "ol" })]);
  });
});
