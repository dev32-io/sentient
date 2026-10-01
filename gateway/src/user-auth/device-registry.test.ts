import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { loadDeviceEscrowKey } from "./device-escrow-key.js";
import { type DeviceProof, type DeviceRegistryOptions, createDeviceRegistry } from "./device-registry.js";
import { createTokenService } from "./token-service.js";
import { createUserStore } from "./user-store.js";

const secret = () => randomBytes(32).toString("base64url");
let root: string;
let previousRoot: string | undefined;
let opts: DeviceRegistryOptions;
let registry: ReturnType<typeof createDeviceRegistry>;
let users: ReturnType<typeof createUserStore>;
const cap = (userId = "u_00000001", role: "adult" | "child" = "adult") =>
  createAccessManager({ userDataRoot: "/unused" }).grant(createUserPrincipal(userId, role, "home"), "device-registry");
const request = () => ({
  version: 1 as const,
  deviceId: randomUUID(),
  attemptId: randomUUID(),
  enrollmentSecret: secret(),
  managerSecret: secret(),
});
function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "device-registry-"));
  previousRoot = process.env.SENTIENT_GATEWAY_ROOT;
  process.env.SENTIENT_GATEWAY_ROOT = root;
  users = createUserStore();
  for (const userId of ["u_00000001", "u_00000002"])
    value(
      await users.add({
        userId,
        displayName: "Test",
        pinHash: "unused",
        role: "adult",
        avatarTint: "sage",
        createdAt: new Date().toISOString(),
        credentialsValidFrom: "1970-01-01T00:00:00.000Z",
      }),
    );
  opts = {
    path: join(root, "devices.db"),
    users,
    accessKey: randomBytes(32),
    escrowKey: randomBytes(32),
    accessTtlSeconds: 60,
    attemptTtlSeconds: 60,
  };
  registry = createDeviceRegistry(opts);
});
afterEach(() => {
  registry.close();
  if (previousRoot === undefined) {
    // biome-ignore lint/performance/noDelete: restore environment
    delete process.env.SENTIENT_GATEWAY_ROOT;
  } else process.env.SENTIENT_GATEWAY_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
async function committed() {
  const input = request();
  const begun = value(await registry.begin(cap(), input));
  const proof: DeviceProof = {
    version: 1,
    deviceId: input.deviceId,
    attemptId: input.attemptId,
    generation: begun.generation,
    renewalSecret: secret(),
  };
  value(await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret }));
  return { input, proof };
}

it("serializes competing claims, binds retry material, and never releases ownership on disable", async () => {
  const input = request();
  const otherHandle = createDeviceRegistry(opts);
  try {
    const results = await Promise.all([registry.begin(cap(), input), otherHandle.begin(cap("u_00000002"), input)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const owner = results[0]?.ok ? cap() : cap("u_00000002");
    expect(value(await registry.begin(owner, input)).generation).toBe(1);
    expect(await registry.begin(owner, { ...input, managerSecret: secret() })).toEqual({
      ok: false,
      error: "conflict",
    });
    value(await registry.disable(owner, input.deviceId));
    expect(await registry.begin(owner, input)).toEqual({ ok: false, error: "denied" });
    expect(value(await registry.recover(owner, input.deviceId)).status).toBe("disabled");
    const foreign = owner.ownerUserId === "u_00000001" ? cap("u_00000002") : cap();
    expect(await registry.begin(foreign, { ...input, attemptId: randomUUID() })).toEqual({
      ok: false,
      error: "denied",
    });
    expect(value(await registry.begin(owner, { ...input, attemptId: randomUUID() })).generation).toBe(2);
  } finally {
    otherHandle.close();
  }
});

it("recovers lost committed and activated responses after restart without storing plaintext proofs", async () => {
  const { input, proof } = await committed();
  registry.close();
  registry = createDeviceRegistry(opts);
  const pending = value(await registry.renew(proof));
  expect(pending.status).toBe("committed");
  expect(pending.token).toBeUndefined();
  expect(value(await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret })).status).toBe("committed");
  expect(
    await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret, renewalSecret: secret() }),
  ).toEqual({ ok: false, error: "conflict" });
  const active = value(await registry.activate(proof));
  registry.close();
  registry = createDeviceRegistry(opts);
  expect(value(await registry.activate(proof)).status).toBe("active");
  expect(value(await registry.validate(active.token)).deviceClass).toBe("cube");
  expect(typeof value(await registry.renew(proof)).token).toBe("string");
  const disk = readFileSync(opts.path);
  for (const material of [input.enrollmentSecret, input.managerSecret, proof.renewalSecret])
    expect(disk.includes(Buffer.from(material))).toBe(false);
  expect(value(await registry.recover(cap(), input.deviceId)).managerSecret).toBe(input.managerSecret);
});

