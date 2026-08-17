import { describe, expect, test } from "bun:test";
import { goldenCalendarFixtures, isAdult, parseRRule, wireCalendarTimeSchema } from "./types.js";

describe("calendar domain contracts", () => {
  test("accepts only the bounded RRULE subset", () => {
    expect(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6").ok).toBe(true);
    expect(parseRRule("FREQ=DAILY;INTERVAL=2;UNTIL=20260805T120000Z").ok).toBe(true);
    expect(parseRRule("FREQ=WEEKLY").ok).toBe(false);
    expect(parseRRule("FREQ=DAILY;COUNT=2;UNTIL=20260805T120000Z").ok).toBe(false);
    expect(parseRRule("FREQ=HOURLY").ok).toBe(false);
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
