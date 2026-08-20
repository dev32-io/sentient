import { describe, expect, test } from "bun:test";
import { DEFAULT_RECURRENCE_LIMITS, enumerateGeneratedSlots, expandRecurrence } from "./expand-recurrence.js";
import { canonicalizeRecurrence, splitRecurrence, verifyGeneratedSlot } from "./recurrence-splitter.js";
import type { ExceptionOverride, StoredCalendarEvent, UtcInstant } from "./types.js";

const timed = (instant: string, timeZoneId = "UTC") => ({
  kind: "timed" as const,
  instant: instant as UtcInstant,
  timeZoneId: timeZoneId as never,
});
const recurring = (rrule: string, extra: Partial<StoredCalendarEvent> = {}): StoredCalendarEvent => ({
  id: "series" as StoredCalendarEvent["id"],
  title: "series",
  start: timed("2026-01-05T14:00:00.000Z"),
  recurrence: { rrule, rule: undefined as never },
  visibility: "everyone",
  importance: "normal",
  tags: new Set(),
  createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
  updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
  ...extra,
});

describe("canonicalizeRecurrence", () => {
  test("canonicalizes structured input and deterministically orders weekly weekdays", () => {
    const result = canonicalizeRecurrence({ frequency: "weekly", weekdays: ["friday", "monday"], count: 4 });
    expect(result).toEqual({
      ok: true,
      value: { rrule: "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4", rule: { freq: "WEEKLY", byDay: ["MO", "FR"], count: 4 } },
    });
  });
  test("normalizes date-period UNTIL at the configured event timezone", () => {
    const result = canonicalizeRecurrence(
      { frequency: "daily", until: "2026-08-31" as never },
      { timeZoneId: "America/Toronto" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rrule).toContain("UNTIL=20260901T035959Z");
    const month = canonicalizeRecurrence(
      { frequency: "daily", until: "2024-02" as never },
      { timeZoneId: "America/Toronto" },
    );
    expect(month.ok).toBe(true);
    if (month.ok) expect(month.value.rrule).toContain("UNTIL=20240301T045959Z");
  });

  test("requires a bound and rejects unsupported constructs", () => {
    expect(canonicalizeRecurrence({ frequency: "daily" } as never).ok).toBe(false);
    expect(canonicalizeRecurrence({ frequency: "daily", until: "2026-08-31" as never })).toMatchObject({
      ok: false,
      error: { code: "missing-timezone" },
    });
  });
});

describe("splitRecurrence", () => {
  test("counts excluded and cancelled slots in COUNT arithmetic", () => {
    const target = timed("2026-01-07T14:00:00.000Z");
    const cancelled: ExceptionOverride = { occurrence: timed("2026-01-06T14:00:00.000Z"), cancelled: true };
    const event = recurring("FREQ=DAILY;COUNT=5", {
      exdates: [timed("2026-01-08T14:00:00.000Z")],
      exceptions: [cancelled],
    });
    const result = splitRecurrence(event, target);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ordinal).toBe(3);
      expect(result.value.prefix?.recurrence.rule.count).toBe(2);
      expect(result.value.successor.recurrence.rule.count).toBe(3);
      expect(result.value.state.prefix.exceptions).toHaveLength(1);
      expect(result.value.state.successor.exdates).toHaveLength(1);
    }
  });

  test("uses originalStart when the selected occurrence was moved", () => {
    const original = timed("2026-01-06T14:00:00.000Z");
    const event = recurring("FREQ=DAILY;COUNT=3", {
      exceptions: [{ occurrence: original, start: timed("2026-01-10T16:00:00.000Z") }],
    });
    const result = splitRecurrence(event, original);
    expect(result.ok).toBe(true);
    expect(verifyGeneratedSlot(event, timed("2026-01-10T16:00:00.000Z")).ok).toBe(false);
  });

  test("does not create an empty prefix at the first slot", () => {
    const event = recurring("FREQ=DAILY;COUNT=3");
    const result = splitRecurrence(event, event.start);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.prefix).toBeUndefined();
  });

  test("retains UNTIL on successor and ends prefix at prior generated slot", () => {
    const event = recurring("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260330T130000Z", {
      start: timed("2026-03-02T14:00:00.000Z", "America/Toronto"),
    });
    const result = splitRecurrence(event, timed("2026-03-16T13:00:00.000Z", "America/Toronto"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prefix?.recurrence.rrule).toContain("UNTIL=20260309T130000Z");
      expect(result.value.successor.recurrence.rrule).toContain("UNTIL=20260330T130000Z");
    }
  });

  test("requires a resolved timezone for all-day structured UNTIL", () => {
    const event = recurring("FREQ=DAILY;UNTIL=20260105T235959Z", {
      start: { kind: "all-day", date: "2026-01-01" },
    });
    expect(splitRecurrence(event, { kind: "all-day", date: "2026-01-03" }, {
      frequency: "daily",
      until: "2026-01-05" as never,
    })).toMatchObject({ ok: false, error: { code: "missing-timezone" } });
  });

  test("uses the non-UTC household timezone for all-day UNTIL split and expansion", () => {
    const canonical = canonicalizeRecurrence(
      { frequency: "daily", until: "2026-01-03" as never },
      { timeZoneId: "America/Toronto" },
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const event = recurring(canonical.value.rrule, {
      start: { kind: "all-day", date: "2026-01-01" },
      recurrence: canonical.value,
    });
    const limits = { ...DEFAULT_RECURRENCE_LIMITS, timeZoneId: "America/Toronto" };
    const expanded = expandRecurrence(event, { kind: "all-day", date: "2026-01-01" }, { kind: "all-day", date: "2026-01-10" }, limits);
    expect(expanded.ok).toBe(true);
    if (expanded.ok) expect(expanded.value.map((item) => item.originalStart)).toEqual([
      { kind: "all-day", date: "2026-01-01" },
      { kind: "all-day", date: "2026-01-02" },
      { kind: "all-day", date: "2026-01-03" },
    ]);
    const split = splitRecurrence(event, { kind: "all-day", date: "2026-01-02" }, undefined, limits);
    expect(split.ok).toBe(true);
    if (split.ok) {
      expect(split.value.prefix?.recurrence.rrule).toContain("UNTIL=20260101T235959Z");
      expect(split.value.successor.recurrence.rrule).toContain("UNTIL=20260104T045959Z");
    }
  });

  test("rejects a changed successor rule that would orphan future child state", () => {
    const event = recurring("FREQ=DAILY;COUNT=5", { exdates: [timed("2026-01-08T14:00:00.000Z")] });
    const result = splitRecurrence(event, timed("2026-01-07T14:00:00.000Z"), {
      frequency: "weekly",
      weekdays: ["monday"],
      count: 2,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "recurrence-conflict",
        code: "recurrence_conflict",
        message: "successor recurrence does not generate the selected slot",
      },
    });
  });

  test("slot enumeration is independent of filtered occurrence output", () => {
    const event = recurring("FREQ=DAILY;COUNT=3", { exdates: [timed("2026-01-06T14:00:00.000Z")] });
    const slots = enumerateGeneratedSlots(event);
    const visible = expandRecurrence(event, timed("2026-01-01T00:00:00.000Z"), timed("2026-01-10T00:00:00.000Z"));
    expect(slots.ok && slots.value).toHaveLength(3);
    expect(visible.ok && visible.value).toHaveLength(2);
  });
});
