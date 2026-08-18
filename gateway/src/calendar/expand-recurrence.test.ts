import { describe, expect, test } from "bun:test";
import { expandRecurrence } from "./expand-recurrence.js";
import type { CalendarEvent, UtcInstant } from "./types.js";

const timed = (instant: string, timeZoneId: string) => ({ kind: "timed" as const, instant: instant as UtcInstant, timeZoneId: timeZoneId as never });
const event = (start: CalendarEvent["start"], recurrence: string): CalendarEvent => ({
  id: "family" as CalendarEvent["id"], title: "event", start,
  recurrence: { rrule: recurrence, rule: undefined as never },
  visibility: "everyone", importance: "normal", tags: new Set(),
  createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant, updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
});

describe("expandRecurrence", () => {
  test("expands COUNT weekly BYDAY with inclusive bounds", () => {
    const e = event(timed("2026-01-05T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10");
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z", "America/Toronto"), timed("2026-03-31T23:59:59.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(10);
  });

  test("does not count pre-DTSTART BYDAY candidates", () => {
    const e = event(timed("2026-08-05T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10");
    const result = expandRecurrence(e, timed("2026-08-01T00:00:00.000Z", "America/Toronto"), timed("2026-10-31T23:59:59.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(10);
  });

  test("keeps a timed event at its local hour across DST", () => {
    const e = event(timed("2026-03-02T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    const result = expandRecurrence(e, timed("2026-03-01T00:00:00.000Z", "America/Toronto"), timed("2026-03-31T23:59:59.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((x) => x.start.kind === "timed" && x.start.instant)).toEqual([
      "2026-03-02T14:00:00.000Z" as UtcInstant, "2026-03-09T13:00:00.000Z" as UtcInstant, "2026-03-16T13:00:00.000Z" as UtcInstant,
    ]);
  });
});
