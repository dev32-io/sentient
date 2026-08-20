import { describe, expect, test } from "bun:test";
import { expandRecurrence } from "./expand-recurrence.js";
import type { StoredCalendarEvent, UtcInstant } from "./types.js";

const timed = (instant: string, timeZoneId = "UTC") => ({ kind: "timed" as const, instant: instant as UtcInstant, timeZoneId: timeZoneId as never });
const event = (start: StoredCalendarEvent["start"], recurrence: string): StoredCalendarEvent => ({
  id: "family" as StoredCalendarEvent["id"], title: "event", start,
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

  test("resolves the household timezone sentinel during expansion", () => {
    const e = event(timed("2026-08-05T14:00:00.000Z", "household"), "FREQ=DAILY;COUNT=2");
    const result = expandRecurrence(
      e,
      timed("2026-08-01T00:00:00.000Z", "household"),
      timed("2026-08-20T23:59:59.000Z", "household"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value.every((item) => item.start.kind === "timed" && item.start.timeZoneId === "household")).toBe(true);
    }
  });

  test("does not count pre-DTSTART BYDAY candidates", () => {
    const e = event(timed("2026-08-05T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10");
    const result = expandRecurrence(e, timed("2026-08-01T00:00:00.000Z", "America/Toronto"), timed("2026-10-31T23:59:59.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(10);
  });

  test("returns recurrence-limit rather than partial occurrences when maxOccurrences is exceeded", () => {
    const e = event(timed("2026-01-01T14:00:00.000Z", "UTC"), "FREQ=DAILY;COUNT=10");
    const result = expandRecurrence(
      e,
      timed("2026-01-01T00:00:00.000Z", "UTC"),
      timed("2026-01-31T23:59:59.000Z", "UTC"),
      { maxOccurrences: 3, maxDays: 366 },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "recurrence-error", code: "recurrence-limit", message: "recurrence exceeds maxOccurrences" },
    });
  });

  test("returns recurrence-limit when the configured day horizon is exceeded", () => {
    const e = event(timed("2026-01-01T14:00:00.000Z", "UTC"), "FREQ=DAILY;COUNT=10");
    const result = expandRecurrence(
      e,
      timed("2026-01-01T00:00:00.000Z", "UTC"),
      timed("2026-01-31T23:59:59.000Z", "UTC"),
      { maxOccurrences: 100, maxDays: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("recurrence-limit");
  });

  test("keeps a timed event at its local hour across DST", () => {
    const e = event(timed("2026-03-02T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    const result = expandRecurrence(e, timed("2026-03-01T00:00:00.000Z", "America/Toronto"), timed("2026-03-31T23:59:59.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((x) => x.start.kind === "timed" && x.start.instant)).toEqual([
      "2026-03-02T14:00:00.000Z" as UtcInstant, "2026-03-09T13:00:00.000Z" as UtcInstant, "2026-03-16T13:00:00.000Z" as UtcInstant,
    ]);
  });

  test("projects rich overrides without changing the original identity", () => {
    const original = timed("2026-01-06T14:00:00.000Z", "UTC");
    const e = event(timed("2026-01-05T14:00:00.000Z", "UTC"), "FREQ=DAILY;COUNT=2");
    e.description = "base";
    e.end = timed("2026-01-05T15:00:00.000Z");
    e.group = "old";
    e.tags = new Set(["old"]);
    e.exceptions = [{ occurrence: original, title: "changed", description: "details", start: timed("2026-01-09T16:00:00.000Z"), visibility: "adults", importance: "pinned", group: "new", tags: new Set(["new"]) }];
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z"), timed("2026-01-31T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const moved = result.value[1]!;
      expect(moved.eventId).toBe(e.id);
      expect(moved.originalStart).toEqual(original);
      expect(moved.occurrenceStart).toEqual(original);
      expect(moved.start).toEqual(timed("2026-01-09T16:00:00.000Z"));
      expect(moved.end).toEqual(timed("2026-01-09T17:00:00.000Z"));
      expect(moved.visibility).toBe("adults");
      expect(moved.tags).toEqual(new Set(["new"]));
    }
  });

  test("cancellation suppresses only its original slot and validates override kinds", () => {
    const cancelled = timed("2026-01-06T14:00:00.000Z", "UTC");
    const e = event(timed("2026-01-05T14:00:00.000Z", "UTC"), "FREQ=DAILY;COUNT=3");
    e.exceptions = [{ occurrence: cancelled, cancelled: true }];
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z"), timed("2026-01-31T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((x) => x.originalStart?.kind === "timed" && x.originalStart.instant)).toEqual(["2026-01-05T14:00:00.000Z" as UtcInstant, "2026-01-07T14:00:00.000Z" as UtcInstant]);
  });
});
