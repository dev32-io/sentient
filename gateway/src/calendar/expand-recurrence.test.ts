import { describe, expect, test } from "bun:test";
import { expandRecurrence, verifyGeneratedSlot } from "./expand-recurrence.js";
import type { StoredCalendarEvent, UtcInstant } from "./types.js";

const timed = (instant: string, timeZoneId = "UTC") => ({
  kind: "timed" as const,
  instant: instant as UtcInstant,
  timeZoneId: timeZoneId as never,
});
const event = (start: StoredCalendarEvent["start"], recurrence: string): StoredCalendarEvent => ({
  id: "family" as StoredCalendarEvent["id"],
  title: "event",
  start,
  recurrence: { rrule: recurrence, rule: undefined as never },
  visibility: "everyone",
  importance: "normal",
  tags: new Set(),
  createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
  updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
});

describe("expandRecurrence", () => {
  test("expands COUNT weekly BYDAY with inclusive bounds", () => {
    const e = event(timed("2026-01-05T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10");
    const result = expandRecurrence(
      e,
      timed("2026-01-01T00:00:00.000Z", "America/Toronto"),
      timed("2026-03-31T23:59:59.000Z", "America/Toronto"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(10);
  });

  test("matches skipped monthly, leap-year, and DST-gap COUNT slot ordinals", () => {
    const fixtures = [
      {
        value: event(timed("2028-01-31T14:00:00.000Z"), "FREQ=MONTHLY;COUNT=3"),
        end: "2028-06-01T00:00:00.000Z",
        expected: ["2028-01-31T14:00:00.000Z", "2028-03-31T14:00:00.000Z", "2028-05-31T14:00:00.000Z"],
        rejected: "2028-07-31T14:00:00.000Z",
        zone: "UTC",
      },
      {
        value: event(timed("2020-02-29T14:00:00.000Z"), "FREQ=YEARLY;COUNT=2"),
        end: "2028-03-01T00:00:00.000Z",
        expected: ["2020-02-29T14:00:00.000Z", "2024-02-29T14:00:00.000Z"],
        rejected: "2028-02-29T14:00:00.000Z",
        zone: "UTC",
      },
      {
        value: event(timed("2026-03-07T07:30:00.000Z", "America/New_York"), "FREQ=DAILY;COUNT=2"),
        end: "2026-03-10T00:00:00.000Z",
        expected: ["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"],
        rejected: "2026-03-10T06:30:00.000Z",
        zone: "America/New_York",
      },
    ] as const;
    for (const fixture of fixtures) {
      const limits = { maxOccurrences: 100, maxDays: 4_000, timeZoneId: fixture.zone };
      const expanded = expandRecurrence(fixture.value, fixture.value.start, timed(fixture.end, fixture.zone), limits);
      expect(expanded.ok).toBe(true);
      if (!expanded.ok) continue;
      expect(
        expanded.value.map((item) => item.originalStart.kind === "timed" && String(item.originalStart.instant)),
      ).toEqual([...fixture.expected]);
      for (const [index, instant] of fixture.expected.entries())
        expect(verifyGeneratedSlot(fixture.value, timed(instant, fixture.zone), limits)).toEqual({
          ok: true,
          ordinal: index + 1,
        });
      expect(verifyGeneratedSlot(fixture.value, timed(fixture.rejected, fixture.zone), limits).ok).toBe(false);
    }
    const monthly = fixtures[0];
    const excluded = { ...monthly.value, exdates: [timed(monthly.expected[0], monthly.zone)] };
    const limits = { maxOccurrences: 100, maxDays: 4_000, timeZoneId: monthly.zone };
    expect(verifyGeneratedSlot(excluded, timed(monthly.expected[2], monthly.zone), limits)).toEqual({
      ok: true,
      ordinal: 3,
    });
    expect(verifyGeneratedSlot(excluded, timed(monthly.rejected, monthly.zone), limits).ok).toBe(false);
  });

  test("resolves the household timezone sentinel during expansion", () => {
    const e = event(timed("2026-08-05T14:00:00.000Z", "household"), "FREQ=DAILY;COUNT=2");
    const result = expandRecurrence(
      e,
      timed("2026-08-01T00:00:00.000Z", "household"),
      timed("2026-08-20T23:59:59.000Z", "household"),
      { maxOccurrences: 1000, maxDays: 366, timeZoneId: "America/Toronto" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value.every((item) => item.start.kind === "timed" && item.start.timeZoneId === "household")).toBe(
        true,
      );
    }
  });

  test("orders weekly BYDAY slots relative to the DTSTART week anchor", () => {
    const e = event(timed("2026-01-04T14:00:00.125Z", "UTC"), "FREQ=WEEKLY;BYDAY=SU,MO;COUNT=4");
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z"), timed("2026-01-20T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((item) => item.originalStart.kind === "timed" && item.originalStart.instant)).toEqual([
        "2026-01-04T14:00:00.125Z" as UtcInstant,
        "2026-01-05T14:00:00.125Z" as UtcInstant,
        "2026-01-11T14:00:00.125Z" as UtcInstant,
        "2026-01-12T14:00:00.125Z" as UtcInstant,
      ]);
    }
  });

  test("keeps INTERVAL=2 weekly BYDAY periods on the Monday anchor", () => {
    const e = event(timed("2026-01-07T14:00:00.000Z", "UTC"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=6");
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z"), timed("2026-03-01T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.map((item) => item.originalStart.kind === "timed" && item.originalStart.instant)).toEqual([
        "2026-01-07T14:00:00.000Z" as UtcInstant,
        "2026-01-09T14:00:00.000Z" as UtcInstant,
        "2026-01-19T14:00:00.000Z" as UtcInstant,
        "2026-01-21T14:00:00.000Z" as UtcInstant,
        "2026-01-23T14:00:00.000Z" as UtcInstant,
        "2026-02-02T14:00:00.000Z" as UtcInstant,
      ]);
  });

  test("does not count pre-DTSTART BYDAY candidates", () => {
    const e = event(timed("2026-08-05T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10");
    const result = expandRecurrence(
      e,
      timed("2026-08-01T00:00:00.000Z", "America/Toronto"),
      timed("2026-10-31T23:59:59.000Z", "America/Toronto"),
    );
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

  test("seeks an old UNTIL series without resetting its DTSTART phase", () => {
    const e = event(timed("2020-01-01T15:00:00.000Z", "America/Toronto"), "FREQ=MONTHLY;UNTIL=20290101T235959Z");
    const result = expandRecurrence(
      e,
      timed("2028-02-01T00:00:00.000Z", "America/Toronto"),
      timed("2028-05-31T23:59:59.000Z", "America/Toronto"),
      { maxOccurrences: 20, maxDays: 366 },
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.map((item) => item.originalStart.kind === "timed" && item.originalStart.instant)).toEqual([
        "2028-02-01T15:00:00.000Z" as UtcInstant,
        "2028-03-01T15:00:00.000Z" as UtcInstant,
        "2028-04-01T14:00:00.000Z" as UtcInstant,
        "2028-05-01T14:00:00.000Z" as UtcInstant,
      ]);
  });

  test("does not reset finite COUNT when querying long after termination", () => {
    const e = event(timed("2020-01-01T15:00:00.000Z", "UTC"), "FREQ=MONTHLY;COUNT=3");
    const result = expandRecurrence(
      e,
      timed("2028-01-01T00:00:00.000Z", "UTC"),
      timed("2028-12-31T23:59:59.000Z", "UTC"),
      { maxOccurrences: 3, maxDays: 366 },
    );
    expect(result).toEqual({ ok: true, value: [] });
  });

  test("preserves fractional seconds in every generated originalStart", () => {
    const e = event(timed("2026-01-01T14:00:00.125Z", "UTC"), "FREQ=DAILY;COUNT=3");
    const result = expandRecurrence(e, timed("2026-01-01T00:00:00.000Z"), timed("2026-01-10T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.map((item) => item.originalStart.kind === "timed" && item.originalStart.instant)).toEqual([
        "2026-01-01T14:00:00.125Z" as UtcInstant,
        "2026-01-02T14:00:00.125Z" as UtcInstant,
        "2026-01-03T14:00:00.125Z" as UtcInstant,
      ]);
  });

  test("keeps a timed event at its local hour across DST", () => {
    const e = event(timed("2026-03-02T14:00:00.000Z", "America/Toronto"), "FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    const result = expandRecurrence(
      e,
      timed("2026-03-01T00:00:00.000Z", "America/Toronto"),
      timed("2026-03-31T23:59:59.000Z", "America/Toronto"),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.map((x) => x.start.kind === "timed" && x.start.instant)).toEqual([
        "2026-03-02T14:00:00.000Z" as UtcInstant,
        "2026-03-09T13:00:00.000Z" as UtcInstant,
        "2026-03-16T13:00:00.000Z" as UtcInstant,
      ]);
  });

  test("projects rich overrides without changing the original identity", () => {
    const original = timed("2026-01-06T14:00:00.000Z", "UTC");
    const e = event(timed("2026-01-05T14:00:00.000Z", "UTC"), "FREQ=DAILY;COUNT=2");
    e.description = "base";
    e.end = timed("2026-01-05T15:00:00.000Z");
    e.group = "old";
    e.tags = new Set(["old"]);
    e.exceptions = [
      {
        occurrence: original,
        title: "changed",
        description: "details",
        start: timed("2026-01-09T16:00:00.000Z"),
        visibility: "adults",
        importance: "pinned",
        group: "new",
        tags: new Set(["new"]),
      },
    ];
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
    if (result.ok)
      expect(result.value.map((x) => x.originalStart?.kind === "timed" && x.originalStart.instant)).toEqual([
        "2026-01-05T14:00:00.000Z" as UtcInstant,
        "2026-01-07T14:00:00.000Z" as UtcInstant,
      ]);
  });
});
