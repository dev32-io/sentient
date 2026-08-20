import { describe, expect, test } from "bun:test";
import { enumerateGeneratedSlots, expandRecurrence } from "./expand-recurrence.js";
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
  test("requires a bound and rejects unsupported constructs", () => {
    expect(canonicalizeRecurrence({ frequency: "daily" } as never).ok).toBe(false);
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
