import { describe, expect, test } from "bun:test";
import {
  calendarEventSchema,
  calendarRequestSchema,
  calendarResponseSchema,
  goldenCalendarFixtures,
  isAdult,
  parseRRule,
  wireCalendarTimeSchema,
} from "./types.js";

describe("calendar domain contracts", () => {
  test("accepts only the bounded RRULE subset", () => {
    expect(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6").ok).toBe(true);
    expect(parseRRule("FREQ=DAILY;INTERVAL=2;UNTIL=20260805T120000Z").ok).toBe(true);
    expect(parseRRule("FREQ=DAILY;UNTIL=20261231T235959Z")).toMatchObject({
      ok: true,
      value: { freq: "DAILY", until: "2026-12-31T23:59:59.000Z" },
    });
    expect(parseRRule("FREQ=WEEKLY").ok).toBe(false);
    expect(parseRRule("FREQ=DAILY;COUNT=2;UNTIL=20260805T120000Z").ok).toBe(false);
    expect(parseRRule("FREQ=HOURLY").ok).toBe(false);
    expect(parseRRule("FREQ=WEEKLY;BYDAY=MO;BYMONTH=1")).toEqual({ ok: false, error: "invalid" });
  });

  test("keeps timed values UTC plus event zone and all-day values date-only", () => {
    expect(JSON.stringify(wireCalendarTimeSchema.parse(goldenCalendarFixtures.timed as unknown))).toBe(
      JSON.stringify(goldenCalendarFixtures.timed),
    );
    expect(JSON.stringify(wireCalendarTimeSchema.parse(goldenCalendarFixtures.allDay as unknown))).toBe(
      JSON.stringify(goldenCalendarFixtures.allDay),
    );
    expect(() =>
      wireCalendarTimeSchema.parse({ kind: "all-day", date: "2026-08-05", timeZoneId: "UTC" } as unknown),
    ).toThrow();
  });

  test("admin is adult-equivalent but has no separate bypass", () => {
    expect(isAdult("adult")).toBe(true);
    expect(isAdult("admin")).toBe(true);
    expect(isAdult("child")).toBe(false);
    expect(isAdult("guest")).toBe(false);
  });

  test("wire envelopes reject arbitrary bodies and accept a golden-shaped event", () => {
    expect(
      calendarRequestSchema.safeParse({ version: 1, requestId: "req-1", operation: "get", body: {} }).success,
    ).toBe(false);
    expect(
      calendarResponseSchema.safeParse({ version: 1, requestId: "req-1", body: { arbitrary: true } }).success,
    ).toBe(false);

    const event = {
      id: "event-1",
      scope: "private",
      title: "Dentist",
      start: goldenCalendarFixtures.timed,
      recurrence: {
        rrule: goldenCalendarFixtures.recurrence,
        rule: { freq: "WEEKLY", byDay: ["MO", "WE"], count: 6 },
      },
      visibility: "everyone",
      importance: "normal",
      tags: ["health"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const request = (body: unknown) =>
      calendarRequestSchema.safeParse({ version: 1, requestId: "req-1", operation: "create", body }).success;
    expect(request(event)).toBe(true);
    expect(request({ ...event, recurrence: { ...event.recurrence, rrule: "GIBBERISH" } })).toBe(false);
    expect(request({ ...event, recurrence: { ...event.recurrence, rrule: "FREQ=WEEKLY;BYDAY=MO;BYMONTH=1" } })).toBe(
      false,
    );
    expect(
      request({ ...event, recurrence: { ...event.recurrence, rule: { ...event.recurrence.rule, count: 5 } } }),
    ).toBe(false);
    expect(calendarResponseSchema.safeParse({ version: 1, requestId: "req-1", body: event }).success).toBe(true);

    for (const until of ["2026-12-31T23:59:59.000Z", "2026-12-31T23:59:59Z", "2026-12-31T23:59:59+00:00"]) {
      const untilEvent = {
        ...event,
        recurrence: {
          rrule: "FREQ=DAILY;UNTIL=20261231T235959Z",
          rule: { freq: "DAILY", until },
        },
      };
      expect(calendarEventSchema.safeParse(untilEvent).success).toBe(true);
      expect(request(untilEvent)).toBe(true);
    }
  });

  test("golden wire fixtures remain stable", () => {
    expect(JSON.stringify(goldenCalendarFixtures)).toBe(
      JSON.stringify({
        timed: { kind: "timed", instant: "2026-08-05T13:00:00.000Z", timeZoneId: "America/Toronto" },
        allDay: { kind: "all-day", date: "2026-08-05" },
        recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      }),
    );
  });
});
