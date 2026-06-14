import { describe, expect, it } from "vitest";
import { createSurfaceCycleRegistry } from "./surface-cycle-registry.js";
import { admitCycle } from "./ws-session-configure.js";

describe("admitCycle — per-surface serialization + adoption", () => {
  it("admits the first user cycle as dispatchable", () => {
    const reg = createSurfaceCycleRegistry();
    expect(admitCycle(reg, "surface_a", "cycle_user", new AbortController()).dispatch).toBe(true);
  });
  it("rejects an internal dispatch while a user cycle is in flight (queue, no second prompt)", () => {
    const reg = createSurfaceCycleRegistry();
    admitCycle(reg, "surface_a", "cycle_user", new AbortController());
    const internal = admitCycle(reg, "surface_a", "cycle_save_skill", new AbortController());
    expect(internal.dispatch).toBe(false);
    expect(internal.activeCycleId).toBe("cycle_user");
  });
  it("a reconnect transport seeing an in-flight cycle does NOT dispatch and does NOT cancel it", () => {
    const reg = createSurfaceCycleRegistry();
    const original = new AbortController();
    admitCycle(reg, "surface_a", "cycle_user", original);
    const reconnect = admitCycle(reg, "surface_a", "cycle_user_again", new AbortController());
    expect(reconnect.dispatch).toBe(false);
    expect(original.signal.aborted).toBe(false);
  });
});
