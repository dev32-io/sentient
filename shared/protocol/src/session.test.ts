import { describe, expect, it } from "vitest";
import { sessionSchema } from "./session.ts";

describe("sessionSchema", () => {
  it("accepts valid session", () => {
    const result = sessionSchema.safeParse({
      sessionId: "s-abc123",
      userId: "user-1",
      role: "adult",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty sessionId", () => {
    const result = sessionSchema.safeParse({
      sessionId: "",
      userId: "user-1",
      role: "adult",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = sessionSchema.safeParse({
      sessionId: "s-abc123",
      userId: "user-1",
      role: "superadmin",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(false);
  });
});
