import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { STORE_DDL, STORE_MIGRATIONS } from "../store/schema.js";
import { openSessionStore } from "../store/session-store.js";
import { instantForScheduleLocal, nextScheduleOccurrence } from "./recurrence.js";
import { type ScheduleService, type ScheduleServiceOptions, createScheduleService } from "./service.js";

const roots: string[] = [];
const services: ScheduleService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(userId: "u_aaaaaaaa" | "u_bbbbbbbb" = "u_aaaaaaaa", options: ScheduleServiceOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "schedules-"));
  roots.push(root);
  const capability: Capability = Object.freeze({
    ownerUserId: userId,
    resource: "schedule-private",
    rootPath: join(root, userId),
    role: "adult",
  });
  const resource = new PrivateScheduleResource(capability);
  const service = createScheduleService({
    ...options,
    userDataRoot: root,
    clock: options.clock ?? (() => new Date("2026-08-02T00:00:00Z")),
    id: options.id ?? (() => crypto.randomUUID()),
  });
  services.push(service);
  return { service, resource, root };
}

const once = (key: string, at: string) => ({
  idempotencyKey: key,
  message: "Continue our garden conversation",
  enabled: true,
  timing: { kind: "once-at" as const, at },
});

function openUserStore(root: string, userId: "u_aaaaaaaa" | "u_bbbbbbbb" = "u_aaaaaaaa") {
  return openSessionStore(
    Object.freeze({
      ownerUserId: userId,
      resource: "session-store",
      rootPath: join(root, userId),
      role: "adult",
    } satisfies Capability),
  );
}

