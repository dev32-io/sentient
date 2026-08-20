import { describe, expect, test } from "bun:test";
import {
  calendarCreateInputSchema,
  calendarErrorSchema,
  calendarEventSchema,
  calendarMutationCommandSchema,
  calendarMutationResultSchema,
  calendarOccurrenceChangesSchema,
  calendarOccurrenceProjectionSchema,
  calendarPageSchema,
  calendarQueryInputSchema,
  calendarRecurrenceInputSchema,
  calendarRequestSchema,
  calendarResponseSchema,
  calendarTimeInputSchema,
  calendarUpdateChangesSchema,
  goldenCalendarFixtures,
  isAdult,
  isValidCalendarDate,
  parseRRule,
  wireCalendarTimeSchema,
} from "./types.js";

describe("calendar V2 contracts", () => {
  test("accepts model-friendly bounded times and rejects CalendarTime objects", () => {
    for (const value of ["2026", "2026-08", "2026-08-05", "2026-08-05T09:00-04:00", "2026-08-05T13:00:01.125Z"]) {
      expect(calendarTimeInputSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["2026-02-31", "2026-08-05T25:00Z", "2026-08-05T09:00", "2026-08-05T09:00:00.1234567890Z", { kind: "timed", instant: "2026-08-05T13:00:00.000Z", timeZoneId: "UTC" }]) {
      expect(calendarTimeInputSchema.safeParse(value).success).toBe(false);
    }
    expect(wireCalendarTimeSchema.safeParse(goldenCalendarFixtures.timed).success).toBe(true);
    expect(isValidCalendarDate(2026, 2, 31)).toBe(false);
  });

  test("requires exactly one recurrence bound and full weekday names", () => {
    expect(calendarRecurrenceInputSchema.safeParse(goldenCalendarFixtures.recurrenceInput).success).toBe(true);
    expect(calendarRecurrenceInputSchema.safeParse({ frequency: "daily", count: 2, until: "2026-12-31" }).success).toBe(false);
    expect(calendarRecurrenceInputSchema.safeParse({ frequency: "weekly", count: 2 }).success).toBe(false);
    expect(calendarRecurrenceInputSchema.safeParse({ frequency: "monthly", weekdays: ["monday"], count: 2 }).success).toBe(false);
    expect(calendarRecurrenceInputSchema.safeParse({ frequency: "daily", count: 2, extra: true }).success).toBe(false);
    expect(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6").ok).toBe(true);
  });

  test("defines private/household/all reads and private/household writes", () => {
    expect(calendarQueryInputSchema.safeParse({ from: "2026-08-01", to: "2026-08-31", scope: "all" }).success).toBe(true);
    expect(calendarCreateInputSchema.safeParse(goldenCalendarFixtures.create).success).toBe(true);
    expect(calendarCreateInputSchema.safeParse({ ...goldenCalendarFixtures.create, scope: "all" }).success).toBe(false);
    expect(calendarCreateInputSchema.safeParse({ ...goldenCalendarFixtures.create, scope: undefined }).success).toBe(true);
  });

  test("keeps occurrence identity separate from event identity", () => {
    const occurrence = calendarOccurrenceProjectionSchema.parse(goldenCalendarFixtures.occurrence);
    expect(occurrence.eventId).not.toBe(occurrence.occurrenceId);
    expect(calendarPageSchema.safeParse(goldenCalendarFixtures.page).success).toBe(true);
    expect(calendarPageSchema.safeParse({ events: [], more: 0 }).success).toBe(false);
  });

  test("requires applyTo and restricts occurrence-local changes", () => {
    const target = { operation: "update", eventId: "event-example", originalStart: "2026-08-10T09:00-04:00" } as const;
    expect(calendarMutationCommandSchema.safeParse({ ...target, applyTo: "this_occurrence", changes: { title: "Moved", description: null, end: null, group: null, tags: [] } }).success).toBe(true);
    expect(calendarMutationCommandSchema.safeParse({ ...target, changes: { title: "Missing scope" } }).success).toBe(false);
    expect(calendarMutationCommandSchema.safeParse({ ...target, applyTo: "this_occurrence", changes: { recurrence: null } }).success).toBe(false);
    expect(calendarMutationCommandSchema.safeParse({ ...target, applyTo: "this_and_following", changes: { recurrence: { frequency: "weekly", weekdays: ["friday"], count: 3 } } }).success).toBe(true);
    expect(calendarMutationCommandSchema.safeParse({ operation: "delete", eventId: "event-example", applyTo: "entire_series" }).success).toBe(true);
    expect(calendarMutationCommandSchema.safeParse({ operation: "delete", eventId: "event-example" }).success).toBe(false);
    expect(calendarMutationCommandSchema.safeParse({ ...target, applyTo: "entire_series", changes: { eventId: "other" } }).success).toBe(false);
  });

  test("supports rich clear semantics without allowing forbidden fields", () => {
    expect(calendarUpdateChangesSchema.safeParse({ description: null, end: null, group: null, recurrence: null, tags: [] }).success).toBe(true);
    expect(calendarOccurrenceChangesSchema.safeParse({ description: null, end: null, group: null, tags: [] }).success).toBe(true);
    expect(calendarOccurrenceChangesSchema.safeParse({ scope: "household" }).success).toBe(false);
    expect(calendarOccurrenceChangesSchema.safeParse({ revision: 4 }).success).toBe(false);
    expect(calendarOccurrenceChangesSchema.safeParse({ notificationPolicy: null }).success).toBe(false);
    expect(calendarOccurrenceChangesSchema.safeParse({ recurrence: null }).success).toBe(false);
  });

  test("pins V2 envelopes, pages, mutations, and stable errors", () => {
    expect(calendarMutationResultSchema.safeParse(goldenCalendarFixtures.mutation).success).toBe(true);
    expect(calendarErrorSchema.safeParse(goldenCalendarFixtures.error).success).toBe(true);
    expect(calendarEventSchema.safeParse({
      eventId: "event-example", revision: 3, ...goldenCalendarFixtures.create,
    }).success).toBe(true);
    expect(calendarResponseSchema.safeParse({ version: 2, requestId: "r1", body: goldenCalendarFixtures.page }).success).toBe(true);
    expect(calendarRequestSchema.safeParse({ version: 2, requestId: "r1", operation: "list", body: { from: "2026", to: "2026-12" } }).success).toBe(true);
    expect(calendarRequestSchema.safeParse({ version: 1, requestId: "r1", operation: "list", body: { from: "2026", to: "2026-12" } }).success).toBe(false);
    expect(calendarRequestSchema.safeParse({ version: 2, requestId: "r1", operation: "update", body: { eventId: "event-example", applyTo: "this_occurrence", changes: { title: "x" } } }).success).toBe(true);
    expect(calendarRequestSchema.safeParse({ version: 2, requestId: "r1", operation: "update", body: { id: "event-example", patch: { title: "old" } } }).success).toBe(false);
  });

  test("admin is adult-equivalent but has no separate bypass", () => {
    expect(isAdult("adult")).toBe(true);
    expect(isAdult("admin")).toBe(true);
    expect(isAdult("child")).toBe(false);
    expect(isAdult("guest")).toBe(false);
  });
});
