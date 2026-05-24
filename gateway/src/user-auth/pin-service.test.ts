import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "./pin-service.js";

const PARAMS = { memoryKb: 8192, iterations: 1, parallelism: 1 };

describe("pin-service", () => {
  it("hashPin returns an argon2id-formatted string", async () => {
    const hash = await hashPin("1234", PARAMS);
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("verifyPin returns true for the original pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("1234", hash);
    expect(ok).toBe(true);
  });

  it("verifyPin returns false for a wrong pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("9999", hash);
    expect(ok).toBe(false);
  });

  it("hashPin yields different hashes for the same pin (random salt)", async () => {
    const a = await hashPin("1234", PARAMS);
    const b = await hashPin("1234", PARAMS);
    expect(a).not.toBe(b);
  });

  it("verifyPin returns false for a malformed hash", async () => {
    const ok = await verifyPin("1234", "not-a-hash");
    expect(ok).toBe(false);
  });

  it("verifyPin returns false on empty pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("", hash);
    expect(ok).toBe(false);
  });
});