async function claimOne(service: ScheduleService, resource: PrivateScheduleResource, key: string) {
  const created = await service.create(resource, once(key, "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
  if (!created.ok) throw new Error("create failed");
  const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
  if (!due.ok || !due.value[0]) throw new Error("claim failed");
  return due.value[0];
}

async function finalizeCard(
  service: ScheduleService,
  resource: PrivateScheduleResource,
  root: string,
  key: string,
  outcome: "completed" | "failed" | "interrupted",
  completedAt: string,
  text = `Response for ${key}`,
) {
  const claim = await claimOne(service, resource, key);
  const sessionId = `session-${key}`;
  const store = openUserStore(root);
  store.createSession(sessionId, `scheduled:${claim.occurrenceId}`);
  store.setScheduledProvenance?.(sessionId, claim.scheduleId, claim.occurrenceId, claim.intendedAt, completedAt);
  store.setScheduledTurn?.(sessionId, claim.occurrenceId, `turn-${key}`);
  const entry =
    outcome === "completed"
      ? store.append({
          sessionId,
          turnId: `turn-${key}`,
          replyId: `reply-${key}`,
          kind: "assistant",
          createdAt: Date.parse(completedAt),
          text,
          toolCallId: null,
          toolName: null,
          toolArgs: null,
          cutoff: null,
          compactedThroughSeq: null,
          pendingId: null,
        })
      : undefined;
  store.recordScheduledTerminal?.(sessionId, `turn-${key}`, outcome, completedAt, entry ? String(entry.seq) : null);
  store.close();
  expect((await service.associateSession(claim, sessionId)).ok).toBe(true);
  const content = entry
    ? { ownerUserId: claim.ownerUserId, sessionId, occurrenceId: claim.occurrenceId, entryId: String(entry.seq) }
    : undefined;
  const receipt = (() => {
    if (outcome !== "completed") return { outcome, sessionId, completedAt };
    if (!content) throw new Error("completed terminal missing content");
    return { outcome, sessionId, completedAt, content };
  })();
  const result = await service.finalizeClaim(claim, receipt, undefined);
  expect(result.ok).toBe(true);
  return { claim, sessionId, entry };
}

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

  test("adds scheduling after v8 without changing existing session or calendar rows", async () => {
    const { service, resource, root } = setup();
    const userRoot = join(root, "u_aaaaaaaa");
    mkdirSync(userRoot, { recursive: true });
    const db = new Database(join(userRoot, "sessions.db"), { create: true });
    db.exec(STORE_DDL);
    for (const migration of STORE_MIGRATIONS) {
      if (migration.version > 8) break;
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec(`
      INSERT INTO sessions(session_id,mint_key,created_at,updated_at,version)
      VALUES ('existing-session','existing-mint',1,1,1);
      INSERT INTO events(id,title,start_all_day,end_all_day,visibility,importance,created_at,updated_at)
      VALUES ('existing-event','Existing',1,1,'everyone','normal','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    db.close();

    expect((await service.list(resource, undefined, 10)).ok).toBe(true);
    const migrated = new Database(join(userRoot, "sessions.db"), { readonly: true });
    expect(
      migrated.query<{ n: number }, []>("SELECT count(*) n FROM sessions WHERE session_id='existing-session'").get()?.n,
    ).toBe(1);
    expect(migrated.query<{ n: number }, []>("SELECT count(*) n FROM events WHERE id='existing-event'").get()?.n).toBe(
      1,
    );
    expect(
      migrated.query<{ version: number }, []>("SELECT user_version version FROM pragma_user_version").get()?.version,
    ).toBe(9);
    migrated.close();
  });

  test("honors configured user database filename", async () => {
    const { service, resource, root } = setup("u_aaaaaaaa", { sessionDbFileName: "data/custom.db" });
    expect(
      (await service.create(resource, once("custom-db", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"))).ok,
    ).toBe(true);
    const db = new Database(join(root, "u_aaaaaaaa", "data/custom.db"), { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM schedules").get()?.n).toBe(1);
    db.close();
    expect(() => new Database(join(root, "u_aaaaaaaa", "sessions.db"), { readonly: true })).toThrow();

    const escaped = setup("u_aaaaaaaa", { sessionDbFileName: "../escaped.db" });
    expect(await escaped.service.list(escaped.resource, undefined, 10)).toEqual({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    expect(() => new Database(join(escaped.root, "escaped.db"), { readonly: true })).toThrow();
  });

  test("stores scheduling and private notification cards in configured user database", async () => {
    const { service, resource, root } = setup();
    await finalizeCard(
      service,
      resource,
      root,
      "schema",
      "completed",
      "2026-08-01T15:01:02.000Z",
      "Canonical response",
    );

    const db = new Database(join(root, "u_aaaaaaaa", "sessions.db"), { readonly: true });
    expect(
      db.query<{ version: number }, []>("SELECT user_version version FROM pragma_user_version").get()?.version,
    ).toBe(9);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('schedules','occurrences','content_outbox','notification_cards') ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["content_outbox", "notification_cards", "occurrences", "schedules"]);
    expect(
      db
        .query<{ table: string }, []>(
          `SELECT "table" FROM pragma_foreign_key_list('notification_cards') ORDER BY "table"`,
        )
        .all()
        .map((row) => row.table),
    ).toEqual(["occurrences", "sessions"]);
    expect(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('notification_cards')").all()).toEqual([
      { name: "occurrence_id" },
      { name: "session_id" },
    ]);
    db.close();
    expect(() => new Database(join(root, "u_aaaaaaaa", "scheduling-v1", "schedules.db"), { readonly: true })).toThrow();
  });

  test("creates cards only in successful terminal finalization and joins canonical response text", async () => {
    const { service, resource, root } = setup();
    const completed = await finalizeCard(
      service,
      resource,
      root,
      "completed",
      "completed",
      "2026-08-01T15:01:04.000Z",
      `  ${"response ".repeat(50)}  `,
    );
    await finalizeCard(service, resource, root, "failed", "failed", "2026-08-01T15:01:03.000Z");
    await finalizeCard(service, resource, root, "interrupted", "interrupted", "2026-08-01T15:01:02.000Z");
    const expired = await claimOne(service, resource, "expired");
    expect(
      (await service.finalizeClaim(expired, { outcome: "expired", completedAt: "2026-08-01T15:01:05.000Z" }, undefined))
        .ok,
    ).toBe(true);

    let listed = await service.cards(resource, undefined, 100);
    expect(listed.ok && listed.value.cards.map(({ sessionId, status }) => [sessionId, status])).toEqual([
      ["session-completed", "completed"],
      ["session-failed", "failed"],
      ["session-interrupted", "interrupted"],
    ]);
    if (!listed.ok) throw new Error("cards failed");
    expect(listed.value.cards[0]?.preview?.length).toBe(280);

    const db = new Database(join(root, "u_aaaaaaaa", "sessions.db"));
    db.query("UPDATE entries SET text='Canonical replacement' WHERE seq=?").run(completed.entry?.seq ?? -1);
    db.close();
    listed = await service.cards(resource, undefined, 100);
    expect(listed.ok && listed.value.cards[0]?.preview).toBe("Canonical replacement");
  });

  test("rolls back terminal receipt, schedule advance, outbox, and card when card insertion fails", async () => {
    const { service, resource, root } = setup();
    const claim = await claimOne(service, resource, "atomic-card");
    const store = openUserStore(root);
    store.createSession("session-atomic", `scheduled:${claim.occurrenceId}`);
    store.close();
    expect((await service.associateSession(claim, "session-atomic")).ok).toBe(true);
    expect(
      await service.finalizeClaim(
        claim,
        { outcome: "interrupted", sessionId: "session-atomic", completedAt: "not-an-instant" },
        undefined,
      ),
    ).toEqual({ ok: false, error: { code: "validation", retryable: false } });
    const blocking = new Database(join(root, "u_aaaaaaaa", "sessions.db"));
    blocking.exec(`
      CREATE TRIGGER stop_card_insert BEFORE INSERT ON notification_cards
      BEGIN SELECT RAISE(ABORT,'stop card'); END;
    `);
    blocking.close();
    const content = {
      ownerUserId: claim.ownerUserId,
      sessionId: "session-atomic",
      occurrenceId: claim.occurrenceId,
      entryId: "1",
    };
    expect(
      await service.finalizeClaim(
        claim,
        { outcome: "completed", sessionId: "session-atomic", completedAt: "2026-08-01T15:01:02.000Z", content },
        { outboxId: "outbox-atomic", content, availableAt: "2026-08-01T15:01:02.000Z" },
      ),
    ).toEqual({ ok: false, error: { code: "unavailable", retryable: true } });

    const db = new Database(join(root, "u_aaaaaaaa", "sessions.db"), { readonly: true });
    expect(db.query<{ outcome: string | null }, []>("SELECT outcome FROM occurrences").get()?.outcome).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM content_outbox").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM notification_cards").get()?.n).toBe(0);
    expect(db.query<{ deleted: number }, []>("SELECT deleted FROM schedules").get()?.deleted).toBe(0);
    db.close();
  });

  test("rejects a mismatched preexisting card before writes and can finalize after correction", async () => {
    const { service, resource, root } = setup();
    const claim = await claimOne(service, resource, "card-conflict");
    const store = openUserStore(root);
    store.createSession("session-current", `scheduled:${claim.occurrenceId}`);
    store.createSession("session-wrong", "malformed-card");
    store.close();
    expect((await service.associateSession(claim, "session-current")).ok).toBe(true);

    const dbPath = join(root, "u_aaaaaaaa", "sessions.db");
    let db = new Database(dbPath);
    db.query("INSERT INTO notification_cards(occurrence_id,session_id) VALUES (?,?)").run(
      claim.occurrenceId,
      "session-wrong",
    );
    db.close();
    const content = {
      ownerUserId: claim.ownerUserId,
      sessionId: "session-current",
      occurrenceId: claim.occurrenceId,
      entryId: "1",
    };
    const receipt = {
      outcome: "completed" as const,
      sessionId: "session-current",
      completedAt: "2026-08-01T15:01:02.000Z",
      content,
    };
    const outbox = { outboxId: "outbox-card-conflict", content, availableAt: receipt.completedAt };

    expect(await service.finalizeClaim(claim, receipt, outbox)).toEqual({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    db = new Database(dbPath);
    expect(
      db
        .query<{ outcome: string | null; completed_at: string | null; entry_id: string | null }, []>(
          "SELECT outcome,completed_at,entry_id FROM occurrences",
        )
        .get(),
    ).toEqual({ outcome: null, completed_at: null, entry_id: null });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM content_outbox").get()?.n).toBe(0);
    expect(db.query<{ deleted: number }, []>("SELECT deleted FROM schedules").get()?.deleted).toBe(0);
    db.query("UPDATE notification_cards SET session_id=? WHERE occurrence_id=?").run(
      "session-current",
      claim.occurrenceId,
    );
    db.close();

    const retried = await service.finalizeClaim(claim, receipt, outbox);
    expect(retried.ok && retried.value).toMatchObject({ scheduleConsumed: true, replayed: false });
    db = new Database(dbPath, { readonly: true });
    expect(db.query<{ outcome: string }, []>("SELECT outcome FROM occurrences").get()?.outcome).toBe("completed");
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM content_outbox").get()?.n).toBe(1);
    expect(db.query<{ deleted: number }, []>("SELECT deleted FROM schedules").get()?.deleted).toBe(1);
    db.close();
  });

  test("clears frozen targets only, admits later arrivals, and never resurrects on replay", async () => {
    const { service, resource, root } = setup();
    const first = await finalizeCard(service, resource, root, "first", "completed", "2026-08-01T15:01:01.000Z");
    const frozen = await service.cards(resource, undefined, 100);
    if (!frozen.ok) throw new Error("cards failed");
    const second = await finalizeCard(service, resource, root, "second", "completed", "2026-08-01T15:01:02.000Z");

    expect(
      (
        await service.clearCards(
          resource,
          frozen.value.cards.map((card) => card.occurrenceId),
        )
      ).ok,
    ).toBe(true);
    expect((await service.clearCards(resource, ["stale-occurrence"])).ok).toBe(true);
    let listed = await service.cards(resource, undefined, 100);
    expect(listed.ok && listed.value.cards.map((card) => card.occurrenceId)).toEqual([second.claim.occurrenceId]);

    const replay = await service.finalizeClaim(
      first.claim,
      {
        outcome: "completed",
        sessionId: first.sessionId,
        completedAt: "2026-08-01T15:01:01.000Z",
        content: {
          ownerUserId: first.claim.ownerUserId,
          sessionId: first.sessionId,
          occurrenceId: first.claim.occurrenceId,
          entryId: String(first.entry?.seq),
        },
      },
      undefined,
    );
    expect(replay.ok && replay.value.replayed).toBe(true);
    listed = await service.cards(resource, undefined, 100);
    expect(listed.ok && listed.value.cards.map((card) => card.occurrenceId)).toEqual([second.claim.occurrenceId]);
  });

  test("keeps cards isolated and applies bounded pagination, age, and late-completion retention", async () => {
    const now = new Date("2026-08-01T15:01:10.000Z");
    const { service, resource, root } = setup("u_aaaaaaaa", {
      cardsDefaultPageSize: 2,
      inboxMaxEntries: 3,
      inboxRetentionMs: 5_000,
      clock: () => now,
    });
    for (const [key, completedAt] of [
      ["old", "2026-08-01T15:01:04.000Z"],
      ["a", "2026-08-01T15:01:06.000Z"],
      ["c", "2026-08-01T15:01:08.000Z"],
      ["b", "2026-08-01T15:01:07.000Z"],
      ["late", "2026-08-01T15:01:06.500Z"],
    ] as const)
      await finalizeCard(service, resource, root, key, "completed", completedAt);

    const first = await service.cards(resource, undefined, undefined);
    expect(first.ok && first.value.cards.map((card) => card.sessionId)).toEqual(["session-c", "session-b"]);
    expect(first.ok && first.value.nextCursor).toBe("2");
    const second = await service.cards(resource, first.ok ? first.value.nextCursor : undefined, undefined);
    expect(second.ok && second.value.cards.map((card) => card.sessionId)).toEqual(["session-late"]);

    const bob = new PrivateScheduleResource(
      Object.freeze({
        ownerUserId: "u_bbbbbbbb",
        resource: "schedule-private",
        rootPath: join(root, "u_bbbbbbbb"),
        role: "adult",
      }),
    );
    expect(await service.cards(bob, undefined, 100)).toEqual({ ok: true, value: { cards: [] } });
    const db = new Database(join(root, "u_aaaaaaaa", "sessions.db"), { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM notification_cards").get()?.n).toBe(3);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM sessions").get()?.n).toBe(5);
    db.close();
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
    const { service, resource, root } = setup();
    await service.create(resource, once("terminal", "2026-08-01T15:00:00Z"), new Date("2026-08-01T14:00:00Z"));
    const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
    if (!due.ok || !due.value[0]) throw new Error("claim failed");
    const claim = due.value[0];
    expect((await service.associateSession(claim, "session-terminal")).ok).toBe(true);
    const terminalStore = openUserStore(root);
    terminalStore.createSession("session-terminal", `scheduled:${claim.occurrenceId}`);
    terminalStore.close();
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

    const db = new Database(join(resource.rootPath, "sessions.db"));
    db.query("UPDATE occurrences SET source_json='{}'").run();
    db.close();

    expect(await service.claimDue(new Date("2026-08-01T15:01:02Z"), 1, 1_000)).toEqual({
      ok: false,
      error: { code: "internal", retryable: false },
    });
  });

  test("unchanged calendar reconciliation preserves a due recurring occurrence before and after claim", async () => {
    const { service, resource, root } = setup();
    const reminder = {
      eventId: "event-recurring",
      reminderId: "event-recurring:u_aaaaaaaa",
      enabled: true,
      message: "Remind me about my calendar event.",
      timing: { kind: "recurring" as const, frequency: "daily" as const, localTime: "09:00", timeZone: "UTC" },
    };

    expect(
      (
        await service.reconcileCalendarReminder(
          resource,
          { ...reminder, notBefore: new Date("2026-08-02T09:00:00Z") },
          new Date("2026-08-02T08:59:00Z"),
        )
      ).ok,
    ).toBe(true);
    // The adapter's clock-dependent notBefore disappears after the first instant;
    // this is still the same desired projection and must leave the due slot intact.
    expect((await service.reconcileCalendarReminder(resource, reminder, new Date("2026-08-02T09:00:01Z"))).ok).toBe(
      true,
    );
    const due = await service.claimDue(new Date("2026-08-02T09:00:01Z"), 1, 60_000);
    if (!due.ok || !due.value[0]) throw new Error("claim failed");
    const claim = due.value[0];
    expect(claim.intendedAt).toBe("2026-08-02T09:00:00.000Z");

    expect((await service.reconcileCalendarReminder(resource, reminder, new Date("2026-08-02T09:00:02Z"))).ok).toBe(
      true,
    );
    expect((await service.associateSession(claim, "session-calendar-recurring")).ok).toBe(true);
    const recurringStore = openUserStore(root);
    recurringStore.createSession("session-calendar-recurring", `scheduled:${claim.occurrenceId}`);
    recurringStore.close();
    const finalized = await service.finalizeClaim(
      claim,
      { outcome: "interrupted", sessionId: "session-calendar-recurring", completedAt: "2026-08-02T09:00:03.000Z" },
      undefined,
    );
    expect(finalized.ok && finalized.value.nextRunAt).toBe("2026-08-03T09:00:00.000Z");

    // A semantic edit still fences the old generation.
    const next = await service.claimDue(new Date("2026-08-03T09:00:01Z"), 1, 60_000);
    if (!next.ok || !next.value[0]) throw new Error("next claim failed");
    expect(
      (
        await service.reconcileCalendarReminder(
          resource,
          { ...reminder, message: "Changed reminder." },
          new Date("2026-08-03T09:00:02Z"),
        )
      ).ok,
    ).toBe(true);
    expect((await service.associateSession(next.value[0], "session-stale-calendar")).ok).toBe(false);
  });

  test("unchanged consumed one-time calendar reminder is not resurrected", async () => {
    const { service, resource, root } = setup();
    const reminder = {
      eventId: "event-once",
      reminderId: "event-once:u_aaaaaaaa",
      enabled: true,
      message: "Remind me about my appointment.",
      timing: { kind: "once-at" as const, at: "2026-08-02T09:00:00Z" },
    };
    expect((await service.reconcileCalendarReminder(resource, reminder, new Date("2026-08-01T09:00:00Z"))).ok).toBe(
      true,
    );
    const due = await service.claimDue(new Date("2026-08-02T09:00:01Z"), 1, 60_000);
    if (!due.ok || !due.value[0]) throw new Error("claim failed");
    const claim = due.value[0];
    expect((await service.associateSession(claim, "session-calendar-once")).ok).toBe(true);
    const onceStore = openUserStore(root);
    onceStore.createSession("session-calendar-once", `scheduled:${claim.occurrenceId}`);
    onceStore.close();
    expect(
      (
        await service.finalizeClaim(
          claim,
          { outcome: "interrupted", sessionId: "session-calendar-once", completedAt: "2026-08-02T09:00:02Z" },
          undefined,
        )
      ).ok,
    ).toBe(true);

    expect((await service.reconcileCalendarReminder(resource, reminder, new Date("2026-08-02T09:00:03Z"))).ok).toBe(
      true,
    );
    expect(await service.list(resource, undefined, 10)).toEqual({ ok: true, value: { schedules: [] } });
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
