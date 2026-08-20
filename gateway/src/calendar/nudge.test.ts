import { describe, expect, it } from "vitest";
import type { CalendarPersistence } from "./calendar-store.js";
import { CalendarQueryService } from "./calendar-query.js";
import type { CalendarPersistenceEvent, CalendarStore, CalendarTime, Occurrence, UtcInstant } from "./types.js";
import { capCalendarNudge, composeCalendarNudge } from "./nudge.js";

const occurrence = (title: string, instant: string, visibility: "everyone" | "adults" = "everyone", importance: "normal" | "important" | "pinned" = "normal"): Occurrence => ({
  id: `${title}-id` as never,
  eventId: `${title}-id` as never,
  baseEventId: `${title}-id` as never,
  occurrenceId: `${title}-occurrence`,
  occurrenceStart: { kind: "timed", instant: instant as never, timeZoneId: "UTC" as never },
  originalStart: { kind: "timed", instant: instant as never, timeZoneId: "UTC" as never },
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

function persistence(events: CalendarPersistenceEvent[]): CalendarPersistence {
  const values = new Map(events.map((event) => [event.id, event]));
  return {
    readBaseCandidates: () => ({ ok: true, value: { ids: [...values.keys()], overflow: false } }),
    readRaw: (id) => values.has(id) ? { ok: true, value: values.get(id)! } : { ok: false, error: "not-found" },
    read: (id) => values.has(id) ? { ok: true, value: values.get(id)! } : { ok: false, error: "not-found" },
    get: (id) => values.has(id) ? { ok: true, value: values.get(id)! } : { ok: false, error: "not-found" },
    transaction: () => ({ ok: false, error: "not-implemented" }),
    withTransaction: () => ({ ok: false, error: "not-implemented" }),
    close: () => {},
  } as CalendarPersistence;
}

function persistedEvent(
  id: string,
  start: CalendarTime,
  importance: "normal" | "important" = "normal",
  extra: Partial<CalendarPersistenceEvent> = {},
): CalendarPersistenceEvent {
  return {
    id: id as never,
    title: id,
    start,
    visibility: "everyone",
    importance,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
    updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
    revision: 1 as never,
    exceptions: [],
    exclusions: [],
    ...extra,
  };
}

function nudgeQuery(events: CalendarPersistenceEvent[], zone: string): CalendarQueryService {
  return new CalendarQueryService({
    private: persistence(events),
    role: "adult",
    householdTimeZone: zone,
    config: {
      query: { maxDays: 1, maxOccurrences: 20, pageSize: 20 },
      input: { maxTitleChars: 80, maxDescriptionChars: 200, maxQueryChars: 40, maxGroupChars: 20, maxTagChars: 20, maxTags: 5 },
      output: { maxResultChars: 4000 },
      recurrence: { maxOccurrences: 100, maxDays: 366 },
      nudge: { maxPerDay: 10 },
      defaultEventTimeZoneId: zone,
    },
  });
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
      occurrence("Pinned", "2026-08-07T12:00:00.000Z", "everyone", "pinned"),
      occurrence("Normal", "2026-08-08T12:00:00.000Z"),
    ];
    const result = composeCalendarNudge(store(events), "adult", "UTC", Date.parse("2026-08-05T12:00:00Z"), { maxChars: 4000, maxLines: 7 });
    expect(result).toContain("Today");
    expect(result).toContain("Important");
    expect(result).toContain("Pinned");
    expect(result).not.toContain("Normal");
    expect(result!.split("\n")).toHaveLength(7);
  });

  it("applies one aggregate cap after combining scope blocks", () => {
    const privateBlock = composeCalendarNudge(
      store([occurrence("Private", "2026-08-05T12:00:00.000Z")]),
      "adult",
      "UTC",
      Date.parse("2026-08-05T12:00:00Z"),
      { maxChars: 4000, maxLines: 6 },
    );
    const householdBlock = composeCalendarNudge(
      store([occurrence("Household", "2026-08-05T13:00:00.000Z")]),
      "adult",
      "UTC",
      Date.parse("2026-08-05T12:00:00Z"),
      { maxChars: 4000, maxLines: 6 },
    );
    const combined = capCalendarNudge(`${privateBlock}\n${householdBlock}`, { maxChars: 4000, maxLines: 6 });
    expect(combined!.split("\n")).toHaveLength(6);
  });

  it("uses household-local today and hides adults events for a child", () => {
    const events = [occurrence("Visible", "2026-08-06T00:30:00.000Z"), occurrence("Adults", "2026-08-05T12:00:00.000Z", "adults")];
    const result = composeCalendarNudge(store(events), "child", "America/Toronto", Date.parse("2026-08-06T00:00:00Z"));
    expect(result).toContain("today 2026-08-05");
    expect(result).toContain("Visible");
    expect(result).not.toContain("Adults");
    expect(result).toMatch(/[+-]\d{2}:\d{2}/);
  });

  it("queries one household-local date with maxDays=1 at a UTC date boundary", () => {
    const zone = "America/Toronto";
    const result = composeCalendarNudge(
      nudgeQuery([
        persistedEvent("Timed today", { kind: "timed", instant: "2026-08-06T00:30:00.000Z" as UtcInstant, timeZoneId: zone as never }),
        persistedEvent("All day today", { kind: "all-day", date: "2026-08-05" }),
        persistedEvent("Previous day", { kind: "timed", instant: "2026-08-04T12:00:00.000Z" as UtcInstant, timeZoneId: zone as never }, "important"),
        persistedEvent("Following day", { kind: "all-day", date: "2026-08-06" }, "important"),
      ], zone),
      "adult",
      zone,
      Date.parse("2026-08-06T00:00:00Z"),
    );
    expect(result).toContain("today 2026-08-05");
    expect(result).toContain("Timed today");
    expect(result).toContain("All day today");
    expect(result).not.toContain("Previous day");
    expect(result).not.toContain("Following day");
  });

  it("keeps timed and all-day events on the household date across DST with maxDays=1", () => {
    const zone = "America/Toronto";
    const result = composeCalendarNudge(
      nudgeQuery([
        // 03:30 household time after the spring-forward transition.
        persistedEvent("DST timed today", { kind: "timed", instant: "2026-03-08T07:30:00.000Z" as UtcInstant, timeZoneId: zone as never }),
        persistedEvent("DST all day today", { kind: "all-day", date: "2026-03-08" }),
        persistedEvent("DST recurring", { kind: "all-day", date: "2026-03-07" }, "normal", {
          recurrence: { rrule: "FREQ=DAILY;COUNT=3", rule: { freq: "DAILY", count: 3 } },
          exclusions: [{ kind: "all-day", date: "2026-03-07" }, { kind: "all-day", date: "2026-03-09" }],
        }),
        persistedEvent("DST previous day", { kind: "all-day", date: "2026-03-07" }, "important"),
        persistedEvent("DST following day", { kind: "timed", instant: "2026-03-09T12:00:00.000Z" as UtcInstant, timeZoneId: zone as never }, "important"),
      ], zone),
      "adult",
      zone,
      Date.parse("2026-03-08T05:30:00Z"),
    );
    expect(result).toContain("today 2026-03-08");
    expect(result).toContain("DST timed today");
    expect(result).toContain("DST all day today");
    expect(result).toContain("DST recurring");
    expect(result).not.toContain("DST previous day");
    expect(result).not.toContain("DST following day");
  });
});
