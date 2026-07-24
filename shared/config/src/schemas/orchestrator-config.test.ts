import { describe, expect, it } from "vitest";
import { orchestratorConfigSchema } from "./orchestrator-config";

const base = {
  provider: { base_url: "https://x/api/v1", model: "m" },
  loop: {},
  tools: {},
  delegation: {},
};

describe("orchestratorConfigSchema", () => {
  it("applies defaults for optional tunables", () => {
    const c = orchestratorConfigSchema.parse(base);
    expect(c.loop.max_iterations).toBe(10);
    expect(c.tools.max_concurrent_background_tasks).toBe(50);
    expect(c.provider.request_timeout_ms).toBe(120000);
  });
  it("rejects a non-url base_url", () => {
    expect(() =>
      orchestratorConfigSchema.parse({ ...base, provider: { ...base.provider, base_url: "not-a-url" } }),
    ).toThrow();
  });
  it("rejects an out-of-range max_iterations", () => {
    expect(() => orchestratorConfigSchema.parse({ ...base, loop: { max_iterations: 999 } })).toThrow();
  });
  it("defaults base_url to empty string when omitted — the composition root then relies entirely on the secrets store", () => {
    const c = orchestratorConfigSchema.parse({ ...base, provider: { model: "m" } });
    expect(c.provider.base_url).toBe("");
  });
  it("no longer accepts/needs api_key_env — the key comes from the secrets store, not config", () => {
    const c = orchestratorConfigSchema.parse(base);
    expect("api_key_env" in c.provider).toBe(false);
  });
});
