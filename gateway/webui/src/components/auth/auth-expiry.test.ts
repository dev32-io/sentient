import { describe, expect, it, vi } from "vitest";
import { markAuthExpired, takeAuthExpired } from "./auth-expiry.ts";

describe("auth expiry notice", () => {
  it("survives the authenticated shell teardown and is consumed once", () => {
    let value: string | null = null;
    const storage = {
      setItem: vi.fn((_key: string, next: string) => {
        value = next;
      }),
      getItem: vi.fn(() => value),
      removeItem: vi.fn(() => {
        value = null;
      }),
    };
    markAuthExpired(storage);
    expect(takeAuthExpired(storage)).toBe(true);
    expect(takeAuthExpired(storage)).toBe(false);
  });
});
