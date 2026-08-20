import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Capability } from "../access/capability.js";
import { openCalendarPersistence, openCalendarStore } from "./calendar-store.js";
import { CALENDAR_SCHEMA_VERSION } from "./schema.js";
import type { CalendarConfig, CalendarPersistenceBaseEvent, StoredCalendarEvent, CalendarEventId, CalendarRevision, EventTimeZoneId, UtcInstant } from "./types.js";

const cfg = { defaultEventTimeZoneId: "America/Toronto" } as CalendarConfig;
const roots: string[] = [];
function cap(rootPath: string, resource: Capability["resource"] = "calendar-private"): Capability {
  return { ownerUserId: "u1" as Capability["ownerUserId"], resource, rootPath, role: "adult" };
}
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "calendar-store-test-"));
  roots.push(value);
  return value;
}
function event(id: string, start: StoredCalendarEvent["start"], extra: Partial<StoredCalendarEvent> = {}): StoredCalendarEvent {
  return {
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
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("CalendarStore factory", () => {
  it("gates resource class before touching the path", () => {
    const missing = join(root(), "does-not-exist");
    expect(() => openCalendarStore(cap(missing, "session-store"), cfg)).toThrow(/wrong resource class/);
    expect(existsSync(missing)).toBe(false);
  });

  it("creates the fresh V2 database and enables WAL", () => {
    const base = root();
    const store = openCalendarStore(cap(base), cfg);
    const db = new Database(join(base, "calendar-v2", "calendar.db"));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
      CALENDAR_SCHEMA_VERSION,
    );
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeTruthy();
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'exclusions'").get()).toBeTruthy();
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'exdates'").get()).toBeNull();
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .some((column) => column.name === "group"),
    ).toBe(true);
    store.close();
    store.close();
    expect(
      store.list({ from: { kind: "all-day", date: "2026-01-01" }, to: { kind: "all-day", date: "2026-01-02" } }),
    ).toEqual({ ok: false, error: "closed" });
    db.close();
  });

  it("reads and expands recurring events with filters and exceptions", () => {
    const store = openCalendarStore(cap(root()), cfg);
    const recurring = event(
      "recurring",
      {
        kind: "timed",
        instant: "2026-01-05T14:00:00.000Z" as UtcInstant,
        timeZoneId: "America/Toronto" as EventTimeZoneId,
      },
      {
        recurrence: {
          rrule: "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10",
          rule: { freq: "WEEKLY", byDay: ["MO", "FR"], count: 10 },
        },
        group: "school",
        importance: "important",
        tags: new Set(["home", "school"]),
        exdates: [
          {
            kind: "timed",
            instant: "2026-01-09T14:00:00.000Z" as UtcInstant,
            timeZoneId: "America/Toronto" as EventTimeZoneId,
          },
        ],
        exceptions: [
          {
            occurrence: {
              kind: "timed",
              instant: "2026-01-12T14:00:00.000Z" as UtcInstant,
              timeZoneId: "America/Toronto" as EventTimeZoneId,
            },
            title: "moved",
          },
        ],
      },
    );
    expect(store.create(recurring).ok).toBe(true);
    const result = store.list({
      from: { kind: "timed", instant: "2026-01-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
      to: { kind: "timed", instant: "2026-03-31T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
      group: "school",
      tags: ["home"],
      importance: "important",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(9);
      expect(
        result.value.find(
          (x) => x.occurrenceStart.kind === "timed" && x.occurrenceStart.instant === "2026-01-12T14:00:00.000Z",
        )?.title,
      ).toBe("moved");
      expect(result.value[0]?.start.kind).toBe("timed");
      if (result.value[0]?.start.kind === "timed")
        expect(result.value[0].start.timeZoneId).toBe("America/Toronto" as EventTimeZoneId);
    }
  });

  it("returns recurrence-limit instead of partial occurrences for an oversized bounded rule", () => {
    const store = openCalendarStore(cap(root()), Object.freeze({
      query: Object.freeze({ maxDays: 30, maxOccurrences: 3, pageSize: 10 }),
      input: Object.freeze({ maxTitleChars: 64, maxDescriptionChars: 256, maxQueryChars: 64, maxGroupChars: 32, maxTagChars: 16, maxTags: 4 }),
      output: Object.freeze({ maxResultChars: 4000 }),
      recurrence: Object.freeze({ maxOccurrences: 3, maxDays: 366 }),
      nudge: Object.freeze({ maxPerDay: 10 }),
      defaultEventTimeZoneId: "UTC",
    }));
    const recurring = event("oversized", {
      kind: "timed",
      instant: "2026-01-01T14:00:00.000Z" as UtcInstant,
      timeZoneId: "UTC" as EventTimeZoneId,
    }, {
      recurrence: { rrule: "FREQ=DAILY;COUNT=10", rule: { freq: "DAILY", count: 10 } },
    });
    expect(store.create(recurring).ok).toBe(true);
    const result = store.list({
      from: { kind: "timed", instant: "2026-01-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
      to: { kind: "timed", instant: "2026-01-31T23:59:59.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
    });
    expect(result).toEqual({ ok: false, error: "recurrence-limit" });
    store.close();
  });

  it("expands recurring events stored with the household timezone sentinel", () => {
    const store = openCalendarStore(cap(root()), cfg);
    const recurring = event("household-recurring", {
      kind: "timed",
      instant: "2026-08-05T14:00:00.000Z" as UtcInstant,
      timeZoneId: "household" as EventTimeZoneId,
    }, {
      recurrence: { rrule: "FREQ=DAILY;COUNT=2", rule: { freq: "DAILY", count: 2 } },
    });
    expect(store.create(recurring).ok).toBe(true);
    const result = store.list({
      from: { kind: "timed", instant: "2026-08-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
      to: { kind: "timed", instant: "2026-08-20T23:59:59.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value.every((item) => item.start.kind === "timed" && item.start.timeZoneId === "household")).toBe(true);
    }
    store.close();
  });

  it("hides adult events from child and guest reads while allowing adult and admin", () => {
    const base = root();
    const adultStore = openCalendarStore(cap(base, "calendar-private"), cfg);
    const adultEvent = event("adult-only", { kind: "all-day", date: "2026-01-10" }, { visibility: "adults" });
    expect(adultStore.create(adultEvent).ok).toBe(true);
    expect(adultStore.get(adultEvent.id).ok).toBe(true);
    const window = {
      from: { kind: "all-day" as const, date: "2026-01-01" as const },
      to: { kind: "all-day" as const, date: "2026-01-31" as const },
    };
    expect(adultStore.list(window).ok).toBe(true);
    adultStore.close();

    for (const role of ["child", "guest"] as const) {
      const hidden = openCalendarStore({ ...cap(base), role }, cfg);
      expect(hidden.get(adultEvent.id)).toEqual({ ok: false, error: "not-found" });
      expect(hidden.list(window)).toEqual({ ok: true, value: [] });
      hidden.close();
    }
    for (const role of ["adult", "admin"] as const) {
      const visible = openCalendarStore({ ...cap(base), role }, cfg);
      expect(visible.get(adultEvent.id)).toMatchObject({ ok: true, value: adultEvent });
      const listed = visible.list(window);
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.value.map((item) => item.baseEventId)).toContain(adultEvent.id);
      visible.close();
    }
  });

  it("atomically replaces mutable fields and cascades child rows on delete", () => {
    const base = root();
    const store = openCalendarStore(cap(base), cfg);
    const original = event(
      "replace-me",
      {
        kind: "timed",
        instant: "2026-01-05T14:00:00.000Z" as UtcInstant,
        timeZoneId: "America/Toronto" as EventTimeZoneId,
      },
      {
        description: "old",
        end: {
          kind: "timed",
          instant: "2026-01-05T15:00:00.000Z" as UtcInstant,
          timeZoneId: "America/Toronto" as EventTimeZoneId,
        },
        recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2", rule: { freq: "WEEKLY", byDay: ["MO"], count: 2 } },
        exdates: [
          {
            kind: "timed",
            instant: "2026-01-12T14:00:00.000Z" as UtcInstant,
            timeZoneId: "America/Toronto" as EventTimeZoneId,
          },
        ],
        exceptions: [
          {
            occurrence: {
              kind: "timed",
              instant: "2026-01-05T14:00:00.000Z" as UtcInstant,
              timeZoneId: "America/Toronto" as EventTimeZoneId,
            },
            title: "old override",
          },
        ],
        visibility: "adults",
        importance: "important",
        group: "old",
        tags: new Set(["old", "shared"]),
        notification: { kind: "email" },
      },
    );
    expect(store.create(original)).toEqual({ ok: true, value: original });
    const { recurrence: _oldRecurrence, ...withoutRecurrence } = original;
    const replacement = {
      ...withoutRecurrence,
      title: "new",
      description: "new description",
      visibility: "everyone" as const,
      importance: "pinned" as const,
      group: "new",
      tags: new Set(["new"]),
      recurrence: { rrule: "FREQ=DAILY;COUNT=3", rule: { freq: "DAILY" as const, count: 3 } },
      exdates: [],
      exceptions: [],
      notification: { kind: "push" },
      updatedAt: "2026-01-02T00:00:00.000Z" as UtcInstant,
    };
    expect(store.update(original.id, replacement)).toEqual({ ok: true, value: replacement });
    const updated = store.get(original.id);
    expect(updated).toEqual({ ok: true, value: replacement });
    if (updated.ok) {
      expect(updated.value.id).toBe(original.id);
      expect(updated.value.createdAt).toBe(original.createdAt);
      expect(updated.value.tags).toEqual(new Set(["new"]));
      expect(updated.value.recurrence).toEqual(replacement.recurrence);
    }
    expect(store.delete(original.id)).toEqual({ ok: true, value: undefined });
    expect(store.get(original.id)).toEqual({ ok: false, error: "not-found" });
    store.close();
    const db = new Database(join(base, "calendar-v2", "calendar.db"));
    for (const table of ["exceptions", "exclusions", "tags"]) {
      expect(
        db
          .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE event_id = ?`)
          .get(original.id)?.count,
      ).toBe(0);
    }
    db.close();
  });

  it("round-trips all-day and timed starts through get and list", () => {
    const store = openCalendarStore(cap(root()), cfg);
    const allDay = event("all-day", { kind: "all-day", date: "2026-02-01" });
    const timed = event("timed", {
      kind: "timed",
      instant: "2026-02-01T14:00:00.000Z" as UtcInstant,
      timeZoneId: "America/Toronto" as EventTimeZoneId,
    });
    expect(store.create(allDay).ok).toBe(true);
    expect(store.get(allDay.id)).toMatchObject({ ok: true, value: { start: allDay.start } });
    const allDayList = store.list({
      from: { kind: "all-day", date: "2026-01-01" },
      to: { kind: "all-day", date: "2026-03-01" },
    });
    expect(allDayList.ok).toBe(true);
    if (allDayList.ok)
      expect(allDayList.value.find((item) => item.baseEventId === allDay.id)?.start).toEqual(allDay.start);
    expect(store.create(timed).ok).toBe(true);
    expect(store.get(timed.id)).toMatchObject({ ok: true, value: { start: timed.start } });
    const mixedAllDayList = store.list({
      from: { kind: "all-day", date: "2026-01-01" },
      to: { kind: "all-day", date: "2026-03-01" },
    });
    expect(mixedAllDayList.ok).toBe(true);
    if (mixedAllDayList.ok)
      expect(mixedAllDayList.value.find((item) => item.baseEventId === allDay.id)?.start).toEqual(allDay.start);
    const timedList = store.list({
      from: { kind: "timed", instant: "2026-01-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
      to: { kind: "timed", instant: "2026-03-01T00:00:00.000Z" as UtcInstant, timeZoneId: "UTC" as EventTimeZoneId },
    });
    expect(timedList.ok).toBe(true);
    if (timedList.ok) expect(timedList.value.find((item) => item.baseEventId === timed.id)?.start).toEqual(timed.start);
    store.close();
  });

  it("rejects child and guest household writes at the store gate", () => {
    const base = root();
    const adult = openCalendarStore(cap(base, "calendar-household"), cfg);
    const householdEvent = event("household", { kind: "all-day", date: "2026-03-01" });
    expect(adult.create(householdEvent).ok).toBe(true);
    adult.close();
    for (const role of ["child", "guest"] as const) {
      const store = openCalendarStore({ ...cap(base, "calendar-household"), role }, cfg);
      expect(store.create(event(`${role}-create`, householdEvent.start))).toEqual({ ok: false, error: "forbidden" });
      expect(store.update(householdEvent.id, { title: "blocked" })).toEqual({ ok: false, error: "forbidden" });
      expect(store.delete(householdEvent.id)).toEqual({ ok: false, error: "forbidden" });
      store.close();
    }
  });

  it("allows admin household CRUD", () => {
    const store = openCalendarStore({ ...cap(root(), "calendar-household"), role: "admin" }, cfg);
    const created = event("admin-event", { kind: "all-day", date: "2026-03-02" });
    expect(store.create(created).ok).toBe(true);
    expect(store.update(created.id, { title: "updated" }).ok).toBe(true);
    expect(store.delete(created.id)).toEqual({ ok: true, value: undefined });
    store.close();
  });

  it("returns not-found for writes to an absent event", () => {
    const store = openCalendarStore(cap(root()), cfg);
    const missing = "missing" as CalendarEventId;
    expect(store.update(missing, { title: "nope" })).toEqual({ ok: false, error: "not-found" });
    expect(store.delete(missing)).toEqual({ ok: false, error: "not-found" });
    store.close();
  });

  it("does not inspect or modify the legacy calendar location", () => {
    const base = root();
    const legacyRoot = join(base, "calendar");
    mkdirSync(legacyRoot, { recursive: true });
    const legacyPath = join(legacyRoot, "calendar.db");
    const legacyContents = "legacy-calendar-sentinel";
    writeFileSync(legacyPath, legacyContents);
    const store = openCalendarStore(cap(base), cfg);
    expect(existsSync(join(base, "calendar-v2", "calendar.db"))).toBe(true);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyContents);
    store.close();
  });

  it("provides revision CAS and explicit child-state operations", () => {
    const base = root();
    const persistence = openCalendarPersistence(cap(base), cfg);
    const created = event("revisioned", { kind: "all-day", date: "2026-04-01" });
    const baseEvent = { ...created, revision: 1 as CalendarRevision } as CalendarPersistenceBaseEvent;
    expect(persistence.transaction((tx) => tx.insertBaseEvent(baseEvent))).toEqual({ ok: true, value: undefined });
    expect(persistence.transaction((tx) => tx.replaceChildren(created.id, {
      exceptions: [{ occurrence: created.start, description: null }], exclusions: [], tags: ["z", "a"],
    }))).toEqual({ ok: true, value: undefined });
    expect(persistence.transaction((tx) => tx.compareAndSwapRevision(created.id, 9 as CalendarRevision))).toEqual({ ok: false, error: "conflict" });
    const unchanged = persistence.read(created.id);
    expect(unchanged).toMatchObject({ ok: true, value: { revision: 1, tags: ["a", "z"] } });
    expect(persistence.transaction((tx) => tx.compareAndSwapRevision(created.id, 1 as CalendarRevision))).toEqual({ ok: true, value: 2 as CalendarRevision });
    expect(persistence.read(created.id)).toMatchObject({ ok: true, value: { revision: 2, exceptions: [{ description: null }] } });
    persistence.close();
  });

  it("rolls back successor, child, and revision writes together", () => {
    const base = root();
    const created = event("rollback-prefix", { kind: "all-day", date: "2026-05-01" });
    const adult = openCalendarPersistence(cap(base), cfg);
    expect(adult.transaction((tx) => tx.insertBaseEvent({ ...created, revision: 1 as CalendarRevision } as CalendarPersistenceBaseEvent))).toEqual({ ok: true, value: undefined });
    const failing = openCalendarPersistence(cap(base), cfg, {
      fault: (operation) => { if (operation === "replace-tags") throw new Error("injected sqlite failure"); },
    });
    const successor = event("rollback-successor", { kind: "all-day", date: "2026-06-01" });
    const result = failing.transaction((tx) => {
      const inserted = tx.insertSuccessor({ ...successor, revision: 1 as CalendarRevision } as CalendarPersistenceBaseEvent);
      if (!inserted.ok) return inserted;
      const revision = tx.compareAndSwapRevision(created.id, 1 as CalendarRevision);
      if (!revision.ok) return revision;
      return tx.replaceChildren(created.id, { exceptions: [], exclusions: [], tags: ["partial"] });
    });
    expect(result).toEqual({ ok: false, error: "io-error" });
    expect(failing.read(successor.id)).toEqual({ ok: false, error: "not-found" });
    expect(failing.read(created.id)).toMatchObject({ ok: true, value: { revision: 1, tags: [] } });
    failing.close();
    adult.close();
  });

  it("keeps the raw hidden-read seam capability-held", () => {
    const base = root();
    const adult = openCalendarPersistence(cap(base), cfg);
    const hidden = event("raw-hidden", { kind: "all-day", date: "2026-07-01" }, { visibility: "adults" });
    expect(adult.transaction((tx) => tx.insertBaseEvent({ ...hidden, revision: 1 as CalendarRevision } as CalendarPersistenceBaseEvent))).toEqual({ ok: true, value: undefined });
    adult.close();
    const child = openCalendarPersistence({ ...cap(base), role: "child" }, cfg);
    expect(child.read(hidden.id)).toEqual({ ok: false, error: "not-found" });
    expect(child.readRaw(hidden.id)).toMatchObject({ ok: true, value: { id: hidden.id, visibility: "adults" } });
    child.close();
    const authorized = openCalendarPersistence(cap(base), cfg);
    expect(authorized.readRaw(hidden.id).ok).toBe(true);
    authorized.close();
  });

  it("rejects malformed persisted created and updated instants", () => {
    const base = root();
    const initial = openCalendarPersistence(cap(base), cfg);
    const stored = event("invalid-persisted-time", { kind: "all-day", date: "2026-08-01" });
    expect(initial.transaction((tx) => tx.insertBaseEvent({ ...stored, revision: 1 as CalendarRevision } as CalendarPersistenceBaseEvent))).toEqual({
      ok: true,
      value: undefined,
    });
    initial.close();

    const db = new Database(join(base, "calendar-v2", "calendar.db"));
    db.query("UPDATE events SET created_at = ?, updated_at = ? WHERE id = ?").run("not-an-instant", "2026-99-99", stored.id);
    db.close();

    const reopened = openCalendarPersistence(cap(base), cfg);
    expect(reopened.read(stored.id)).toEqual({ ok: false, error: "invalid" });
    expect(reopened.readRaw(stored.id)).toEqual({ ok: false, error: "invalid" });
    reopened.close();
  });

  it("leaves an ahead-of-binary database untouched", () => {
    const base = root();
    const dbPath = join(base, "calendar-v2", "calendar.db");
    mkdirSync(join(base, "calendar-v2"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${CALENDAR_SCHEMA_VERSION + 10}`);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    db.close();
    const store = openCalendarStore(cap(base), cfg);
    const check = new Database(dbPath);
    expect(check.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
      CALENDAR_SCHEMA_VERSION + 10,
    );
    store.close();
    check.close();
  });
});
