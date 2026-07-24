import { describe, expect, it } from "bun:test";
import { createBackgroundRegistry } from "./background-registry.js";

describe("BackgroundRegistry", () => {
  it("counts registered tasks", () => {
    const registry = createBackgroundRegistry();
    expect(registry.count()).toBe(0);
    registry.register("t1", () => {});
    registry.register("t2", () => {});
    expect(registry.count()).toBe(2);
  });

  it("complete decrements the count", () => {
    const registry = createBackgroundRegistry();
    registry.register("t1", () => {});
    registry.register("t2", () => {});
    registry.complete("t1");
    expect(registry.count()).toBe(1);
  });

  it("complete on an unknown taskId is a no-op", () => {
    const registry = createBackgroundRegistry();
    expect(() => registry.complete("nope")).not.toThrow();
    expect(registry.count()).toBe(0);
  });

  it("cancelAll invokes every registered cancel and clears the registry", () => {
    const registry = createBackgroundRegistry();
    const cancelled: string[] = [];
    registry.register("t1", () => cancelled.push("t1"));
    registry.register("t2", () => cancelled.push("t2"));
    registry.cancelAll();
    expect(cancelled.sort()).toEqual(["t1", "t2"]);
    expect(registry.count()).toBe(0);
  });

  it("cancelAll continues past a throwing cancel handle", () => {
    const registry = createBackgroundRegistry();
    const cancelled: string[] = [];
    registry.register("t1", () => {
      throw new Error("boom");
    });
    registry.register("t2", () => cancelled.push("t2"));
    expect(() => registry.cancelAll()).not.toThrow();
    expect(cancelled).toEqual(["t2"]);
    expect(registry.count()).toBe(0);
  });
});
