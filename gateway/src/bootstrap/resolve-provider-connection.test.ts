import { describe, expect, it } from "bun:test";
import type { OrchestratorConfig } from "@sentient/config";
import type { ResolvedLlm } from "../admin/secrets-store.js";
import { resolveProviderConnection } from "./resolve-provider-connection.js";

const providerCfg: OrchestratorConfig["provider"] = {
  base_url: "",
  model: "openai/gpt-4o-mini",
  max_output_tokens: 1024,
  request_timeout_ms: 120000,
  site_name: "Sentient",
  reasoning_effort: "low",
};

describe("resolveProviderConnection", () => {
  it("returns null when no active LLM is resolved (no secrets store / cold cache)", () => {
    expect(resolveProviderConnection(null, providerCfg)).toBeNull();
  });

  it("returns null when the active provider has no key configured", () => {
    const resolved: ResolvedLlm = { provider: "openrouter", apiKey: "", baseUrl: "" };
    expect(resolveProviderConnection(resolved, providerCfg)).toBeNull();
  });

  it("returns null when a key exists but neither the secrets store nor config carries a base URL", () => {
    const resolved: ResolvedLlm = { provider: "openrouter", apiKey: "sk-test", baseUrl: "" };
    expect(resolveProviderConnection(resolved, providerCfg)).toBeNull();
  });

  it("falls back to the config base_url when the secrets store's own baseUrl is empty", () => {
    const resolved: ResolvedLlm = { provider: "openrouter", apiKey: "sk-test", baseUrl: "" };
    const cfg = { ...providerCfg, base_url: "https://openrouter.ai/api/v1" };
    expect(resolveProviderConnection(resolved, cfg)).toEqual({
      provider: "openrouter",
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("prefers the secrets store's own baseUrl over the config fallback", () => {
    const resolved: ResolvedLlm = {
      provider: "ollama-cloud",
      apiKey: "sk-test",
      baseUrl: "http://host.docker.internal:11434/v1",
    };
    const cfg = { ...providerCfg, base_url: "https://openrouter.ai/api/v1" };
    expect(resolveProviderConnection(resolved, cfg)).toEqual({
      provider: "ollama-cloud",
      apiKey: "sk-test",
      baseUrl: "http://host.docker.internal:11434/v1",
    });
  });
});
