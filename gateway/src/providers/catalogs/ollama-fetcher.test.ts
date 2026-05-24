import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaCloudModels } from "./ollama-fetcher.js";

// Sample mirrors the real /api/tags shape — names with and without size
// variants so we exercise both tag-form rules (`:cloud` vs `-cloud`).
const sampleResponse = {
  models: [
    { name: "kimi-k2.6", model: "kimi-k2.6", size: 595_148_192_736 },
    { name: "gemma3:4b", model: "gemma3:4b", size: 8_600_000_000 },
    { name: "gpt-oss:120b", model: "gpt-oss:120b", size: 65_290_180_781 },
    { name: "qwen3-vl:235b", model: "qwen3-vl:235b", size: 470_000_000_000 },
    { name: "deepseek-v4-flash", model: "deepseek-v4-flash", size: 140_000_000_000 },
    { name: "minimax-m2", model: "minimax-m2", size: 230_000_000_000 },
  ],
};

const config = {
  baseUrl: "https://ollama.com/v1",
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

describe("fetchOllamaCloudModels", () => {
  it("hits /api/tags at the origin (strips the /v1 OpenAI-compat suffix)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    await fetchOllamaCloudModels(config);
    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(calledUrl)).toBe("https://ollama.com/api/tags");
  });

  it("translates a name without colon into <name>:cloud", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((m) => m.id);
    expect(ids).toContain("kimi-k2.6:cloud");
    expect(ids).toContain("deepseek-v4-flash:cloud");
    expect(ids).toContain("minimax-m2:cloud");
  });

  it("translates a name with size variant into <name>:<size>-cloud", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((m) => m.id);
    expect(ids).toContain("gemma3:4b-cloud");
    expect(ids).toContain("gpt-oss:120b-cloud");
    expect(ids).toContain("qwen3-vl:235b-cloud");
  });

  it("infers capability flags via the family table", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.map((m) => [m.id, m]));
    const qwenVl = byId.get("qwen3-vl:235b-cloud");
    const gpt = byId.get("gpt-oss:120b-cloud");
    expect(qwenVl?.supportsVision).toBe(true);
    expect(qwenVl?.supportsTools).toBe(true);
    expect(gpt?.supportsVision).toBe(false);
    expect(gpt?.supportsTools).toBe(true);
  });

  it("marks every entry with provider='ollama-cloud' and bundled pricing", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value) {
      expect(m.provider).toBe("ollama-cloud");
      expect(m.pricingPer1mPrompt).toBe("included");
      expect(m.pricingPer1mCompletion).toBe("included");
    }
  });

  it("returns fetch-error on non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("fetch-error");
    if (r.error.kind === "fetch-error") expect(r.error.status).toBe(503);
  });

  it("returns timeout when fetch aborts", async () => {
    fetchSpy.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 5);
        }),
    );
    const r = await fetchOllamaCloudModels({ ...config, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("timeout");
    if (r.error.kind === "timeout") expect(r.error.afterMs).toBe(50);
  });

  it("returns parse-error on malformed JSON", async () => {
    fetchSpy.mockResolvedValue(new Response("{not-json", { status: 200 }));
    const r = await fetchOllamaCloudModels(config);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parse-error");
  });
});
