import { describe, expect, it } from "vitest";
import { USER_ROLES, canExecute, userRoleSchema } from "./roles.ts";

describe("canExecute", () => {
  it("allows admin every tier, including the admin tier", () => {
    expect(canExecute("admin", "read")).toBe(true);
    expect(canExecute("admin", "write")).toBe(true);
    expect(canExecute("admin", "confirm")).toBe(true);
    expect(canExecute("admin", "admin")).toBe(true);
  });

  it("allows adult everything below the admin tier", () => {
    expect(canExecute("adult", "read")).toBe(true);
    expect(canExecute("adult", "write")).toBe(true);
    expect(canExecute("adult", "confirm")).toBe(true);
  });

  it("keeps the admin tier reachable by the admin role and nobody else", () => {
    const reach = USER_ROLES.filter((role) => canExecute(role, "admin"));
    expect(reach).toEqual(["admin"]);
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
    expect(userRoleSchema.parse("admin")).toBe("admin");
    expect(userRoleSchema.parse("adult")).toBe("adult");
    expect(userRoleSchema.parse("child")).toBe("child");
    expect(userRoleSchema.parse("guest")).toBe("guest");
  });

  it("rejects invalid roles", () => {
    expect(() => userRoleSchema.parse("superadmin")).toThrow();
    expect(() => userRoleSchema.parse("")).toThrow();
  });
});
