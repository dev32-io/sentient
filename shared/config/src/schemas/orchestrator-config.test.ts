import { describe, expect, it } from "vitest";
import { orchestratorConfigSchema } from "./orchestrator-config";

const base = {
  provider: { base_url: "https://x/api/v1", model: "m", api_key_env: "K" },
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
});
