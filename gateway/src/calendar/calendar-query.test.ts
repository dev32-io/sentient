import { describe, expect, it } from "vitest";
import { CalendarQueryService } from "./calendar-query.js";
import type { CalendarPersistence } from "./calendar-store.js";
import type { CalendarPersistenceEvent } from "./types.js";
import type {
  CalendarConfig,
  CalendarEventId,
  CalendarRevision,
  EventTimeZoneId,
  StoredCalendarEvent,
  UtcInstant,
} from "./types.js";

const config: CalendarConfig = {
  query: { maxDays: 31, maxOccurrences: 10, pageSize: 2 },
  input: {
    maxTitleChars: 80,
    maxDescriptionChars: 200,
    maxQueryChars: 40,
    maxGroupChars: 20,
    maxTagChars: 20,
    maxTags: 5,
  },
  output: { maxResultChars: 4000 },
  recurrence: { maxOccurrences: 100, maxDays: 366 },
  nudge: { maxPerDay: 10 },
  defaultEventTimeZoneId: "UTC",
};
const timed = (instant: string) => ({
  kind: "timed" as const,
  instant: instant as UtcInstant,
  timeZoneId: "UTC" as EventTimeZoneId,
});
const day = (date: string) => ({ kind: "all-day" as const, date: date as never });
function event(
  id: string,
  start: ReturnType<typeof timed> | ReturnType<typeof day>,
  extra: Partial<StoredCalendarEvent> = {},
): CalendarPersistenceEvent {
  const value: StoredCalendarEvent = {
    id: id as CalendarEventId,
    title: id,
    start,
    visibility: "everyone",
    importance: "normal",
    tags: new Set(),
    createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
    updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
    ...extra,
  };
  return {
    ...value,
    revision: 1 as CalendarRevision,
    exceptions: value.exceptions ?? [],
    exclusions: value.exdates ?? [],
    tags: [...value.tags],
  };
}
function persistence(events: CalendarPersistenceEvent[], fail = false): CalendarPersistence {
  const map = new Map(events.map((value) => [value.id, value]));
  return {
    readBaseCandidates: (limit) =>
      fail
        ? { ok: false, error: "io-error" }
        : { ok: true, value: { ids: [...map.keys()].slice(0, limit), overflow: map.size > limit } },
    readRaw: (id) => (map.has(id) ? { ok: true, value: map.get(id)! } : { ok: false, error: "not-found" }),
    read: (id) => (map.has(id) ? { ok: true, value: map.get(id)! } : { ok: false, error: "not-found" }),
    get: (id) => (map.has(id) ? { ok: true, value: map.get(id)! } : { ok: false, error: "not-found" }),
    transaction: () => ({ ok: false, error: "not-implemented" }),
    withTransaction: () => ({ ok: false, error: "not-implemented" }),
    close: () => {},
  } as CalendarPersistence;
}
function service(
  privateEvents: CalendarPersistenceEvent[],
  householdEvents: CalendarPersistenceEvent[] = [],
  role: "child" | "adult" = "adult",
  output = config.output.maxResultChars,
) {
  return new CalendarQueryService({
    private: persistence(privateEvents),
    household: persistence(householdEvents),
    role,
    config: { ...config, output: { maxResultChars: output } },
  });
}
const range = { from: "2026-08-01", to: "2026-08-10" };

