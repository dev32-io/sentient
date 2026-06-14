import { describe, expect, it } from "vitest";
import { createSurfaceCycleRegistry } from "./surface-cycle-registry.js";

describe("SurfaceCycleRegistry — one in-flight cycle per surface", () => {
  it("acquire returns owner=true for the first cycle on a surface", () => {
    const reg = createSurfaceCycleRegistry();
    const lease = reg.acquire("surface_a", "cycle_1", new AbortController());
    expect(lease.owner).toBe(true);
    expect(lease.activeCycleId).toBe("cycle_1");
  });
  it("acquire on a busy surface returns owner=false + the in-flight id (no register-over)", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    const lease = reg.acquire("surface_a", "cycle_2", new AbortController());
    expect(lease.owner).toBe(false);
    expect(lease.activeCycleId).toBe("cycle_1");
  });
  it("isolates two surfaces — each owns its own in-flight cycle", () => {
    const reg = createSurfaceCycleRegistry();
    expect(reg.acquire("surface_a", "c_a", new AbortController()).owner).toBe(true);
    expect(reg.acquire("surface_b", "c_b", new AbortController()).owner).toBe(true);
  });
  it("a reconnecting transport adopts the in-flight cycle's controller (no restart)", () => {
    const reg = createSurfaceCycleRegistry();
    const original = new AbortController();
    reg.acquire("surface_a", "cycle_1", original);
    expect(reg.currentController("surface_a")).toBe(original);
    expect(reg.activeCycleId("surface_a")).toBe("cycle_1");
  });
  it("complete clears the slot so the next cycle owns it", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    reg.complete("surface_a", "cycle_1");
    expect(reg.acquire("surface_a", "cycle_2", new AbortController()).owner).toBe(true);
  });
  it("complete with a stale id is a no-op (does not free an adopted cycle)", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    reg.complete("surface_a", "cycle_OLD");
    expect(reg.activeCycleId("surface_a")).toBe("cycle_1");
  });
});