it("keeps human purposes isolated and denies foreign recovery and non-registry grants", async () => {
  const { input, proof } = await committed();
  const device = value(await registry.activate(proof));
  const human = createTokenService({
    secret: opts.accessKey,
    ttlSeconds: 60,
    credentialFloor: { validFromMsFor: async () => 0 },
  });
  expect(await human.validate(device.token)).toEqual({ ok: false, error: "wrong-purpose" });
  expect(await registry.validate(await human.issue({ userId: "u_00000001" }))).toEqual({ ok: false, error: "denied" });
  expect(await registry.recover(cap("u_00000002"), input.deviceId)).toEqual({ ok: false, error: "denied" });
  expect(await registry.begin({ ...cap(), resource: "tool-broker" }, request())).toEqual({
    ok: false,
    error: "denied",
  });
  expect(await registry.renew({ ...proof, generation: 2 })).toEqual({ ok: false, error: "denied" });
});

it("disable fences tokens and proofs; recovery alone never reactivates; fresh generation invalidates old proofs", async () => {
  const { input, proof } = await committed();
  const active = value(await registry.activate(proof));
  value(await registry.disable(cap(), input.deviceId));
  value(await registry.recover(cap(), input.deviceId));
  expect(await registry.validate(active.token)).toEqual({ ok: false, error: "denied" });
  expect(await registry.renew(proof)).toEqual({ ok: false, error: "denied" });
  expect(await registry.activate(proof)).toEqual({ ok: false, error: "denied" });
  const next = value(await registry.begin(cap(), { ...input, attemptId: randomUUID() }));
  expect(next.generation).toBe(2);
  expect(await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret })).toEqual({
    ok: false,
    error: "denied",
  });
});

it("PIN floor leaves pairing intact; role round-trip suspends until explicit re-enrollment", async () => {
  const { proof } = await committed();
  const active = value(await registry.activate(proof));
  value(await users.update("u_00000001", { pinHash: "new", credentialsValidFrom: new Date().toISOString() }));
  expect((await registry.validate(active.token)).ok).toBe(true);
  value(await users.update("u_00000001", { role: "child" }));
  expect((await registry.renew(proof)).ok).toBe(false);
  value(await users.update("u_00000001", { role: "adult" }));
  expect((await registry.validate(active.token)).ok).toBe(false);
  expect((await registry.renew(proof)).ok).toBe(false);
});

it("account deletion denies use and purges escrow while retaining nontransferable tombstone", async () => {
  const { input, proof } = await committed();
  const active = value(await registry.activate(proof));
  expect((await registry.purgeDeletedOwner("u_00000001")).ok).toBe(false);
  value(await users.remove("u_00000001"));
  expect((await registry.validate(active.token)).ok).toBe(false);
  expect((await registry.renew(proof)).ok).toBe(false);
  expect((await registry.recover(cap(), input.deviceId)).ok).toBe(false);
  value(await registry.purgeDeletedOwner("u_00000001"));
  expect((await registry.begin(cap("u_00000002"), { ...input, attemptId: randomUUID() })).ok).toBe(false);
});

