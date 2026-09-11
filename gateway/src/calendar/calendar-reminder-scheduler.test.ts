import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createScheduleService } from "../scheduling/service.js";
import { createCalendarEvent, mutateCalendarEvent } from "./calendar-mutations.js";
import { createCalendarReminderScheduler } from "./calendar-reminder-scheduler.js";
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
    const schedules = createScheduleService({ userDataRoot: root, id: () => "linked" });
    const scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: config });
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
    const scheduler = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: config });
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
    expect((await scheduler.reconcile(persistence, created.value.eventId, "private")).ok).toBe(true);
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
          source: expect.objectContaining({ reminderId: expect.stringContaining("2026-05-02T14:00:00.000Z") }),
        }),
      ]),
    );
    schedules.close();
    persistence.close();
  });
});
