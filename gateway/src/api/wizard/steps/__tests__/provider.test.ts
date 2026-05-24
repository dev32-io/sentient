import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.ts";
import { providerStep } from "../provider.ts";

function makeDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    secretsStore: {
      setLlmProviderKey: vi.fn(async () => ({ ok: true, value: undefined })),
      setActiveLlmProvider: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    ...overrides,
  } as unknown as WizardDeps;
}

describe("providerStep", () => {
  it("parses valid body { provider, api_key }", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ provider: "openrouter", api_key: "sk-test" }),
    });
    const result = await providerStep.parse(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.provider).toBe("openrouter");
  });

  it("rejects missing provider", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ api_key: "x" }) });
    const result = await providerStep.parse(req);
    expect(result.ok).toBe(false);
  });

  it("apply writes provider key and active provider", async () => {
    const deps = makeDeps();
    const result = await providerStep.apply(deps, {
      provider: "openrouter",
      api_key: "sk-test",
      base_url: null,
    });
    expect(result.ok).toBe(true);
    expect(deps.secretsStore.setLlmProviderKey).toHaveBeenCalledWith("openrouter", {
      api_key: "sk-test",
      base_url: null,
    });
    expect(deps.secretsStore.setActiveLlmProvider).toHaveBeenCalledWith("openrouter");
  });

  it("apply returns secrets-write-failed when set-key fails", async () => {
    const deps = makeDeps({
      secretsStore: {
        setLlmProviderKey: async () => ({ ok: false, error: { kind: "io-error" } }),
        setActiveLlmProvider: async () => ({ ok: true, value: undefined }),
      } as never,
    });
    const result = await providerStep.apply(deps, { provider: "openrouter", api_key: "sk", base_url: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("secrets-write-failed");
  });
});
