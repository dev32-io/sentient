import { describe, expect, test } from "bun:test";
import {
  type CalendarTemporalLimits,
  calendarTimeKey,
  normalizeCalendarEventTimes,
  normalizeCalendarQuery,
  normalizeCalendarTime,
  parseCalendarTemporal,
  validateCalendarInputLimits,
} from "./calendar-temporal.js";

const config: CalendarTemporalLimits = {
  householdTimeZone: "America/Toronto",
  query: { maxDays: 366 },
  input: {
    maxTitleChars: 5,
    maxDescriptionChars: 8,
    maxQueryChars: 6,
    maxGroupChars: 4,
    maxTagChars: 3,
    maxTags: 2,
  },
};

describe("calendar temporal boundary", () => {
  test("accepts each approved precision and rejects offset-free or trailing values", () => {
    for (const value of [
      "2026",
      "2026-08",
      "2026-08-05",
      "2026-08-05T09:00Z",
      "2026-08-05T09:00:01-04:00",
      "2026-08-05T09:00:01.125-04:00",
    ])
      expect(parseCalendarTemporal(value).ok).toBe(true);
    for (const value of [
      "2026-02-29",
      "2024-02-30",
      "2026-08-05T09:00",
      "2026-08-05T09:00:01.1234567890Z",
      "2026-08-05T09:00Zjunk",
      "2026-08-05T25:00Z",
    ])
      expect(parseCalendarTemporal(value).ok).toBe(false);
  });

  test("expands year, month, and day periods to all-day boundaries", () => {
    expect(normalizeCalendarQuery({ from: "2024", to: "2024-02" }, config)).toEqual({
      ok: true,
      value: {
        from: { kind: "all-day", date: "2024-01-01" },
        to: { kind: "all-day", date: "2024-02-29" },
      },
    });
    expect(normalizeCalendarTime("2026-08", config, { boundary: "end" })).toEqual({
      ok: true,
      value: { kind: "all-day", date: "2026-08-31" },
    });
  });

  test("preserves timed instants and uses the household zone for recurring anchors", () => {
    const oneOff = normalizeCalendarTime("2026-08-05T09:00-04:00", config);
    expect(oneOff).toMatchObject({
      ok: true,
      value: { kind: "timed", instant: "2026-08-05T13:00:00.000Z", timeZoneId: "America/Toronto" },
    });
    const recurring = normalizeCalendarTime("2026-08-05T09:00-04:00", config, { recurring: true });
    expect(recurring).toMatchObject({
      ok: true,
      value: { instant: "2026-08-05T13:00:00.000Z", timeZoneId: "America/Toronto" },
    });
    const mismatch = normalizeCalendarTime("2026-08-05T09:00-05:00", config, { recurring: true });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "invalid_time" } });
  });

  test("handles DST boundaries through the configured household timezone", () => {
    const spring = normalizeCalendarTime("2026-03-08T00:00-05:00", config, { recurring: true });
    const summer = normalizeCalendarTime("2026-07-01T09:00-04:00", config, { recurring: true });
    expect(spring.ok).toBe(true);
    expect(summer.ok).toBe(true);
    if (spring.ok && summer.ok) {
      expect(spring.value.kind).toBe("timed");
      expect(summer.value.kind).toBe("timed");
    }
  });

  test("rejects incompatible, inverted, and over-wide ranges before storage", () => {
    expect(normalizeCalendarQuery({ from: "2026-08-05", to: "2026-08-05T09:00Z" }, config)).toMatchObject({
      ok: false,
      error: { code: "invalid_range" },
    });
    expect(normalizeCalendarQuery({ from: "2026-08-06", to: "2026-08-05" }, config)).toMatchObject({
      ok: false,
      error: { code: "invalid_range" },
    });
    expect(normalizeCalendarQuery({ from: "2025", to: "2026" }, config)).toMatchObject({
      ok: false,
      error: { code: "range_too_wide", measured: 730 },
    });
    expect(normalizeCalendarQuery({ from: "2026-08-01" }, config)).toMatchObject({
      ok: false,
      error: { code: "invalid_range", field: "to" },
    });
    expect(normalizeCalendarQuery({ from: "2026-08-01", to: "2026-08-02", query: "too-long" }, config)).toMatchObject({
      ok: false,
      error: { code: "invalid_range", field: "query", limit: 6 },
    });
  });

  test("normalizes event start/end with leap dates and rejects inversion", () => {
    expect(normalizeCalendarEventTimes("2024-02", "2024-02-29", config)).toEqual({
      ok: true,
      value: { start: { kind: "all-day", date: "2024-02-01" }, end: { kind: "all-day", date: "2024-02-29" } },
    });
    expect(normalizeCalendarEventTimes("2026-08-06T09:00Z", "2026-08-05T09:00Z", config)).toMatchObject({
      ok: false,
      error: { code: "invalid_range" },
    });
  });

  test("enforces string and tag limits without echoing supplied content", () => {
    const secret = "do-not-echo";
    const result = validateCalendarInputLimits({ title: secret }, config);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_range", field: "title", limit: 5 } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(validateCalendarInputLimits({ tags: ["ok", "yes", "no"] }, config)).toMatchObject({
      ok: false,
      error: { field: "tags", limit: 2 },
    });
    expect(validateCalendarInputLimits({ tags: ["long"] }, config)).toMatchObject({
      ok: false,
      error: { field: "tags", limit: 3 },
    });
    expect(
      validateCalendarInputLimits(
        { title: "hello", description: "12345678", query: "search", group: "home", tags: ["one", "two"] },
        config,
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  test("provides stable original keys for normalized times", () => {
    const result = normalizeCalendarTime("2026-08-05T09:00:01.125-04:00", config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(calendarTimeKey(result.value)).toBe("2026-08-05T13:00:01.125Z");
  });
});