it("rejects a wrong same-length 0600 key before renewal or new enrollment; restored key recovers", async () => {
  const { input, proof } = await committed();
  const active = value(await registry.activate(proof));
  const keyPath = join(root, "escrow.key");
  const originalKey = Buffer.from(opts.escrowKey);
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  expect(() => createDeviceRegistry({ ...opts, escrowKey: new Uint8Array() })).toThrow();
  expect(() => createDeviceRegistry({ ...opts, escrowKey: opts.accessKey })).toThrow();
  registry.close();
  // Wrong backup passed file validation before this repair, then could issue
  // tokens and seal new devices under a different key.
  const wrongKey = await loadDeviceEscrowKey(keyPath, opts.path);
  expect(() => createDeviceRegistry({ ...opts, escrowKey: wrongKey })).toThrow("device registry initialization failed");
  writeFileSync(keyPath, originalKey);
  registry = createDeviceRegistry({ ...opts, escrowKey: await loadDeviceEscrowKey(keyPath, opts.path) });
  expect(value(await registry.renew(proof)).token).toBeDefined();
  expect(value(await registry.recover(cap(), input.deviceId)).managerSecret).toBe(input.managerSecret);
  expect(value(await registry.begin(cap(), request())).generation).toBe(1);
  expect(value(await registry.validate(active.token)).deviceId).toBe(input.deviceId);
});

it("rejects corrupt retained escrow at restart but keeps runtime corruption recoverable after repair", async () => {
  const other = await committed();
  const { input } = await committed();
  const db = new Database(opts.path);
  const row = db
    .query<{ record: string }, [string]>("SELECT record FROM devices_v1 WHERE device_id = ?")
    .get(input.deviceId);
  if (!row) throw new Error("missing fixture");
  const corrupted = JSON.parse(row.record);
  corrupted.escrow = "corrupt";
  try {
    db.query("UPDATE devices_v1 SET record = ? WHERE device_id = ?").run(JSON.stringify(corrupted), input.deviceId);
    expect(await registry.recover(cap(), input.deviceId)).toEqual({ ok: false, error: "escrow-unavailable" });
    registry.close();
    expect(() => createDeviceRegistry(opts)).toThrow("device registry initialization failed");
  } finally {
    db.query("UPDATE devices_v1 SET record = ? WHERE device_id = ?").run(row.record, input.deviceId);
    db.close();
  }
  registry = createDeviceRegistry(opts);
  expect(value(await registry.recover(cap(), input.deviceId)).managerSecret).toBe(input.managerSecret);
  expect(value(await registry.recover(cap(), other.input.deviceId)).managerSecret).toBe(other.input.managerSecret);
});

it("ignores empty deletion tombstones on restart, without releasing their claims", async () => {
  const { input } = await committed();
  value(await users.remove("u_00000001"));
  value(await registry.purgeDeletedOwner("u_00000001"));
  registry.close();
  registry = createDeviceRegistry({ ...opts, escrowKey: randomBytes(32) });
  expect(await registry.begin(cap("u_00000002"), { ...input, attemptId: randomUUID() })).toEqual({
    ok: false,
    error: "denied",
  });
});

it("validates version and bounded secret input before reserving hardware", async () => {
  expect(await registry.begin(cap(), { ...request(), version: 2 } as never)).toEqual({
    ok: false,
    error: "invalid-request",
  });
  expect(await registry.begin(cap(), { ...request(), managerSecret: "short" })).toEqual({
    ok: false,
    error: "invalid-request",
  });
  expect(value(await registry.list(cap()))).toEqual([]);
});

