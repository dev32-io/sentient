import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateAuthSecret } from "./auth-secret.js";

describe("loadOrCreateAuthSecret", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-secret-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_AUTH_SECRET_KEY_BASE64;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_AUTH_SECRET_KEY_BASE64;
  });

  it("generates a new 32-byte key when none exists", async () => {
    const key = await loadOrCreateAuthSecret();
    expect(key.length).toBe(32);
    expect(existsSync(join(root, "auth-secret.key"))).toBe(true);
  });

  it("the persisted key file is chmod 0600", async () => {
    await loadOrCreateAuthSecret();
    const mode = statSync(join(root, "auth-secret.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same key across calls", async () => {
    const a = await loadOrCreateAuthSecret();
    const b = await loadOrCreateAuthSecret();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("honors SENTIENT_AUTH_SECRET_KEY_BASE64 env override", async () => {
    const override = Buffer.alloc(32, 0xab);
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = override.toString("base64");
    const key = await loadOrCreateAuthSecret();
    expect(Buffer.from(key).equals(override)).toBe(true);
    expect(existsSync(join(root, "auth-secret.key"))).toBe(false);
  });

  it("rejects a base64 env key that isn't 32 bytes", async () => {
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = Buffer.alloc(16).toString("base64");
    await expect(loadOrCreateAuthSecret()).rejects.toThrow(/32 bytes/);
  });

  it("rejects a malformed base64 env value", async () => {
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = "not-valid-base64-at-all!!!!";
    await expect(loadOrCreateAuthSecret()).rejects.toThrow();
  });
});
