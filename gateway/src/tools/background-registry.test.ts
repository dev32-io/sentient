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
});