it("expires uncommitted attempts but renews offline-expired access with the durable proof", async () => {
  registry.close();
  registry = createDeviceRegistry({ ...opts, attemptTtlSeconds: 1, accessTtlSeconds: 1 });
  const expired = request();
  const begun = value(await registry.begin(cap(), expired));
  const { proof } = await committed();
  const active = value(await registry.activate(proof));
  const unactivated = await committed();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await registry.begin(cap(), expired)).toEqual({ ok: false, error: "expired" });
  expect(
    await registry.redeem({
      version: 1,
      deviceId: expired.deviceId,
      attemptId: expired.attemptId,
      generation: begun.generation,
      enrollmentSecret: expired.enrollmentSecret,
      renewalSecret: secret(),
    }),
  ).toEqual({ ok: false, error: "expired" });
  expect((await registry.validate(active.token)).ok).toBe(false);
  expect(value(await registry.renew(proof)).token).toBeDefined();
  expect(value(await registry.activate(proof)).status).toBe("active");
  // Attempt expiry fences first redemption only, not durable committed retry.
  expect(
    value(await registry.redeem({ ...unactivated.proof, enrollmentSecret: unactivated.input.enrollmentSecret })).status,
  ).toBe("committed");
  expect(value(await registry.activate(unactivated.proof)).status).toBe("active");
});

it("failed credential commit is retryable and failed activation never reports success", async () => {
  const input = request();
  const begun = value(await registry.begin(cap(), input));
  registry.close();
  registry = createDeviceRegistry(opts);
  expect(value(await registry.begin(cap(), input))).toEqual(begun);
  const proof: DeviceProof = {
    version: 1,
    deviceId: input.deviceId,
    attemptId: input.attemptId,
    generation: begun.generation,
    renewalSecret: secret(),
  };
  const db = new Database(opts.path);
  try {
    db.exec(
      "CREATE TRIGGER fail_write BEFORE UPDATE ON devices_v1 BEGIN SELECT RAISE(ABORT, 'test-write-failure'); END",
    );
    await expect(registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret })).rejects.toThrow(
      "test-write-failure",
    );
    expect((await registry.renew(proof)).ok).toBe(false);
    expect(value(await registry.list(cap()))[0]?.status).toBe("pending");
    db.exec("DROP TRIGGER fail_write");
    value(await registry.redeem({ ...proof, enrollmentSecret: input.enrollmentSecret }));
    db.exec(
      "CREATE TRIGGER fail_write BEFORE UPDATE ON devices_v1 BEGIN SELECT RAISE(ABORT, 'test-write-failure'); END",
    );
    await expect(registry.activate(proof)).rejects.toThrow("test-write-failure");
    expect(value(await registry.renew(proof)).token).toBeUndefined();
    db.exec("DROP TRIGGER fail_write");
    expect(value(await registry.activate(proof)).token).toBeDefined();
  } finally {
    db.close();
  }
});

it("escrow cannot be swapped between devices and re-enrollment preserves existing offline manager", async () => {
  const first = await committed();
  const second = await committed();
  value(await registry.disable(cap(), first.input.deviceId));
  expect(await registry.begin(cap(), { ...first.input, attemptId: randomUUID(), managerSecret: secret() })).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(value(await registry.recover(cap(), first.input.deviceId)).managerSecret).toBe(first.input.managerSecret);
  const db = new Database(opts.path);
  try {
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM devices_v1 WHERE device_id = ?")
      .get(first.input.deviceId);
    const other = db
      .query<{ record: string }, [string]>("SELECT record FROM devices_v1 WHERE device_id = ?")
      .get(second.input.deviceId);
    if (!row || !other) throw new Error("missing fixture");
    const record = JSON.parse(row.record);
    record.escrow = JSON.parse(other.record).escrow;
    db.query("UPDATE devices_v1 SET record = ? WHERE device_id = ?").run(JSON.stringify(record), first.input.deviceId);
    expect(await registry.recover(cap(), first.input.deviceId)).toEqual({ ok: false, error: "escrow-unavailable" });
  } finally {
    db.close();
  }
});

