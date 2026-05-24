import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterModels } from "./openrouter-fetcher.js";

const sampleResponse = {
  data: [
    {
      id: "openai/gpt-4o-mini",
      name: "GPT-4o mini",
      description: "Small fast multimodal model.",
      context_length: 128000,
      pricing: {
        prompt: "0.00000015",
        completion: "0.0000006",
      },
      supported_parameters: ["tools", "temperature"],
      architecture: { modality: "text+image->text" },
    },
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek Chat",
      description: "",
      context_length: 64000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: [],
      architecture: { modality: "text->text" },
    },
  ],
};

const config = {
  apiKey: () => "sk-or-test",
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 5_000,
};

// biome-ignore lint/suspicious/noExplicitAny: vitest fetch spy generic
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe("fetchOpenRouterModels", () => {
  it("normalizes upstream response into ModelEntry[] in camelCase", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));

    const r = await fetchOpenRouterModels(config);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    const [m0, m1] = r.value;
    if (!m0 || !m1) throw new Error("expected two models");
    expect(m0.id).toBe("openai/gpt-4o-mini");
    expect(m0.provider).toBe("openrouter");
    expect(m0.contextLength).toBe(128000);
    expect(m0.supportsTools).toBe(true);
    expect(m0.supportsVision).toBe(true);
    expect(typeof m0.pricingPer1mPrompt).toBe("number");
    expect(m0.pricingPer1mPrompt as number).toBeCloseTo(0.15, 5);
    expect(m1.supportsTools).toBe(false);
    expect(m1.supportsVision).toBe(false);
  });

  it("returns fetch-error on non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));

    const r = await fetchOpenRouterModels(config);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("fetch-error");
    if (r.error.kind === "fetch-error") {
      expect(r.error.status).toBe(503);
    }
  });

  it("returns timeout when fetch aborts", async () => {
    fetchSpy.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 5);
        }),
    );

    const r = await fetchOpenRouterModels({ ...config, timeoutMs: 50 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("timeout");
    if (r.error.kind === "timeout") {
      expect(r.error.afterMs).toBe(50);
    }
  });

  it("returns parse-error on malformed JSON", async () => {
    fetchSpy.mockResolvedValue(new Response("{not-json", { status: 200 }));

    const r = await fetchOpenRouterModels(config);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parse-error");
  });
});
