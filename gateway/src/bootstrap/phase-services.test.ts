import type { OrchestratorConfig } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { resolveDreamerModel } from "./phase-services.js";

function memCfg(model: string): OrchestratorConfig["memory"] {
  return { dreamer: { model } } as unknown as OrchestratorConfig["memory"];
}

function providerCfg(model: string): OrchestratorConfig["provider"] {
  return { model } as unknown as OrchestratorConfig["provider"];
}

describe("resolveDreamerModel", () => {
  it("inherits provider.model when dreamer.model is the default empty string", () => {
    expect(resolveDreamerModel(memCfg(""), providerCfg("chat-model"))).toBe("chat-model");
  });

  it("overrides with a non-empty dreamer.model, ignoring provider.model", () => {
    expect(resolveDreamerModel(memCfg("deepseek-v4-flash:cloud"), providerCfg("chat-model"))).toBe(
      "deepseek-v4-flash:cloud",
    );
  });
});
