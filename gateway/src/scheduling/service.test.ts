import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { instantForScheduleLocal, nextScheduleOccurrence } from "./recurrence.js";
import { type ScheduleService, createScheduleService } from "./service.js";

const roots: string[] = [];
const services: ScheduleService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(userId: "u_aaaaaaaa" | "u_bbbbbbbb" = "u_aaaaaaaa") {
  const root = mkdtempSync(join(tmpdir(), "schedules-"));
  roots.push(root);
  const capability: Capability = Object.freeze({
    ownerUserId: userId,
    resource: "schedule-private",
    rootPath: join(root, userId),
    role: "adult",
  });
  const resource = new PrivateScheduleResource(capability);
  const service = createScheduleService({ userDataRoot: root, id: () => crypto.randomUUID() });
  services.push(service);
  return { service, resource, root };
}

const once = (key: string, at: string) => ({
  idempotencyKey: key,
  message: "Continue our garden conversation",
  enabled: true,
  timing: { kind: "once-at" as const, at },
});

describe("schedule persistence", () => {
  test("resolves relative delay once and replays an identical create without shifting it", async () => {
    const { service, resource } = setup();
    const request = {
      idempotencyKey: "same",
      message: "Chat about the plan",
      enabled: true,
      timing: { kind: "once-after" as const, afterSeconds: 1800 },
    };
    const first = await service.create(resource, request, new Date("2026-08-01T15:00:00Z"));
    const retry = await service.create(resource, request, new Date("2026-08-01T16:00:00Z"));
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.value.scheduleId).toBe(first.value.scheduleId);
      expect(retry.value.timing).toEqual(first.value.timing);
    }
    const conflict = await service.create(resource, { ...request, message: "different" }, new Date());
    expect(conflict).toEqual({ ok: false, error: { code: "idempotency_conflict", retryable: false } });
  });

  test("keeps capability-owned collections isolated", async () => {
    const { service, resource, root } = setup();
    const bob = new PrivateScheduleResource(
      Object.freeze({
        ownerUserId: "u_bbbbbbbb",
        resource: "schedule-private",
        rootPath: join(root, "u_bbbbbbbb"),
        role: "adult",
      }),
    );
    await service.create(resource, once("alice", "2026-08-01T15:30:00Z"), new Date("2026-08-01T15:00:00Z"));
    expect(await service.list(bob, undefined, 50)).toEqual({ ok: true, value: { schedules: [] } });
  });

  test("cleans an expired once entry without yielding work", async () => {
    const { service, resource } = setup();
    await service.create(resource, once("old", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
    expect(await service.claimDue(new Date("2026-08-01T15:16:00Z"), 10, 60_000)).toEqual({ ok: true, value: [] });
    expect(await service.list(resource, undefined, 50)).toEqual({ ok: true, value: { schedules: [] } });
  });

  test("selects only the latest recurring catch-up slot", async () => {
    const { service, resource } = setup();
    await service.create(
      resource,
      {
        idempotencyKey: "daily",
        message: "Daily news",
        enabled: true,
        timing: { kind: "recurring", frequency: "daily", localTime: "09:00", timeZone: "UTC" },
      },
      new Date("2026-08-01T08:00:00Z"),
    );
    const claims = await service.claimDue(new Date("2026-08-04T09:10:00Z"), 10, 60_000);
    expect(claims.ok && claims.value).toHaveLength(1);
    if (claims.ok) expect(claims.value[0]?.intendedAt).toBe("2026-08-04T09:00:00.000Z");
  });

  test("leases fence duplicate workers while preserving occurrence identity", async () => {
    const { service, resource } = setup();
    await service.create(resource, once("lease", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
    const first = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
    const blocked = await service.claimDue(new Date("2026-08-01T15:01:30Z"), 1, 60_000);
    const reclaimed = await service.claimDue(new Date("2026-08-01T15:02:01Z"), 1, 60_000);
    if (!first.ok || !reclaimed.ok) throw new Error("claim failed");
    expect(blocked).toEqual({ ok: true, value: [] });
    expect(reclaimed.value[0]?.occurrenceId).toBe(first.value[0]?.occurrenceId);
    expect(reclaimed.value[0]?.claimToken).not.toBe(first.value[0]?.claimToken);
  });

  test("finalizes response handoff atomically and keeps it after one-time cleanup", async () => {
    const { service, resource } = setup();
    await service.create(resource, once("terminal", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
    const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
    if (!due.ok || !due.value[0]) throw new Error("claim failed");
    const claim = due.value[0];
    expect((await service.associateSession(claim, "session-terminal")).ok).toBe(true);
    const content = {
      ownerUserId: claim.ownerUserId,
      sessionId: "session-terminal",
      occurrenceId: claim.occurrenceId,
      entryId: "9",
    };
    const finalized = await service.finalizeClaim(
      claim,
      { outcome: "completed", sessionId: "session-terminal", completedAt: "2026-08-01T15:01:30.000Z", content },
      { outboxId: "delivery-terminal", content, availableAt: "2026-08-01T15:01:30.000Z" },
    );
    expect(finalized.ok && finalized.value.scheduleConsumed).toBe(true);
    expect(await service.list(resource, undefined, 10)).toEqual({ ok: true, value: { schedules: [] } });
    const queued = await service.claim(new Date("2026-08-01T15:02:00Z"), 10, 60_000);
    expect(queued.ok && queued.value[0]?.content).toEqual(content);
    const replay = await service.finalizeClaim(
      claim,
      { outcome: "completed", sessionId: "session-terminal", completedAt: "2026-08-01T15:01:30.000Z", content },
      { outboxId: "different-id", content, availableAt: "2026-08-01T15:01:30.000Z" },
    );
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect((await service.claim(new Date("2026-08-01T15:03:01Z"), 10, 60_000)).ok).toBe(true);
  });

  test("fails closed when a recoverable occurrence has invalid persisted authority inputs", async () => {
    const { service, resource } = setup();
    await service.create(resource, once("corrupt-recovery", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
    const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 1_000);
    if (!due.ok || !due.value[0]) throw new Error("claim failed");
    expect((await service.associateSession(due.value[0], "session-corrupt")).ok).toBe(true);

    const db = new Database(join(resource.rootPath, "scheduling-v1", "schedules.db"));
    db.query("UPDATE occurrences SET source_json='{}'").run();
    db.close();

    expect(await service.claimDue(new Date("2026-08-01T15:01:02Z"), 1, 1_000)).toEqual({
      ok: false,
      error: { code: "internal", retryable: false },
    });
  });

  test("pause, edit, and delete fence already-issued claims", async () => {
    for (const operation of ["pause", "edit", "delete"] as const) {
      const { service, resource } = setup();
      const made = await service.create(
        resource,
        once(operation, "2026-08-01T15:00:00Z"),
        new Date("2026-08-01T14:00:00Z"),
      );
      if (!made.ok) throw new Error("create failed");
      const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
      if (!due.ok) throw new Error("claim failed");
      const claim = due.value[0];
      if (!claim) throw new Error("missing claim");
      if (operation === "delete") await service.delete(resource, made.value.scheduleId, 1);
      else
        await service.patch(
          resource,
          made.value.scheduleId,
          { expectedRevision: 1, changes: operation === "pause" ? { enabled: false } : { message: "changed" } },
          new Date("2026-08-01T15:01:01Z"),
        );
      expect((await service.associateSession(claim, `session-${operation}`)).ok).toBe(false);
    }
  });
});

describe("wall-clock recurrence", () => {
  test("skips DST gaps and chooses the first overlap instant", () => {
    expect(
      instantForScheduleLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/New_York"),
    ).toBeUndefined();
    const overlap = instantForScheduleLocal(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(overlap).toBeDefined();
    expect(new Date(overlap ?? Number.NaN).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  test("skips absent monthly dates", () => {
    const next = nextScheduleOccurrence(
      { kind: "recurring", frequency: "monthly", dayOfMonth: 31, localTime: "09:00", timeZone: "UTC" },
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-05-31T09:00:00.000Z");
  });
});
