import { describe, expect, it } from "vitest";
import { canExecute, userRoleSchema } from "./roles.ts";

describe("canExecute", () => {
  it("allows adult all tiers", () => {
    expect(canExecute("adult", "read")).toBe(true);
    expect(canExecute("adult", "admin")).toBe(true);
  });

  it("blocks child from confirm and admin", () => {
    expect(canExecute("child", "read")).toBe(true);
    expect(canExecute("child", "write")).toBe(true);
    expect(canExecute("child", "confirm")).toBe(false);
    expect(canExecute("child", "admin")).toBe(false);
  });

  it("limits guest to read only", () => {
    expect(canExecute("guest", "read")).toBe(true);
    expect(canExecute("guest", "write")).toBe(false);
    expect(canExecute("guest", "confirm")).toBe(false);
    expect(canExecute("guest", "admin")).toBe(false);
  });
});

describe("userRoleSchema", () => {
  it("accepts valid roles", () => {
    expect(userRoleSchema.parse("adult")).toBe("adult");
    expect(userRoleSchema.parse("child")).toBe("child");
    expect(userRoleSchema.parse("guest")).toBe("guest");
  });

  it("rejects invalid roles", () => {
    expect(() => userRoleSchema.parse("superadmin")).toThrow();
    expect(() => userRoleSchema.parse("")).toThrow();
  });
});
