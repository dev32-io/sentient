import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Capability } from "../access/capability.js";
import { openCalendarStore } from "./calendar-store.js";
import { CALENDAR_SCHEMA_VERSION } from "./schema.js";
import type { CalendarConfig, CalendarEvent, CalendarEventId, EventTimeZoneId, UtcInstant } from "./types.js";

const cfg = {} as CalendarConfig;
const roots: string[] = [];
function cap(rootPath: string, resource: Capability["resource"] = "calendar-private"): Capability {
  return { ownerUserId: "u1" as Capability["ownerUserId"], resource, rootPath, role: "adult" };
}
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "calendar-store-test-"));
  roots.push(value);
  return value;
}
function event(id: string, start: CalendarEvent["start"], extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: id as CalendarEventId, title: id, start, visibility: "everyone", importance: "normal", tags: new Set(),
    createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant, updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant, ...extra,
  };
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("CalendarStore factory", () => {
  it("gates resource class before touching the path", () => {
    const missing = join(root(), "does-not-exist");
    expect(() => openCalendarStore(cap(missing, "session-store"), cfg)).toThrow(/wrong resource class/);
    expect(existsSync(missing)).toBe(false);
  });

  it("creates the private database, migrates v0, and enables WAL", () => {
    const base = root();
    const store = openCalendarStore(cap(base), cfg);
    const db = new Database(join(base, "calendar", "calendar.db"));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(CALENDAR_SCHEMA_VERSION);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeTruthy();
    expect(db.query<{ name: string }, []>("PRAGMA table_info(events)").all().some((column) => column.name === "group")).toBe(true);
    store.close();
    store.close();
    expect(store.list({ from: { kind: "all-day", date: "2026-01-01" }, to: { kind: "all-day", date: "2026-01-02" } })).toEqual({ ok: false, error: "closed" });
    db.close();
  });

  it("reads and expands recurring events with filters and exceptions", () => {
    const store = openCalendarStore(cap(root()), cfg);
    const recurring = event("recurring", { kind: "timed", instant: "2026-01-05T14:00:00.000Z" as UtcInstant, timeZoneId: "America/Toronto" as EventTimeZoneId }, {
      recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10", rule: { freq: "WEEKLY", byDay: ["MO", "FR"], count: 10 } },
      group: "school", importance: "important", tags: new Set(["home", "school"]),
      exdates: [{ kind: "timed", instant: "2026-01-09T14:00:00.000Z" as UtcInstant, timeZoneId: "America/Toronto" as EventTimeZoneId }],
      exceptions: [{ occurrence: { kind: "timed", instant: "2026-01-12T14:00:00.000Z" as UtcInstant, timeZoneId: "America/Toronto" as EventTimeZoneId }, title: "moved" }],
    });
    expect(store.create(recurring).ok).toBe(true);
    const result = store.list({ from: { kind: "timed", instant: "2026-01-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId }, to: { kind: "timed", instant: "2026-03-31T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId }, group: "school", tags: ["home"], importance: "important" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(9);
      expect(result.value.find((x) => x.occurrenceStart.kind === "timed" && x.occurrenceStart.instant === "2026-01-12T14:00:00.000Z")?.title).toBe("moved");
      expect(result.value[0]?.start.kind).toBe("timed");
      if (result.value[0]?.start.kind === "timed") expect(result.value[0].start.timeZoneId).toBe("America/Toronto" as EventTimeZoneId);
    }
  });

  it("hides adult events from child and guest reads", () => {
    const base = root();
    const adultStore = openCalendarStore(cap(base, "calendar-private"), cfg);
    const adultEvent = event("adult-only", { kind: "all-day", date: "2026-01-10" }, { visibility: "adults" });
    expect(adultStore.create(adultEvent).ok).toBe(true);
    expect(adultStore.get(adultEvent.id).ok).toBe(true);
    adultStore.close();
    const child = openCalendarStore({ ...cap(base), role: "child" }, cfg);
    expect(child.get(adultEvent.id)).toEqual({ ok: false, error: "not-found" });
    expect(child.list({ from: { kind: "all-day", date: "2026-01-01" }, to: { kind: "all-day", date: "2026-01-31" } })).toEqual({ ok: true, value: [] });
    child.close();
  });

  it("leaves an ahead-of-binary database untouched", () => {
    const base = root();
    const dbPath = join(base, "calendar", "calendar.db");
    mkdirSync(join(base, "calendar"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${CALENDAR_SCHEMA_VERSION + 10}`);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    db.close();
    const store = openCalendarStore(cap(base), cfg);
    const check = new Database(dbPath);
    expect(check.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(CALENDAR_SCHEMA_VERSION + 10);
    store.close();
    check.close();
  });
});
