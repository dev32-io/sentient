import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaCloudModels } from "./ollama-fetcher.js";

const config = {
  baseUrl: "https://ollama.com/v1",
  timeoutMs: 5_000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function catalog(names: string[]) {
  return { models: names.map((name) => ({ name })) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchOllamaCloudModels", () => {
  it("uses raw discovered IDs for /api/show and normalizes only catalog IDs", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/tags")) return json(catalog(["unfamiliar-model", "gemma4:31b"]));
      return json({ capabilities: ["completion"], model_info: {} });
    });

    const result = await fetchOllamaCloudModels({ ...config, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]?.url).toBe("https://ollama.com/api/tags");
    expect(calls.slice(1).map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { model: "unfamiliar-model" },
      { model: "gemma4:31b" },
    ]);
    expect(calls.slice(1).every(({ init }) => init?.method === "POST")).toBe(true);
    expect(calls.slice(1).every(({ init }) => new Headers(init?.headers).get("authorization") === null)).toBe(true);
    expect(result.value.map(({ id }) => id)).toEqual(["unfamiliar-model:cloud", "gemma4:31b-cloud"]);
  });

  it("derives unfamiliar-model capabilities and architecture context from /api/show", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/tags")) return json(catalog(["new-hotness", "text-only"]));
      return json(
        fetch.mock.calls.length === 2
          ? {
              capabilities: ["completion", "tools", "vision"],
              model_info: {
                "general.architecture": "newarch",
                "aaa.context_length": 4_096,
                "newarch.context_length": 262_144,
              },
            }
          : { capabilities: ["completion"], model_info: { "text.context_length": 32_768 } },
      );
    });

    const result = await fetchOllamaCloudModels({ ...config, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      contextLength: 262_144,
    });
    expect(result.value[1]).toMatchObject({
      supportsVision: false,
      supportsTools: false,
      contextLength: 32_768,
    });
  });

  it("keeps inventory and fails closed for malformed, missing, and failed per-model metadata", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/tags")) return json(catalog(["malformed", "missing", "failed"]));
      const model = JSON.parse(String(init?.body)).model;
      if (model === "malformed") return json({ capabilities: "vision", model_info: {} });
      if (model === "missing") return json({});
      throw new Error("metadata unavailable");
    });

    const result = await fetchOllamaCloudModels({ ...config, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    for (const model of result.value) {
      expect(model).toMatchObject({
        supportsVision: false,
        supportsTools: false,
        contextLength: 0,
        metadataComplete: false,
      });
    }
  });

  it("uses capabilities without model_info and treats ambiguous context as unknown", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/tags")) return json(catalog(["capable", "ambiguous"]));
      return fetch.mock.calls.length === 2
        ? json({ capabilities: ["tools", "vision"] })
        : json({ capabilities: ["tools"], model_info: { "one.context_length": 1_024, "two.context_length": 2_048 } });
    });

    const result = await fetchOllamaCloudModels({ ...config, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      expect.objectContaining({
        supportsTools: true,
        supportsVision: true,
        contextLength: 0,
        metadataComplete: true,
      }),
      expect.objectContaining({
        supportsTools: true,
        supportsVision: false,
        contextLength: 0,
        metadataComplete: true,
      }),
    ]);
  });

  it("preserves exact-ID metadata on failure, but fresh negatives revoke it and removed inventory stays removed", async () => {
    const priorModels = [
      {
        id: "kept:cloud",
        provider: "ollama-cloud" as const,
        name: "kept",
        description: "",
        contextLength: 8_192,
        pricingPer1mPrompt: "included" as const,
        pricingPer1mCompletion: "included" as const,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "removed:cloud",
        provider: "ollama-cloud" as const,
        name: "removed",
        description: "",
        contextLength: 4_096,
        pricingPer1mPrompt: "included" as const,
        pricingPer1mCompletion: "included" as const,
        supportsTools: true,
        supportsVision: true,
      },
    ];
    let freshNegative = false;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/tags")) return json(catalog(["kept"]));
      return freshNegative
        ? json({ capabilities: ["completion"], model_info: { "only.context_length": 2_048 } })
        : new Response("", { status: 503 });
    });

    const preserved = await fetchOllamaCloudModels({ ...config, fetch, priorModels });
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    expect(preserved.value).toEqual([
      expect.objectContaining({
        id: "kept:cloud",
        supportsTools: true,
        supportsVision: true,
        contextLength: 8_192,
        metadataComplete: false,
      }),
    ]);

    freshNegative = true;
    const revoked = await fetchOllamaCloudModels({ ...config, fetch, priorModels: preserved.value });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value).toEqual([
      expect.objectContaining({
        id: "kept:cloud",
        supportsTools: false,
        supportsVision: false,
        contextLength: 2_048,
        metadataComplete: true,
      }),
    ]);
  });

  it("bounds enrichment concurrency and cancels all active requests at one shared deadline", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    let aborted = 0;
    const signals = new Set<AbortSignal>();
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (signal) signals.add(signal);
      if (String(input).endsWith("/api/tags")) {
        return Promise.resolve(json(catalog(Array.from({ length: 8 }, (_, i) => `model-${i}`))));
      }
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            active--;
            aborted++;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });

    const pending = fetchOllamaCloudModels({ ...config, timeoutMs: 100, fetch });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBe(4);

    vi.advanceTimersByTime(100);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(8);
    expect(result.value.every((model) => !model.supportsVision && !model.supportsTools)).toBe(true);
    expect(aborted).toBe(4);
    expect(signals.size).toBe(1);
  });

  it("returns timeout when inventory fetch honors cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    );

    const pending = fetchOllamaCloudModels({ ...config, timeoutMs: 100, fetch });
    vi.advanceTimersByTime(100);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: { kind: "timeout", afterMs: 100 } });
  });

  it("returns fetch-error for failed inventory HTTP response", async () => {
    const result = await fetchOllamaCloudModels({ ...config, fetch: async () => new Response("", { status: 503 }) });
    expect(result).toEqual({ ok: false, error: { kind: "fetch-error", status: 503 } });
  });

  it("returns parse-error for malformed inventory JSON", async () => {
    const result = await fetchOllamaCloudModels({
      ...config,
      fetch: async () => new Response("{not-json", { status: 200 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("parse-error");
  });
});
