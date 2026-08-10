import { describe, expect, it } from "bun:test";
import { createUserPrincipal } from "./user-principal.js";

describe("UserPrincipal", () => {
  it("rejects a malformed userId at construction", () => {
    expect(() => createUserPrincipal("nope", "adult", "home")).toThrow(/invalid userId/);
    expect(() => createUserPrincipal("u_ABCDEF12", "adult", "home")).toThrow(/invalid userId/);
  });

  it("constructs with a valid userId and exposes readonly identity", () => {
    const p = createUserPrincipal("u_a1b2c3d4", "adult", "home");
    expect(p.userId).toBe("u_a1b2c3d4");
    expect(p.role).toBe("adult");
    expect(p.householdId).toBe("home");
  });

  it("is frozen — identity cannot be mutated after minting", () => {
    const p = createUserPrincipal("u_a1b2c3d4", "child", "home");
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      (p as { userId: string }).userId = "u_ffffffff";
    }).toThrow();
  });
});
