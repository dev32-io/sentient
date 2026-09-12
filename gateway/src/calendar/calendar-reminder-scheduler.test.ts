import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createScheduleService } from "../scheduling/service.js";
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
    const creationConfig = { ...config, recurrence: { maxOccurrences: 500, maxDays: 4_000 } };
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
        recurrence: { frequency: "monthly", until: "2029-01-01" as never },
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
