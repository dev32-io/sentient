import { describe, expect, it } from "vitest";
import { sanitizeMessage, sanitizeProperties, sanitizeValue } from "./log-sanitizer.js";

describe("sanitizeValue", () => {
  it("redacts token keys", () => {
    expect(sanitizeValue("token", "abc123")).toBe("[REDACTED]");
  });

  it("redacts apikey keys", () => {
    expect(sanitizeValue("apikey", "sk-12345")).toBe("[REDACTED]");
  });

  it("redacts api_key keys", () => {
    expect(sanitizeValue("api_key", "sk-12345")).toBe("[REDACTED]");
  });

  it("redacts secret keys", () => {
    expect(sanitizeValue("secret", "mysecret")).toBe("[REDACTED]");
  });

  it("redacts password keys", () => {
    expect(sanitizeValue("password", "hunter2")).toBe("[REDACTED]");
  });

  it("redacts authorization keys", () => {
    expect(sanitizeValue("authorization", "Bearer xyz")).toBe("[REDACTED]");
  });

  it("redacts pin keys", () => {
    expect(sanitizeValue("pin", "1234")).toBe("[REDACTED]");
  });

  it("redacts paseto keys", () => {
    expect(sanitizeValue("paseto", "v4.local.abc")).toBe("[REDACTED]");
  });

  it("matches keys case-insensitively", () => {
    expect(sanitizeValue("TOKEN", "abc")).toBe("[REDACTED]");
    expect(sanitizeValue("ApiKey", "abc")).toBe("[REDACTED]");
    expect(sanitizeValue("API_KEY", "abc")).toBe("[REDACTED]");
    expect(sanitizeValue("Authorization", "abc")).toBe("[REDACTED]");
    expect(sanitizeValue("PASETO", "abc")).toBe("[REDACTED]");
  });

  it("passes safe values through unchanged", () => {
    expect(sanitizeValue("name", "alice")).toBe("alice");
    expect(sanitizeValue("count", 42)).toBe(42);
    expect(sanitizeValue("active", true)).toBe(true);
  });

  it("passes non-string values through even for sensitive keys", () => {
    expect(sanitizeValue("token", 42)).toBe("[REDACTED]");
    expect(sanitizeValue("password", null)).toBe("[REDACTED]");
  });
});

describe("sanitizeMessage", () => {
  it("scrubs PASETO tokens from messages", () => {
    const msg = "auth failed for v4.local.abc123def456 user";
    expect(sanitizeMessage(msg)).toBe("auth failed for [REDACTED] user");
  });

  it("scrubs Bearer tokens from messages", () => {
    const msg = "header: Bearer eyJhbGciOiJIUzI1NiJ9 sent";
    expect(sanitizeMessage(msg)).toBe("header: [REDACTED] sent");
  });

  it("scrubs multiple patterns in one message", () => {
    const msg = "token=v4.local.xyz auth=Bearer abc123";
    expect(sanitizeMessage(msg)).toBe("token=[REDACTED] auth=[REDACTED]");
  });

  it("returns safe messages unchanged", () => {
    const msg = "user connected from 192.168.1.1";
    expect(sanitizeMessage(msg)).toBe(msg);
  });
});

describe("sanitizeProperties", () => {
  it("redacts sensitive keys in properties", () => {
    const props = { token: "abc", name: "alice", apikey: "sk-123" };
    const result = sanitizeProperties(props);
    expect(result).toEqual({
      token: "[REDACTED]",
      name: "alice",
      apikey: "[REDACTED]",
    });
  });

  it("does not mutate original properties", () => {
    const original = { token: "abc", name: "alice" };
    sanitizeProperties(original);
    expect(original.token).toBe("abc");
  });

  it("returns empty object for empty input", () => {
    expect(sanitizeProperties({})).toEqual({});
  });

  it("handles nested string values by scrubbing patterns", () => {
    const props = { header: "Bearer secret123" };
    const result = sanitizeProperties(props);
    expect(result.header).toBe("[REDACTED]");
  });
});