it("concurrent PIN and role writes across store handles cannot restore device authority", async () => {
  const { proof } = await committed();
  const active = value(await registry.activate(proof));
  const otherStore = createUserStore();
  const writes = await Promise.all([
    users.update("u_00000001", { role: "child" }),
    otherStore.update("u_00000001", { pinHash: "changed" }),
  ]);
  for (const write of writes) value(write);
  expect(value(await users.get("u_00000001"))?.role).toBe("child");
  value(await users.update("u_00000001", { role: "adult" }));
  expect((await registry.validate(active.token)).ok).toBe(false);
});

it("startup reconciliation purges a missed deletion hook, retaining tombstones and other owners", async () => {
  const { input } = await committed();
  const foreign = request();
  value(await registry.begin(cap("u_00000002"), foreign));
  value(await users.remove("u_00000001"));
  registry.close();
  registry = createDeviceRegistry(opts);
  await registry.purgeDeletedOwners();
  await registry.purgeDeletedOwners();
  const db = new Database(opts.path);
  try {
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM devices_v1 WHERE device_id = ?")
      .get(input.deviceId);
    expect(JSON.parse(row?.record ?? "null")).toMatchObject({
      status: "disabled",
      escrow: "",
      enrollmentVerifier: "",
      renewalVerifier: null,
    });
  } finally {
    db.close();
  }
  expect(value(await registry.recover(cap("u_00000002"), foreign.deviceId)).managerSecret).toBe(foreign.managerSecret);
  expect((await registry.begin(cap("u_00000002"), input)).ok).toBe(false);
});

it("unreadable owner storage cannot trigger destructive purge", async () => {
  const { input } = await committed();
  registry.close();
  registry = createDeviceRegistry({ ...opts, users: { get: async () => ({ ok: false, error: "io-error" }) } });
  expect((await registry.purgeDeletedOwner("u_00000001")).ok).toBe(false);
  await expect(registry.purgeDeletedOwners()).rejects.toThrow("reconciliation unavailable");
  registry.close();
  registry = createDeviceRegistry(opts);
  expect(value(await registry.recover(cap(), input.deviceId)).managerSecret).toBe(input.managerSecret);
});

it("a stale owner lookup cannot commit first enrollment after deletion purge on another handle", async () => {
  let release: () => void = () => {};
  let readStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = createDeviceRegistry({
    ...opts,
    users: {
      get: async (id) => {
        const snapshot = await users.get(id);
        readStarted();
        await delayed;
        return snapshot;
      },
    },
  });
  try {
    const pending = other.begin(cap(), request());
    await started;
    value(await users.remove("u_00000001"));
    value(await registry.purgeDeletedOwner("u_00000001"));
    release();
    expect(await pending).toEqual({ ok: false, error: "denied" });
  } finally {
    release();
    other.close();
  }
});

it("mints frozen Cube provenance before the initial grant without granting owner management", async () => {
  const { input, proof } = await committed();
  const active = value(await registry.activate(proof));
  const { principal } = value(await registry.validate(active.token));
  const access = createAccessManager({ userDataRoot: "/unused" });
  const grant = access.grant(principal, "tool-broker");
  expect(grant.origin).toEqual({ kind: "cube", deviceId: input.deviceId, generation: proof.generation });
  expect(grant.ownerUserId).toBe("u_00000001");
  expect(grant.role).toBe("adult");
  expect(Object.isFrozen(principal)).toBe(true);
  expect(Object.isFrozen(principal.origin)).toBe(true);
  expect(Object.isFrozen(grant.origin)).toBe(true);
  expect(Object.isFrozen(grant)).toBe(true);
  expect(await registry.recover(access.grant(principal, "device-registry"), input.deviceId)).toEqual({
    ok: false,
    error: "denied",
  });
  value(await registry.disable(cap(), input.deviceId));
  expect(await registry.validate(active.token)).toEqual({ ok: false, error: "denied" });
});
