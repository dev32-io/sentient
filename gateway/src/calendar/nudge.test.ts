import { describe, expect, it } from "vitest";
import type { CalendarStore, Occurrence } from "./types.js";
import { composeCalendarNudge } from "./nudge.js";

const occurrence = (title: string, instant: string, visibility: "everyone" | "adults" = "everyone", importance: "normal" | "important" | "pinned" = "normal"): Occurrence => ({
  id: `${title}-id` as never,
  baseEventId: `${title}-id` as never,
  occurrenceId: `${title}-occurrence`,
  occurrenceStart: { kind: "timed", instant: instant as never, timeZoneId: "UTC" as never },
  title,
  start: { kind: "timed", instant: instant as never, timeZoneId: "UTC" as never },
  visibility,
  importance,
  tags: new Set(),
  createdAt: instant as never,
  updatedAt: instant as never,
});

function store(events: Occurrence[]): CalendarStore {
  return { list: () => ({ ok: true, value: events }), get: () => ({ ok: false, error: "not-found" }), create: () => ({ ok: false, error: "not-implemented" }), update: () => ({ ok: false, error: "not-implemented" }), delete: () => ({ ok: false, error: "not-implemented" }), close: () => {} } as CalendarStore;
}

describe("composeCalendarNudge", () => {
  it("omits an empty calendar and caps with an overflow line", () => {
    expect(composeCalendarNudge(store([]), "adult", "UTC", Date.parse("2026-08-05T12:00:00Z"))).toBeNull();
    const events = ["A", "B", "C"].map((title) => occurrence(title, "2026-08-05T13:00:00.000Z"));
    const result = composeCalendarNudge(store(events), "adult", "UTC", Date.parse("2026-08-05T12:00:00Z"), { maxChars: 80, maxLines: 4 });
    expect(result).toContain("...and");
    expect(result!.length).toBeLessThanOrEqual(80);
  });

  it("drops normal weekly overflow while preserving today and important items within the line cap", () => {
    const events = [
      occurrence("Today", "2026-08-05T12:00:00.000Z"),
      occurrence("Important", "2026-08-06T12:00:00.000Z", "everyone", "important"),
      occurrence("Normal", "2026-08-07T12:00:00.000Z"),
    ];
    const result = composeCalendarNudge(store(events), "adult", "UTC", Date.parse("2026-08-05T12:00:00Z"), { maxChars: 4000, maxLines: 6 });
    expect(result).toContain("Today");
    expect(result).toContain("Important");
    expect(result).not.toContain("Normal");
    expect(result!.split("\n")).toHaveLength(6);
  });

  it("uses household-local today and hides adults events for a child", () => {
    const events = [occurrence("Visible", "2026-08-06T00:30:00.000Z"), occurrence("Adults", "2026-08-05T12:00:00.000Z", "adults")];
    const result = composeCalendarNudge(store(events), "child", "America/Toronto", Date.parse("2026-08-06T00:00:00Z"));
    expect(result).toContain("today 2026-08-05");
    expect(result).toContain("Visible");
    expect(result).not.toContain("Adults");
    expect(result).toMatch(/[+-]\d{2}:\d{2}/);
  });
});