describe("CalendarQueryService", () => {
  it("queries timed and all-day candidates together and projects effective overrides before filters", () => {
    const moved = event("base", timed("2026-08-02T12:00:00.000Z"), {
      title: "stale",
      exceptions: [{ occurrence: timed("2026-08-02T12:00:00.000Z"), title: "Dinner", group: "food", tags: ["family"] }],
    });
    const result = service([moved, event("day", day("2026-08-03"))]).search({
      ...range,
      query: "dinner",
      group: "food",
      tags: ["family"],
    });
    const listWithQuery = service([moved, event("day", day("2026-08-03"))]).list({ ...range, query: "dinner" });
    expect(listWithQuery.ok && listWithQuery.value.events.map((row) => row.eventId)).toEqual(["base"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events.map((row) => row.eventId)).toEqual(["base"]);
    const all = service([moved, event("day", day("2026-08-03"))]).listComplete(range);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.map((row) => row.eventId)).toEqual(["base", "day"]);
  });

  it("finds a moved exception by its effective start while retaining original identity", () => {
    const original = timed("2026-08-02T12:00:00.000Z");
    const moved = event("moved", original, {
      exceptions: [{ occurrence: original, start: timed("2026-08-09T12:00:00.000Z"), title: "Moved" }],
    });
    const result = service([moved]).search({ from: "2026-08-08", to: "2026-08-10", query: "moved" });
    expect(result.ok && result.value.events[0]?.originalStart).toBe("2026-08-02T12:00:00.000Z");
  });

  it("defaults to private and applies explicit all-scope visibility after overrides", () => {
    const privateEvent = event("private", day("2026-08-02"));
    const householdAdult = event("adult", day("2026-08-03"), { visibility: "adults" });
    const childOverride = event("override", day("2026-08-04"), {
      visibility: "adults",
      exceptions: [{ occurrence: day("2026-08-04"), visibility: "everyone" }],
    });
    const query = service([privateEvent], [householdAdult, childOverride], "child");
    const defaultScope = query.listComplete(range);
    expect(defaultScope.ok && defaultScope.value.map((row) => row.eventId)).toEqual(["private"]);
    const all = query.listComplete({ ...range, scope: "all" });
    expect(all.ok && all.value.map((row) => row.eventId)).toEqual(["private", "override"]);
  });

  it("sorts the complete candidate set instead of trusting source order", () => {
    const query = service([
      event("late", day("2026-08-03")),
      event("early", day("2026-08-01")),
      event("middle", day("2026-08-02")),
    ]);
    const result = query.list({ ...range, limit: 3 });
    expect(result.ok && result.value.events.map((row) => row.eventId)).toEqual(["early", "middle"]);
    expect(result.ok && result.value.nextCursor).toBeDefined();
    if (result.ok && result.value.nextCursor) {
      const second = query.list({ ...range, limit: 3, cursor: result.value.nextCursor });
      expect(second.ok && second.value.events.map((row) => row.eventId)).toEqual(["late"]);
    }
  });

  it("pages REST results despite the tool result budget, while tools reject the complete overflow", () => {
    const events = [
      event("a", day("2026-08-01"), { title: "a".repeat(100) }),
      event("b", day("2026-08-02"), { title: "b".repeat(100) }),
      event("c", day("2026-08-03"), { title: "c".repeat(100) }),
    ];
    const rest = service(events, [], "adult", 1);
    const first = rest.list(range);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.nextCursor) throw new Error("expected REST continuation");
    expect(first.value.events.map((row) => row.eventId)).toEqual(["a", "b"]);
    const second = rest.list({ ...range, cursor: first.value.nextCursor });
    expect(second.ok && second.value.events.map((row) => row.eventId)).toEqual(["c"]);
    expect(second.ok && second.value.nextCursor).toBeUndefined();

    // Keep the tool query on one REST page so this assertion proves the
    // proactive serialized-size check, rather than only continuation rejection.
    const tool = new CalendarQueryService({
      private: persistence(events.slice(0, 2)),
      role: "adult",
      config: { ...config, query: { ...config.query, pageSize: 10 }, output: { maxResultChars: 1 } },
    });
    expect(tool.listComplete(range)).toMatchObject({ ok: false, error: { code: "result_too_large" } });
  });

  it("rejects a tool result that needs a REST page even below maxOccurrences", () => {
    const query = service([
      event("a", day("2026-08-01")),
      event("b", day("2026-08-02")),
      event("c", day("2026-08-03")),
    ]);
    expect(query.listComplete(range)).toMatchObject({ ok: false, error: { code: "result_too_large" } });
  });

  it("rejects candidate overflow before reading or expanding a base event", () => {
    const events = Array.from({ length: config.query.maxOccurrences + 1 }, (_, index) =>
      event(`event-${index}`, day("2026-08-01")),
    );
    expect(service(events).list(range)).toMatchObject({ ok: false, error: { code: "result_too_large" } });
  });

  it("uses deterministic cursors and refuses a cursor for a changed filter shape", () => {
    const query = service([
      event("a", day("2026-08-01")),
      event("b", day("2026-08-02")),
      event("c", day("2026-08-03")),
    ]);
    const first = query.list(range);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.nextCursor) throw new Error("expected cursor");
    const second = query.list({ ...range, cursor: first.value.nextCursor });
    expect(second.ok && second.value.events.map((row) => row.eventId)).toEqual(["c"]);
    const mismatched = query.list({ ...range, group: "changed", cursor: first.value.nextCursor });
    expect(mismatched).toMatchObject({ ok: false, error: { code: "invalid_range" } });
  });

  it("fails all-scope reads without returning a partial aggregate", () => {
    const query = new CalendarQueryService({
      private: persistence([event("private", day("2026-08-01"))]),
      household: persistence([], true),
      role: "adult",
      config,
    });
    expect(query.list({ ...range, scope: "all" })).toMatchObject({ ok: false, error: { code: "io_error" } });
  });

  it("returns result_too_large for complete aggregate and serialized overflow without partial JSON", () => {
    const events = [event("a", day("2026-08-01")), event("b", day("2026-08-02")), event("c", day("2026-08-03"))];
    const bounded = new CalendarQueryService({
      private: persistence(events),
      role: "adult",
      config: { ...config, query: { ...config.query, maxOccurrences: 2 } },
    });
    expect(bounded.listComplete(range)).toMatchObject({ ok: false, error: { code: "result_too_large" } });
    const serialized = service([event("very-long", day("2026-08-01"), { title: "x".repeat(20) })], [], "adult", 10);
    expect(serialized.listComplete(range)).toMatchObject({ ok: false, error: { code: "result_too_large" } });
    expect(JSON.stringify(serialized.listComplete(range))).not.toContain("very-long");
  });
});
