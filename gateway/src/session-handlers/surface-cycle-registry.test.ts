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
  it("whenReleased resolves when the in-flight cycle completes", async () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("s", "c1", new AbortController());
    const p = reg.whenReleased("s");
    reg.complete("s", "c1");
    await p; // the await returning IS the assertion — it would hang if unresolved
    expect(reg.activeCycleId("s")).toBe(null);
  });
  it("a stale complete does NOT resolve waiters", async () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("s", "c1", new AbortController());
    let resolved = false;
    reg.whenReleased("s").then(() => {
      resolved = true;
    });
    reg.complete("s", "STALE");
    // Drain micro + macrotasks: a stale complete must NOT wake the waiter,
    // and the lease must stay held by the real in-flight cycle.
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(reg.activeCycleId("s")).toBe("c1");
  });
  it("after release, a previously-refused acquire can become owner", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("s", "c1", new AbortController()); // owner
    expect(reg.acquire("s", "c2", new AbortController()).owner).toBe(false); // refused
    reg.complete("s", "c1");
    expect(reg.acquire("s", "c2", new AbortController()).owner).toBe(true); // now owner
  });
  it("whenReleased await path: refused acquire becomes owner after release", async () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("s", "c1", new AbortController());
    const w = reg.whenReleased("s");
    queueMicrotask(() => reg.complete("s", "c1"));
    await w;
    expect(reg.acquire("s", "c2", new AbortController()).owner).toBe(true);
  });

  it("hasActiveLease reflects held slots", () => {
    const reg = createSurfaceCycleRegistry();
    expect(reg.hasActiveLease()).toBe(false);
    reg.acquire("s", "c1", new AbortController());
    expect(reg.hasActiveLease()).toBe(true);
    reg.complete("s", "c1");
    expect(reg.hasActiveLease()).toBe(false);
  });

  it("abortAll aborts controllers and wakes waiters", async () => {
    const reg = createSurfaceCycleRegistry();
    const ctrl = new AbortController();
    reg.acquire("s", "c1", ctrl);
    let released = false;
    const wait = reg.whenReleased("s").then(() => {
      released = true;
    });
    reg.abortAll();
    await wait;
    expect(ctrl.signal.aborted).toBe(true);
    expect(released).toBe(true);
    expect(reg.hasActiveLease()).toBe(false);
  });
});
