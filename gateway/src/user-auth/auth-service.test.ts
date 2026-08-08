import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, reset } from "@logtape/logtape";
import type { AuthConfig } from "@sentient/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthService } from "./auth-service.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

describe("createAuthService", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authsvc-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("createUser stores the user with hashed pin", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "admin",
      avatarTint: "terra",
    });
    expect(r.ok).toBe(true);
    const got = await svc.users.get("kevin");
    expect(got.ok).toBe(true);
    if (!got.ok || !got.value) throw new Error("unreachable");
    expect(got.value.pinHash).toMatch(/^\$argon2id\$/);
    expect(got.value.pinHash).not.toBe("1234");
  });

  it("authenticate with correct pin issues a valid token", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    const r = await svc.authenticate("kevin", "1234");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const valid = await svc.tokens.validate(r.value.token);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("unreachable");
    expect(valid.value.userId).toBe("kevin");
    expect(valid.value.role).toBe("adult");
  });

  it("authenticate with wrong pin returns invalid-credentials", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "admin",
      avatarTint: "terra",
    });
    const r = await svc.authenticate("kevin", "9999");
    expect(r).toEqual({ ok: false, error: "invalid-credentials" });
  });

  it("authenticate with unknown user returns invalid-credentials", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.authenticate("ghost", "1234");
    expect(r).toEqual({ ok: false, error: "invalid-credentials" });
  });

  it("createUser rejects duplicate userId", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const a: Parameters<typeof svc.createUser>[0] = {
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "admin",
      avatarTint: "terra",
    };
    await svc.createUser(a);
    const r = await svc.createUser(a);
    expect(r).toEqual({ ok: false, error: "already-exists" });
  });

  it("listUsersPublic returns userId/displayName/avatarTint without pinHash", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "admin",
      avatarTint: "terra",
    });
    const r = await svc.listUsersPublic();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toEqual([{ userId: "kevin", displayName: "Kevin", avatarTint: "terra" }]);
    for (const u of r.value as unknown as Array<Record<string, unknown>>) {
      expect("pinHash" in u).toBe(false);
      expect("role" in u).toBe(false);
    }
  });

  it("isFirstRun is true when users.json is empty, false after createUser", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    expect(await svc.isFirstRun()).toBe(true);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "admin",
      avatarTint: "terra",
    });
    expect(await svc.isFirstRun()).toBe(false);
  });

  it("updateDisplayName persists the new name and returns the updated record", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    const r = await svc.updateDisplayName("kevin", "Kevin Updated");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.displayName).toBe("Kevin Updated");
    expect(r.value.userId).toBe("kevin");
    const got = await svc.users.get("kevin");
    expect(got.ok && got.value?.displayName).toBe("Kevin Updated");
  });

  it("updateDisplayName returns not-found for unknown userId", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.updateDisplayName("ghost", "Ghost");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("changePin succeeds when currentPin is correct and updates the hash", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    const r = await svc.changePin("kevin", "1234", "5678");
    expect(r).toEqual({ ok: true, value: undefined });
    const auth = await svc.authenticate("kevin", "5678");
    expect(auth.ok).toBe(true);
    const authOld = await svc.authenticate("kevin", "1234");
    expect(authOld.ok).toBe(false);
  });

  it("changePin returns wrong-pin when currentPin does not match", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    const r = await svc.changePin("kevin", "9999", "5678");
    expect(r).toEqual({ ok: false, error: "wrong-pin" });
  });

  it("changePin returns not-found for unknown userId", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.changePin("ghost", "1234", "5678");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("updateDisplayName returns io-error when UserStore.update fails", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    // Remove write permission from dir: reads (r-x) still work but creating .tmp fails
    chmodSync(root, 0o555);
    const r = await svc.updateDisplayName("kevin", "Kevin Updated");
    chmodSync(root, 0o755);
    expect(r).toEqual({ ok: false, error: "io-error" });
  });

  it("changePin returns io-error when UserStore.update fails", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      role: "adult",
      avatarTint: "sage",
    });
    // Remove write permission from dir: reads (r-x) still work but creating .tmp fails
    chmodSync(root, 0o555);
    const r = await svc.changePin("kevin", "1234", "5678");
    chmodSync(root, 0o755);
    expect(r).toEqual({ ok: false, error: "io-error" });
  });
});

// ---------------------------------------------------------------------------
// D20 — a rejected credential used to leave no trace at all: both failure
// branches (`authenticate.no-user`, `authenticate.wrong-pin`) logged at
// DEBUG while the running level is `info` (also the documented prod
// default), so a wrong PIN produced a correct 401 and NOTHING in the gateway
// log. Repeated PIN guessing against a household assistant was invisible.
// Pinned at WARN here — a rejected credential is exactly the "boundary
// decision with a reason" the logging rules require at that level.
//
// Captures the RAW logtape record (not the sanitizer's output) so this pins
// the source call site itself never passing the pin into log properties —
// not merely that the sanitizer would have redacted it downstream.
// ---------------------------------------------------------------------------
describe("createAuthService — failed logins are logged (D20)", () => {
  const AUTH_SERVICE_CATEGORY = ["sentient", "gateway", "user-auth", "auth-service"];
  let root: string;
  let warnings: Array<Record<string, unknown>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sentient-authsvc-log-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    warnings = [];
    await configure({
      sinks: {
        test: (record) => {
          if (record.level === "warning") warnings.push(record.properties);
        },
      },
      loggers: [
        { category: AUTH_SERVICE_CATEGORY, sinks: ["test"], lowestLevel: "debug" },
        // Suppresses LogTape's own one-time "loggers are configured" meta
        // notice, which otherwise prints straight to the console on every
        // `configure()` call in this file's beforeEach.
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });
  });

  afterEach(async () => {
    await reset();
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("SECURITY: an unknown-user login is logged at WARN with a reason, never the pin", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.authenticate("u_nope", "9999");
    expect(warnings).toContainEqual(expect.objectContaining({ userId: "u_nope", reason: expect.any(String) }));
    expect(JSON.stringify(warnings)).not.toContain("9999");
  });

  it("SECURITY: a wrong-pin login is logged at WARN with a reason, never the pin", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({ userId: "kevin", displayName: "Kevin", pin: "1234", role: "adult", avatarTint: "sage" });
    warnings = []; // createUser logs at INFO, not WARN, but clear defensively
    await auth.authenticate("kevin", "9999");
    expect(warnings).toContainEqual(expect.objectContaining({ userId: "kevin", reason: expect.any(String) }));
    const dump = JSON.stringify(warnings);
    expect(dump).not.toContain("9999");
    expect(dump).not.toContain("1234");
  });

  it("the no-user and wrong-pin reasons are distinguishable", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({ userId: "kevin", displayName: "Kevin", pin: "1234", role: "adult", avatarTint: "sage" });
    await auth.authenticate("u_ghost", "0000");
    await auth.authenticate("kevin", "9999");
    expect(warnings).toHaveLength(2);
    const reasons = warnings.map((w) => w.reason);
    expect(new Set(reasons).size).toBe(2);
  });

  it("a successful login does not log at WARN", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({ userId: "kevin", displayName: "Kevin", pin: "1234", role: "adult", avatarTint: "sage" });
    warnings = [];
    const r = await auth.authenticate("kevin", "1234");
    expect(r.ok).toBe(true);
    expect(warnings).toEqual([]);
  });
});
