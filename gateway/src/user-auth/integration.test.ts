import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { NEVER_REVOKED, createCredentialFloor } from "./credential-floor.js";
import { getUsersJsonPath } from "./paths.js";
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
    const tokens = createTokenService({ secret, ttlSeconds: 3600, credentialFloor: createCredentialFloor(store) });

    const pinHash = await hashPin("1234", { memoryKb: 8192, iterations: 1, parallelism: 1 });
    const kevin: UserRecord = {
      userId: "kevin",
      displayName: "Kevin",
      pinHash,
      role: "admin",
      avatarTint: "terra",
      createdAt: new Date().toISOString(),
      credentialsValidFrom: NEVER_REVOKED,
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
      credentialsValidFrom: NEVER_REVOKED,
    });
    const got = await store.get("kevin");
    if (!got.ok || !got.value) throw new Error("unreachable");
    const ok = await verifyPin("9999", got.value.pinHash);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — A ROLE CHANGE REVOKES THE ACCOUNT'S CREDENTIALS.
//
// The token identifies and never authorizes, so demoting an admin already
// closes the REST surface on the next request. This closes the other half: the
// credential the demoted account is holding stops validating AT ALL, so its
// live WebSocket is kicked to the login screen and the next sign-in mints both
// a fresh token and a fresh principal. No rebind of a frozen principal, no
// mutable authority — the whole authenticated context is destroyed and rebuilt
// from the record.
// ---------------------------------------------------------------------------
describe("a role change revokes the account's credentials", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-revoke-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  const KEVIN: UserRecord = {
    userId: "kevin",
    displayName: "Kevin",
    pinHash: "$argon2id$fake",
    role: "admin",
    avatarTint: "terra",
    createdAt: "2026-04-24T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };

  async function tokenServiceOver(store: ReturnType<typeof createUserStore>) {
    return createTokenService({
      secret: await loadOrCreateAuthSecret(),
      ttlSeconds: 3600,
      credentialFloor: createCredentialFloor(store),
    });
  }

  // THE HEADLINE. One token, minted while Kevin was an admin. Nothing is
  // refreshed, re-logged-in or flushed between the two validate() calls — the
  // only thing that changes is the record.
  it("SECURITY: a token minted before the demotion stops validating, with no refresh or re-login", async () => {
    const store = createUserStore();
    const tokens = await tokenServiceOver(store);
    await store.add(KEVIN);

    const token = await tokens.issue({ userId: "kevin" });
    expect((await tokens.validate(token)).ok).toBe(true);

    // Exactly the patch setRoleFlow writes: the role and the floor, together.
    await store.update("kevin", { role: "adult", credentialsValidFrom: new Date().toISOString() });

    expect(await tokens.validate(token)).toEqual({ ok: false, error: "expired" });
  });

  it("SECURITY: a token naming a deleted user is refused, not resolved against a default floor", async () => {
    const store = createUserStore();
    const tokens = await tokenServiceOver(store);
    await store.add(KEVIN);
    const token = await tokens.issue({ userId: "kevin" });

    await store.remove("kevin");

    expect(await tokens.validate(token)).toEqual({ ok: false, error: "expired" });
  });

  // THE UPGRADE CASE. Records written before this field existed carry no
  // `credentialsValidFrom`; they read as `createdAt`, which is what "no
  // revocation has ever happened" means for them. Reading them as `now` would
  // log out every account in the household on the upgrade.
  it("accepts a live token against a record stored before the credential floor existed", async () => {
    const store = createUserStore();
    const tokens = await tokenServiceOver(store);
    await store.add(KEVIN);
    stripCredentialFloorFromDisk();

    const token = await tokens.issue({ userId: "kevin" });

    expect((await tokens.validate(token)).ok).toBe(true);
  });

  /** Rewrites users.json in the pre-field shape — what an install that predates
   *  this change actually has on disk. */
  function stripCredentialFloorFromDisk(): void {
    const path = getUsersJsonPath();
    const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
    for (const row of rows) {
      // biome-ignore lint/performance/noDelete: modelling a key that was never written
      delete row.credentialsValidFrom;
    }
    writeFileSync(path, JSON.stringify(rows, null, 2));
  }
});
