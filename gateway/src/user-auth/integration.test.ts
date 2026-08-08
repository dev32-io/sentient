import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { hashPin, verifyPin } from "./pin-service.js";
import { createTokenService } from "./token-service.js";
import type { UserRecord } from "./types.js";
import { createUserStore } from "./user-store.js";

describe("phase-0 primitives compose end-to-end", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-p0-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("create user → login with correct PIN → issue token → validate token", async () => {
    const store = createUserStore();
    const secret = await loadOrCreateAuthSecret();
    const tokens = createTokenService({ secret, ttlSeconds: 3600 });

    const pinHash = await hashPin("1234", { memoryKb: 8192, iterations: 1, parallelism: 1 });
    const kevin: UserRecord = {
      userId: "kevin",
      displayName: "Kevin",
      pinHash,
      role: "admin",
      avatarTint: "terra",
      createdAt: new Date().toISOString(),
    };
    const add = await store.add(kevin);
    expect(add.ok).toBe(true);

    const fetched = await store.get("kevin");
    expect(fetched.ok && fetched.value).not.toBeNull();
    if (!fetched.ok || !fetched.value) throw new Error("unreachable");
    const pinOk = await verifyPin("1234", fetched.value.pinHash);
    expect(pinOk).toBe(true);
    const token = await tokens.issue({ userId: fetched.value.userId });

    const valid = await tokens.validate(token);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("unreachable");
    expect(valid.value.userId).toBe("kevin");
    expect(valid.value.expiresAt).toBeGreaterThan(valid.value.issuedAt);
  });

  it("login with wrong PIN does not issue a token", async () => {
    const store = createUserStore();
    const pinHash = await hashPin("1234", { memoryKb: 8192, iterations: 1, parallelism: 1 });
    await store.add({
      userId: "kevin",
      displayName: "Kevin",
      pinHash,
      role: "admin",
      avatarTint: "terra",
      createdAt: "2026-04-24T00:00:00.000Z",
    });
    const got = await store.get("kevin");
    if (!got.ok || !got.value) throw new Error("unreachable");
    const ok = await verifyPin("9999", got.value.pinHash);
    expect(ok).toBe(false);
  });
});
