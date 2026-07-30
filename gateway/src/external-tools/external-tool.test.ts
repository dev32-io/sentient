import { describe, expect, it } from "vitest";
import { type ExternalTool, configureExternalTools } from "./external-tool.js";

function recordingTool(name: string, calls: string[]): ExternalTool {
  return {
    name,
    async configure(userId) {
      calls.push(`${name}:${userId}`);
      return { ok: true, value: undefined };
    },
  };
}

describe("configureExternalTools", () => {
  // ORDERING INVARIANT. Writing an external tool's config before the gateway's
  // own dependencies are up points it at a socket nothing serves — silent, and
  // indistinguishable from the defect this handler exists to fix. A readiness
  // gate that never resolves ready must skip, never proceed blind.
  it("configures nothing when internal dependencies do not report ready", async () => {
    const calls: string[] = [];
    await configureExternalTools({
      tools: [recordingTool("hermes", calls)],
      listUserIds: async () => ["u_a"],
      internalDependenciesReady: async () => false,
    });
    expect(calls).toEqual([]);
  });

  it("configures every tool for every user once dependencies are ready", async () => {
    const calls: string[] = [];
    await configureExternalTools({
      tools: [recordingTool("hermes", calls), recordingTool("other", calls)],
      listUserIds: async () => ["u_a", "u_b"],
      internalDependenciesReady: async () => true,
    });
    expect(calls).toEqual(["hermes:u_a", "hermes:u_b", "other:u_a", "other:u_b"]);
  });

  it("keeps going for the remaining users after one fails", async () => {
    const calls: string[] = [];
    const failing: ExternalTool = {
      name: "hermes",
      async configure(userId) {
        calls.push(userId);
        return userId === "u_a" ? { ok: false, error: "cli-error" } : { ok: true, value: undefined };
      },
    };
    await configureExternalTools({
      tools: [failing],
      listUserIds: async () => ["u_a", "u_b"],
      internalDependenciesReady: async () => true,
    });
    expect(calls).toEqual(["u_a", "u_b"]);
  });
});
