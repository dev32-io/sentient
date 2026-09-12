import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createScheduledExecutionAuthorizer, createScheduledMessageSubmitter } from "../scheduled-chat/executor.js";
import { createScheduledChatRunner } from "../scheduled-chat/runner.js";
import { createTextRuntimeFixture } from "../scheduled-chat/scheduled-chat-runtime.test-fixture.js";
import { createScheduleService } from "../scheduling/service.js";
import { createSessionRegistry } from "../session-handlers/session-registry.js";
import { openSessionStore } from "../store/session-store.js";
import { createCalendarEvent, mutateCalendarEvent } from "./calendar-mutations.js";
import { authorizeCalendarReminderExecution, createCalendarReminderScheduler } from "./calendar-reminder-scheduler.js";
import { openCalendarPersistence } from "./calendar-store.js";
import type { CalendarConfig, CalendarMutationCommand } from "./types.js";

const config: CalendarConfig = {
  query: { maxDays: 366, maxOccurrences: 100, pageSize: 100 },
  input: {
    maxTitleChars: 100,
    maxDescriptionChars: 1000,
    maxQueryChars: 100,
    maxGroupChars: 40,
    maxTagChars: 20,
    maxTags: 8,
  },
  output: { maxResultChars: 5000 },
  recurrence: { maxOccurrences: 100, maxDays: 366 },
  nudge: { maxPerDay: 10 },
  defaultEventTimeZoneId: "America/Toronto",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("calendar reminder scheduling boundary", () => {
  test("creates, reschedules, and cancels the linked actor-owned schedule", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => "linked",
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    const created = createCalendarEvent(
      {
        title: "Dentist",
        start: "2026-05-01T14:00:00Z" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        reminder: { enabled: true, mode: "lead", leadMinutes: 30 },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2026-01-01T00:00:00Z"))).ok,
    ).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    let listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules[0]).toMatchObject({
      message: "Remind me about my calendar event “Dentist”.",
      timing: { kind: "once", at: "2026-05-01T13:30:00.000Z" },
      source: {
        kind: "calendar-reminder",
        eventId: created.value.eventId,
        reminderId: `${created.value.eventId}:u_aaaaaaaa`,
      },
    });
    if (!listed.ok || !listed.value.schedules[0]) return;
    const scheduled = listed.value.schedules[0];
    if (scheduled.source.kind !== "calendar-reminder") return;
    const execution = {
      principal,
      resource,
      claim: {
        claimToken: "claim",
        scheduleId: scheduled.scheduleId,
        occurrenceId: "occurrence",
        ownerUserId: principal.userId,
        source: scheduled.source,
        intendedAt: "2026-05-01T13:30:00.000Z",
        claimedUntil: "2026-05-01T13:31:00.000Z",
        message: scheduled.message,
        oneTime: true,
      },
    } as const;
    expect(
      (
        await authorizeCalendarReminderExecution(
          execution,
          { accessManager, calendarConfig: config },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await authorizeCalendarReminderExecution(
          {
            ...execution,
            claim: {
              ...execution.claim,
              source: { ...scheduled.source, reminderId: `${created.value.eventId}:u_victim:2026-05-01T14:00:00.000Z` },
            },
          },
          { accessManager, calendarConfig: config },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);

    const disabled = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        changes: { reminder: { enabled: false } },
      } as CalendarMutationCommand,
      persistence,
      config,
    );
    expect(disabled.ok).toBe(true);
    expect((await scheduler.reconcile(persistence, created.value.eventId, "private")).ok).toBe(true);
    listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toEqual([]);
    schedules.close();
    persistence.close();
  });

  test("executes skipped COUNT reminders through real runtimes without replay after restart", async () => {
    const cases = [
      {
        name: "monthly",
        start: "2028-01-31T14:00:00Z",
        recurrence: { frequency: "monthly" as const, count: 3 },
        zone: "UTC",
        due: "2028-05-31T13:30:00.000Z",
        original: "2028-05-31T14:00:00.000Z",
      },
      {
        name: "yearly",
        start: "2020-02-29T14:00:00Z",
        recurrence: { frequency: "yearly" as const, count: 2 },
        zone: "UTC",
        due: "2024-02-29T13:30:00.000Z",
        original: "2024-02-29T14:00:00.000Z",
      },
      {
        name: "dst-gap",
        start: "2026-03-07T02:30:00-05:00",
        recurrence: { frequency: "daily" as const, count: 2 },
        zone: "America/New_York",
        due: "2026-03-09T06:00:00.000Z",
        original: "2026-03-09T06:30:00.000Z",
      },
    ];

    for (const item of cases) {
      const root = mkdtempSync(join(tmpdir(), `calendar-reminder-real-${item.name}-`));
      roots.push(root);
      const caseConfig: CalendarConfig = {
        ...config,
        recurrence: { maxOccurrences: 100, maxDays: 4_000 },
        defaultEventTimeZoneId: item.zone as never,
      };
      const accessManager = createAccessManager({ userDataRoot: root });
      const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
      let persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), caseConfig);
      let sequence = 0;
      let schedules = createScheduleService({ userDataRoot: root, id: () => `${item.name}-${++sequence}` });
      let scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: caseConfig });
      const created = createCalendarEvent(
        {
          title: `${item.name} medicine`,
          start: item.start as never,
          visibility: "everyone",
          importance: "normal",
          tags: [],
          recurrence: item.recurrence,
          reminder: { enabled: true, mode: "lead", leadMinutes: 30 },
        },
        persistence,
        caseConfig,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      const dueMs = Date.parse(item.due);
      expect(
        (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date(dueMs - 60_000))).ok,
      ).toBe(true);
      const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
      const pending = await schedules.list(resource, undefined, 100);
      expect(pending.ok && pending.value.schedules[0]?.source).toMatchObject({
        kind: "calendar-reminder",
        reminderId: `${created.value.eventId}:${principal.userId}:${item.original}`,
      });

      let runtimeFixture = createTextRuntimeFixture(accessManager);
      const sessionId = `s_${item.name.replace("-", "").padEnd(32, "a")}`;
      const makeAuthorizer = () =>
        createScheduledExecutionAuthorizer({
          users: {
            get: async () => ({
              ok: true as const,
              value: {
                userId: principal.userId,
                role: "adult" as const,
                displayName: "Owner",
                pinHash: "test-only",
                avatarTint: "sage" as const,
                createdAt: "2026-01-01T00:00:00Z",
                credentialsValidFrom: "2026-01-01T00:00:00Z",
              },
            }),
          },
          accessManager,
          householdId: "home",
          authorizeCalendarReminder: (execution, signal) =>
            authorizeCalendarReminderExecution(execution, { accessManager, calendarConfig: caseConfig }, signal),
        });
      const run = async (
        service: ReturnType<typeof createScheduleService>,
        now: Date,
        finalizer: Parameters<typeof createScheduledChatRunner>[0]["finalizer"] = service,
        claims: Parameters<typeof createScheduledChatRunner>[0]["claims"] = service,
      ) => {
        const registry = createSessionRegistry(() => {});
        const submitter = createScheduledMessageSubmitter({
          accessManager,
          registry,
          associateSession: (claim, id) => service.associateSession(claim, id),
          makeSessionId: () => sessionId,
          now: () => now,
          buildHandles: runtimeFixture.buildHandles,
        });
        const runner = createScheduledChatRunner({
          claims,
          authorizer: makeAuthorizer(),
          submitter,
          finalizer,
          claimLimit: 1,
          leaseMs: 60_000,
          pollMs: 10,
          now: () => now,
        });
        const result = await runner.runOnce();
        registry.handlesFor(sessionId)?.dispose();
        return result;
      };

      const assertSavedSession = () => {
        const store = openSessionStore(accessManager.grant(principal, "session-store"));
        const entries = store.readSession(sessionId);
        expect(entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
        expect(
          entries.filter((entry) => entry.kind === "assistant" && entry.text === "Saved scheduled response"),
        ).toHaveLength(1);
        expect(store.getSession(sessionId)?.scheduled).toMatchObject({ outcome: "completed" });
        store.close();
      };
      const outboxCount = () => {
        const db = new Database(join(root, principal.userId, "scheduling-v1", "schedules.db"));
        const count = db.query<{ count: number }, []>("SELECT count(*) count FROM content_outbox").get()?.count;
        db.close();
        return count;
      };

      if (item.name === "monthly") {
        let completedReceiptObserved = false;
        const failOnceFinalizer: Parameters<typeof createScheduledChatRunner>[0]["finalizer"] = {
          async finalizeClaim(_claim, receipt) {
            expect(receipt).toMatchObject({ outcome: "completed", sessionId });
            completedReceiptObserved = true;
            return { ok: false, error: { code: "unavailable", retryable: true } };
          },
        };
        expect(await run(schedules, new Date(dueMs + 60_000), failOnceFinalizer)).toEqual({
          ok: false,
          error: { code: "unavailable", retryable: true },
        });
        expect(completedReceiptObserved).toBe(true);
        expect(runtimeFixture.providerCalls).toHaveLength(1);
        assertSavedSession();
        expect(outboxCount()).toBe(0);
        const unconsumed = await schedules.list(resource, undefined, 100);
        expect(unconsumed.ok && unconsumed.value.schedules).toHaveLength(1);

        await scheduler.close();
        schedules.close();
        persistence.close();
        persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), caseConfig);
        schedules = createScheduleService({ userDataRoot: root, id: () => `${item.name}-restart-${++sequence}` });
        scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: caseConfig });
        runtimeFixture = createTextRuntimeFixture(accessManager);
        expect(
          (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date(dueMs + 121_000))).ok,
        ).toBe(true);
        expect(await run(schedules, new Date(dueMs + 121_000))).toEqual({
          ok: true,
          value: { claimed: 1, finalized: 1 },
        });
        expect(runtimeFixture.providerCalls).toHaveLength(0);
        assertSavedSession();
        expect(outboxCount()).toBe(1);
        const consumed = await schedules.list(resource, undefined, 100);
        expect(consumed.ok && consumed.value.schedules).toEqual([]);
        expect(
          (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date(dueMs + 122_000))).ok,
        ).toBe(true);
        expect(await run(schedules, new Date(dueMs + 122_000))).toEqual({
          ok: true,
          value: { claimed: 0, finalized: 0 },
        });
        expect(outboxCount()).toBe(1);
      } else {
        expect(await run(schedules, new Date(dueMs + 60_000))).toEqual({
          ok: true,
          value: { claimed: 1, finalized: 1 },
        });
        expect(runtimeFixture.providerCalls).toHaveLength(1);
        assertSavedSession();
        expect(outboxCount()).toBe(1);
        const remaining = await schedules.list(resource, undefined, 100);
        expect(remaining.ok && remaining.value.schedules).toEqual([]);

        await scheduler.close();
        schedules.close();
        persistence.close();
        persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), caseConfig);
        schedules = createScheduleService({ userDataRoot: root, id: () => `${item.name}-restart-${++sequence}` });
        scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: caseConfig });
        expect(
          (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date(dueMs + 2 * 60_000))).ok,
        ).toBe(true);
        expect(await run(schedules, new Date(dueMs + 2 * 60_000))).toEqual({
          ok: true,
          value: { claimed: 0, finalized: 0 },
        });
        expect(runtimeFixture.providerCalls).toHaveLength(1);
        assertSavedSession();
        expect(outboxCount()).toBe(1);
      }
      await scheduler.close();
      schedules.close();
      persistence.close();
    }
  });

  test("denies stale claimed calendar authority before allocating a real runtime", async () => {
    const cases = ["cancelled", "revoked", "missing-user", "spoofed-owner", "non-generated", "moved-old"] as const;
    for (const kind of cases) {
      const root = mkdtempSync(join(tmpdir(), `calendar-reminder-denial-${kind}-`));
      roots.push(root);
      const caseConfig = { ...config, defaultEventTimeZoneId: "UTC" as never };
      const accessManager = createAccessManager({ userDataRoot: root });
      const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
      const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), caseConfig);
      let sequence = 0;
      const schedules = createScheduleService({ userDataRoot: root, id: () => `${kind}-${++sequence}` });
      const scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: caseConfig });
      const created = createCalendarEvent(
        {
          title: "Claimed reminder",
          start: "2028-01-01T14:00:00Z" as never,
          visibility: "everyone",
          importance: "normal",
          tags: [],
          recurrence: { frequency: "daily", count: 2 },
          reminder: { enabled: true, mode: "lead", leadMinutes: 30 },
        },
        persistence,
        caseConfig,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      const due = new Date("2028-01-02T13:30:00.000Z");
      expect(
        (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date(due.getTime() - 60_000))).ok,
      ).toBe(true);
      let activeUser = true;
      const authorizer = createScheduledExecutionAuthorizer({
        users: {
          get: async () => ({
            ok: true as const,
            value: activeUser
              ? {
                  userId: principal.userId,
                  role: "adult" as const,
                  displayName: "Owner",
                  pinHash: "test-only",
                  avatarTint: "sage" as const,
                  createdAt: "2026-01-01T00:00:00Z",
                  credentialsValidFrom: "2026-01-01T00:00:00Z",
                }
              : null,
          }),
        },
        accessManager,
        householdId: "home",
        authorizeCalendarReminder: (execution, signal) =>
          authorizeCalendarReminderExecution(execution, { accessManager, calendarConfig: caseConfig }, signal),
      });
      const runtimeFixture = createTextRuntimeFixture(accessManager);
      const sessionId = `s_${kind.replace("-", "").padEnd(32, "a")}`;
      const registry = createSessionRegistry(() => {});
      const submitter = createScheduledMessageSubmitter({
        accessManager,
        registry,
        associateSession: (claim, id) => schedules.associateSession(claim, id),
        makeSessionId: () => sessionId,
        now: () => new Date(due.getTime() + 60_000),
        buildHandles: runtimeFixture.buildHandles,
      });
      const claims: Parameters<typeof createScheduledChatRunner>[0]["claims"] = {
        async claimDue(now, limit, leaseMs) {
          const result = await schedules.claimDue(now, limit, leaseMs);
          if (!result.ok || !result.value[0]) return result;
          const claim = result.value[0];
          if (kind === "cancelled") {
            expect(
              mutateCalendarEvent(
                {
                  operation: "delete",
                  eventId: created.value.eventId,
                  applyTo: "this_occurrence",
                  originalStart: "2028-01-02T14:00:00Z",
                } as CalendarMutationCommand,
                persistence,
                caseConfig,
              ).ok,
            ).toBe(true);
          } else if (kind === "revoked") {
            expect(
              mutateCalendarEvent(
                {
                  operation: "update",
                  eventId: created.value.eventId,
                  applyTo: "entire_series",
                  changes: { reminder: { enabled: false } },
                } as CalendarMutationCommand,
                persistence,
                caseConfig,
              ).ok,
            ).toBe(true);
          } else if (kind === "missing-user") activeUser = false;
          else if (kind === "moved-old") {
            expect(
              mutateCalendarEvent(
                {
                  operation: "update",
                  eventId: created.value.eventId,
                  applyTo: "this_occurrence",
                  originalStart: "2028-01-02T14:00:00Z",
                  changes: { start: "2028-01-02T15:00:00Z" },
                } as CalendarMutationCommand,
                persistence,
                caseConfig,
              ).ok,
            ).toBe(true);
          }
          if (claim.source.kind !== "calendar-reminder") return result;
          if (kind === "spoofed-owner")
            return {
              ok: true,
              value: [
                {
                  ...claim,
                  source: {
                    ...claim.source,
                    reminderId: `${created.value.eventId}:u_bbbbbbbb:2028-01-02T14:00:00.000Z`,
                  },
                },
              ],
            };
          if (kind === "non-generated")
            return {
              ok: true,
              value: [
                {
                  ...claim,
                  source: {
                    ...claim.source,
                    reminderId: `${created.value.eventId}:${principal.userId}:2028-01-03T14:00:00.000Z`,
                  },
                },
              ],
            };
          return result;
        },
      };
      const runner = createScheduledChatRunner({
        claims,
        authorizer,
        submitter,
        finalizer: schedules,
        claimLimit: 1,
        leaseMs: 60_000,
        pollMs: 10,
        now: () => new Date(due.getTime() + 60_000),
      });
      expect(await runner.runOnce()).toEqual({ ok: true, value: { claimed: 1, finalized: 1 } });
      expect(runtimeFixture.buildHandlesCalls()).toBe(0);
      expect(runtimeFixture.providerCalls).toHaveLength(0);
      const deniedStore = openSessionStore(accessManager.grant(principal, "session-store"));
      expect(deniedStore.listSessions()).toEqual([]);
      deniedStore.close();
      const victim = createUserPrincipal("u_bbbbbbbb", "adult", "home");
      const victimStore = openSessionStore(accessManager.grant(victim, "session-store"));
      expect(victimStore.listSessions()).toEqual([]);
      victimStore.close();

      if (kind === "moved-old") {
        expect(
          (
            await scheduler.reconcile(
              persistence,
              created.value.eventId,
              "private",
              new Date("2028-01-02T14:29:00.000Z"),
              "2028-01-02T14:00:00Z",
            )
          ).ok,
        ).toBe(true);
        const validRunner = createScheduledChatRunner({
          claims: schedules,
          authorizer,
          submitter,
          finalizer: schedules,
          claimLimit: 1,
          leaseMs: 60_000,
          pollMs: 10,
          now: () => new Date("2028-01-02T14:31:00.000Z"),
        });
        expect(await validRunner.runOnce()).toEqual({ ok: true, value: { claimed: 1, finalized: 1 } });
        expect(runtimeFixture.buildHandlesCalls()).toBe(1);
        expect(runtimeFixture.providerCalls).toHaveLength(1);
        registry.handlesFor(sessionId)?.dispose();
      }
      await scheduler.close();
      schedules.close();
      persistence.close();
    }
  });

  test("does not delete a linked reminder when calendar storage is transiently unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-io-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => "linked",
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    const created = createCalendarEvent(
      {
        title: "Dentist",
        start: "2026-05-01T14:00:00Z" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2026-01-01T00:00:00Z"))).ok,
    ).toBe(true);
    persistence.close();
    const failed = await scheduler.reconcile(persistence, created.value.eventId, "private");
    expect(failed).toEqual({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toHaveLength(1);
    schedules.close();
  });

  test("recovers durable reconciliation work after a schedule-store failure and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-recovery-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    let persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => "recovered",
    });
    const created = createCalendarEvent(
      {
        title: "Recovery appointment",
        start: "2026-12-10T14:00:00Z" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const unavailable = createCalendarReminderScheduler({
      schedules: {
        ...schedules,
        reconcileCalendarReminder: async () => ({
          ok: false as const,
          error: { code: "unavailable" as const, retryable: true },
        }),
      },
      accessManager,
      calendarConfig: config,
    });
    expect((await unavailable.reconcile(persistence, created.value.eventId, "private")).ok).toBe(false);
    persistence.close();

    persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const recovered = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    expect((await recovered.reconcilePending(persistence, "private")).ok).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toHaveLength(1);
    schedules.close();
    persistence.close();
  });

  test("does not acknowledge a newer mutation completed during reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-generation-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => "generation",
    });
    const created = createCalendarEvent(
      {
        title: "Original title",
        start: "2026-12-10T14:00:00Z" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    let mutated = false;
    const scheduler = createCalendarReminderScheduler({
      schedules: {
        ...schedules,
        reconcileCalendarReminder: async (...args) => {
          if (!mutated) {
            mutated = true;
            expect(
              mutateCalendarEvent(
                {
                  operation: "update",
                  eventId: created.value.eventId,
                  applyTo: "entire_series",
                  changes: { title: "Newer title" },
                } as CalendarMutationCommand,
                persistence,
                config,
              ).ok,
            ).toBe(true);
          }
          return schedules.reconcileCalendarReminder(...args);
        },
      },
      accessManager,
      calendarConfig: config,
    });
    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2026-01-01T00:00:00Z"))).ok,
    ).toBe(true);
    expect(persistence.reminderReconciliation?.(created.value.eventId as never)).toMatchObject({
      ok: true,
      value: { generation: 2 },
    });
    schedules.close();
    persistence.close();
  });

  test("projects a recurring calendar reminder as one persistent subscription", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-boundary-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    let sequence = 0;
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => `linked-${++sequence}`,
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    const created = createCalendarEvent(
      {
        title: "Early Monday",
        start: "2026-05-04T00:15:00-04:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        recurrence: { frequency: "weekly", weekdays: ["monday"], count: 10 },
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const reconciliation = await scheduler.reconcile(
      persistence,
      created.value.eventId,
      "private",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(reconciliation.ok).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toHaveLength(1);
    expect(listed.ok && listed.value.schedules[0]).toMatchObject({
      timing: {
        kind: "recurring",
        frequency: "weekly",
        weekdays: ["monday"],
        localTime: "00:15",
        timeZone: "America/Toronto",
      },
      source: { reminderId: `${created.value.eventId}:u_aaaaaaaa` },
      nextRunAt: "2026-05-04T04:15:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    schedules.close();
    persistence.close();
  });

  test("household edits reconcile reminder schedules owned by other members", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-household-"));
    roots.push(root);
    const userDataRoot = join(root, "users");
    const accessManager = createAccessManager({
      userDataRoot,
      sharedDataRoot: join(root, "shared"),
    });
    const first = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const second = createUserPrincipal("u_bbbbbbbb", "adult", "home");
    const firstStore = openCalendarPersistence(accessManager.grant(first, "calendar-household"), config);
    const secondStore = openCalendarPersistence(accessManager.grant(second, "calendar-household"), config);
    const schedules = createScheduleService({ userDataRoot });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
      resolveUser: async () => ({ role: "adult", householdId: "home" }),
    });
    const created = createCalendarEvent(
      {
        title: "Household appointment",
        start: "2026-10-05T10:00:00-04:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        reminder: { enabled: true, mode: "at-start" },
        scope: "household",
      },
      firstStore,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const secondReminder = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        changes: { reminder: { enabled: true, mode: "at-start" } },
        scope: "household",
      } as CalendarMutationCommand,
      secondStore,
      config,
    );
    expect(secondReminder.ok).toBe(true);
    expect((await scheduler.reconcile(secondStore, created.value.eventId, "household")).ok).toBe(true);
    const moved = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        changes: { start: "2026-10-05T12:00:00-04:00" },
        scope: "household",
      } as CalendarMutationCommand,
      firstStore,
      config,
    );
    expect(moved.ok).toBe(true);
    expect((await scheduler.reconcile(firstStore, created.value.eventId, "household")).ok).toBe(true);
    const secondResource = new PrivateScheduleResource(accessManager.grant(second, "schedule-private"));
    const listed = await schedules.list(secondResource, undefined, 10);
    expect(listed.ok && listed.value.schedules[0]?.timing).toEqual({
      kind: "once",
      at: "2026-10-05T16:00:00.000Z",
    });
    schedules.close();
    firstStore.close();
    secondStore.close();
  });

  test("cancels a child's trusted household reminder when visibility is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-visibility-"));
    roots.push(root);
    const userDataRoot = join(root, "users");
    const accessManager = createAccessManager({
      userDataRoot,
      sharedDataRoot: join(root, "shared"),
    });
    const adult = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const child = createUserPrincipal("u_bbbbbbbb", "child", "home");
    const adultStore = openCalendarPersistence(accessManager.grant(adult, "calendar-household"), config);
    const childStore = openCalendarPersistence(accessManager.grant(child, "calendar-household"), config);
    const schedules = createScheduleService({ userDataRoot });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
      resolveUser: async (userId) => ({
        role: userId === child.userId ? "child" : "adult",
        householdId: "home",
      }),
    });
    const created = createCalendarEvent(
      {
        title: "Visible appointment",
        start: "2026-12-05T10:00:00-05:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        scope: "household",
      },
      adultStore,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const optedIn = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        scope: "household",
        changes: { reminder: { enabled: true, mode: "at-start" } },
      } as CalendarMutationCommand,
      childStore,
      config,
    );
    expect(optedIn.ok).toBe(true);
    expect((await scheduler.reconcile(childStore, created.value.eventId, "household")).ok).toBe(true);
    const hidden = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        scope: "household",
        changes: { visibility: "adults" },
      } as CalendarMutationCommand,
      adultStore,
      config,
    );
    expect(hidden.ok).toBe(true);
    expect((await scheduler.reconcile(adultStore, created.value.eventId, "household")).ok).toBe(true);
    const childResource = new PrivateScheduleResource(accessManager.grant(child, "schedule-private"));
    const listed = await schedules.list(childResource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toEqual([]);
    schedules.close();
    adultStore.close();
    childStore.close();
  });

  test("shutdown waits for the active reminder recovery pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-close-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const schedules = createScheduleService({ userDataRoot: root });
    let releaseUsers: (users: readonly []) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const users = new Promise<readonly []>((resolve) => {
      releaseUsers = resolve;
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
      listUsers: async () => {
        markStarted();
        return users;
      },
    });

    await started;
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseUsers([]);
    await closing;
    expect(closed).toBe(true);
    schedules.close();
  });

  test("retains an older recurring reminder beyond the bounded expansion horizon", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-horizon-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const creationConfig = {
      ...config,
      recurrence: { maxOccurrences: 200, maxDays: 4_000 },
    };
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), creationConfig);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: () => "linked-horizon",
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    const created = createCalendarEvent(
      {
        title: "Long running meeting",
        start: "2020-01-01T10:00:00-05:00" as never,
        end: "2020-01-01T11:00:00-05:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        recurrence: { frequency: "monthly", count: 100 },
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      creationConfig,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2026-01-15T00:00:00Z"))).ok,
    ).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({
          reminderId: `${created.value.eventId}:u_aaaaaaaa`,
        }),
      }),
    ]);
    if (!listed.ok || !listed.value.schedules[0]) return;
    const scheduled = listed.value.schedules[0];
    const authorized = await authorizeCalendarReminderExecution(
      {
        principal,
        resource,
        claim: {
          claimToken: "claim",
          scheduleId: scheduled.scheduleId,
          occurrenceId: "occurrence",
          ownerUserId: principal.userId,
          source: scheduled.source,
          intendedAt: "2026-02-01T15:00:00.000Z",
          claimedUntil: "2026-02-01T15:01:00.000Z",
          message: scheduled.message,
          oneTime: false,
        },
      },
      { accessManager, calendarConfig: config },
      new AbortController().signal,
    );
    expect(authorized.ok).toBe(true);
    scheduler.close();
    schedules.close();
    persistence.close();
  });

  test("replenishes shifted monthly reminders from the original long-running series phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-rolling-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const creationConfig = { ...config, recurrence: { maxOccurrences: 500, maxDays: 6_000 } };
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), creationConfig);
    let sequence = 0;
    const schedules = createScheduleService({ userDataRoot: root, id: () => `rolling-${++sequence}` });
    const scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: config });
    const created = createCalendarEvent(
      {
        title: "Month opening",
        start: "2020-01-01T10:00:00-05:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        recurrence: { frequency: "monthly", until: "2035-01-01" as never },
        reminder: { enabled: true, mode: "lead", leadMinutes: 1_440 },
      },
      persistence,
      creationConfig,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const now = new Date("2028-02-01T00:00:00Z");
    expect((await scheduler.reconcile(persistence, created.value.eventId, "private", now)).ok).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const first = await schedules.list(resource, undefined, 100);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const targetTimes = new Set(["2028-02-29T15:00:00.000Z", "2028-03-31T14:00:00.000Z", "2028-04-30T14:00:00.000Z"]);
    expect(
      first.value.schedules.filter((item) => item.timing.kind === "once" && targetTimes.has(item.timing.at)),
    ).toHaveLength(3);
    expect(first.value.schedules.every((item) => item.timing.kind === "once")).toBe(true);

    expect((await scheduler.reconcile(persistence, created.value.eventId, "private", now)).ok).toBe(true);
    const repeated = await schedules.list(resource, undefined, 100);
    expect(repeated.ok && repeated.value.schedules).toHaveLength(first.value.schedules.length);

    // Reconciliation must move its bounded window with time. Keeping only the
    // first projected jobs would still pass the old-series assertion above but
    // lose reminders once that projection expires.
    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2031-02-01T00:00:00Z"))).ok,
    ).toBe(true);
    const replenished = await schedules.list(resource, undefined, 100);
    expect(replenished.ok).toBe(true);
    if (!replenished.ok) return;
    const replenishedTargets = new Set([
      "2031-02-28T15:00:00.000Z",
      "2031-03-31T14:00:00.000Z",
      "2031-04-30T14:00:00.000Z",
    ]);
    expect(
      replenished.value.schedules.filter(
        (item) => item.timing.kind === "once" && replenishedTargets.has(item.timing.at),
      ),
    ).toHaveLength(3);
    expect(
      replenished.value.schedules.some((item) => item.timing.kind === "once" && targetTimes.has(item.timing.at)),
    ).toBe(false);
    scheduler.close();
    schedules.close();
    persistence.close();
  });

  test("moves a recurring occurrence reminder without leaving the base wake eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-reminder-move-"));
    roots.push(root);
    const accessManager = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const persistence = openCalendarPersistence(accessManager.grant(principal, "calendar-private"), config);
    const schedules = createScheduleService({
      userDataRoot: root,
      id: (() => {
        let sequence = 0;
        return () => `linked-${++sequence}`;
      })(),
    });
    const scheduler = createCalendarReminderScheduler({
      schedules,
      accessManager,
      calendarConfig: config,
    });
    const created = createCalendarEvent(
      {
        title: "Medicine",
        start: "2026-05-01T10:00:00-04:00" as never,
        end: "2026-05-01T11:00:00-04:00" as never,
        visibility: "everyone",
        importance: "normal",
        tags: [],
        recurrence: { frequency: "daily", count: 3 },
        reminder: { enabled: true, mode: "at-start" },
      },
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      (await scheduler.reconcile(persistence, created.value.eventId, "private", new Date("2026-01-01T00:00:00Z"))).ok,
    ).toBe(true);
    const moved = mutateCalendarEvent(
      {
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "this_occurrence",
        originalStart: "2026-05-02T10:00:00-04:00",
        changes: { start: "2026-05-02T12:00:00-04:00" },
      } as CalendarMutationCommand,
      persistence,
      config,
    );
    expect(moved.ok).toBe(true);
    expect(
      (
        await scheduler.reconcile(
          persistence,
          created.value.eventId,
          "private",
          new Date("2026-01-01T00:00:00Z"),
          "2026-05-02T10:00:00-04:00",
        )
      ).ok,
    ).toBe(true);
    const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const listed = await schedules.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timing: { kind: "once", at: "2026-05-02T16:00:00.000Z" },
          source: expect.objectContaining({
            reminderId: expect.stringContaining("2026-05-02T14:00:00.000Z"),
          }),
        }),
      ]),
    );
    schedules.close();
    persistence.close();
  });
});
