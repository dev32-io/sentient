import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivatePushResource } from "../access/private-push-resource.js";
import type { UserId } from "../user-auth/user-id.js";
import { openPushStore } from "./push-store.js";

const token = (digit: string) => digit.repeat(64);
const resource = (ownerUserId: UserId) =>
  new PrivatePushResource({ ownerUserId, resource: "push-private", rootPath: "/tmp", role: "adult" });
const alice = resource("u_a11ce001" as UserId);
const bob = resource("u_b0b00001" as UserId);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "push-"));
  dirs.push(dir);
  let id = 0;
  return openPushStore(join(dir, "push.db"), {
    revocationTtlMs: 60_000,
    randomCredential: () => `secret-${++id}`,
    randomBindingId: () => `bind-${id}`,
  });
}

describe("push binding generation fence and revoke-only authority", () => {
  it("disables an old account binding atomically before replacement activation and stale replay cannot reactivate it", async () => {
    const db = await store();
    const first = await db.issue(
      alice,
      { idempotencyKey: "a", installationId: "phone", platform: "ios", apnsDeviceToken: token("0") },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const blocked = await db.issue(
      bob,
      { idempotencyKey: "b0", installationId: "phone", platform: "ios", apnsDeviceToken: token("1") },
      new Date(),
    );
    expect(blocked).toMatchObject({ ok: false, error: { code: "old_binding_active" } });
    const replacementRequest = {
      idempotencyKey: "b",
      installationId: "phone",
      platform: "ios" as const,
      apnsDeviceToken: token("1"),
      replaces: { bindingId: first.value.binding.bindingId, generation: first.value.binding.generation },
    };
    const next = await db.issue(bob, replacementRequest, new Date("2026-01-01T00:00:01Z"));
    expect(next).toMatchObject({
      ok: true,
      value: { binding: { state: "pending-old-binding-disable", generation: 2 } },
    });
    expect(await db.activeForUser(bob.ownerUserId)).toMatchObject({ ok: true, value: [] });
    await db.revoke(
      {
        idempotencyKey: "unlink-a",
        bindingId: first.value.binding.bindingId,
        generation: 1,
        revocationCredential: first.value.revocation.credential,
      },
      new Date("2026-01-01T00:00:02Z"),
    );
    const activated = await db.issue(bob, replacementRequest, new Date("2026-01-01T00:00:03Z"));
    expect(activated).toMatchObject({
      ok: true,
      value: { binding: { state: "active", generation: 2 }, replayed: true },
    });
    const replay = await db.issue(
      alice,
      { idempotencyKey: "a", installationId: "phone", platform: "ios", apnsDeviceToken: token("0") },
      new Date("2026-01-01T00:00:04Z"),
    );
    expect(replay).toMatchObject({
      ok: true,
      value: { binding: { state: "disabled", generation: 1 }, replayed: true },
    });
    expect(await db.activeForUser(alice.ownerUserId)).toMatchObject({ ok: true, value: [] });
    db.close();
  });

  it("rejects invalid/expired exact-binding authority and idempotently acknowledges valid revocation", async () => {
    const db = await store();
    const issued = await db.issue(
      alice,
      { idempotencyKey: "a", installationId: "phone", platform: "ios", apnsDeviceToken: token("0") },
      new Date("2026-01-01T00:00:00Z"),
    );
    if (!issued.ok) throw new Error("issue failed");
    const base = { idempotencyKey: "r", bindingId: issued.value.binding.bindingId, generation: 1 };
    expect(await db.revoke({ ...base, revocationCredential: "wrong" }, new Date("2026-01-01T00:00:01Z"))).toMatchObject(
      { ok: false, error: { code: "invalid_revocation_authority" } },
    );
    const request = { ...base, revocationCredential: issued.value.revocation.credential };
    const revoked = await db.revoke(request, new Date("2026-01-01T00:00:02Z"));
    expect(revoked).toMatchObject({ ok: true, value: { status: "revoked" } });
    expect(await db.revoke(request, new Date("2030-01-01T00:00:00Z"))).toEqual(revoked);
    db.close();
  });
});
