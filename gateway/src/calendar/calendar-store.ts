import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Capability, ResourceClass } from "../access/capability.js";
import { migrateDatabase, readUserVersion } from "../store/migrate-store.js";
import {
  DEFAULT_EVENT_TIME_ZONE,
  isAdult,
  type CalendarConfig,
  type CalendarEvent,
  type CalendarEventId,
  type CalendarEventPatch,
  type CalendarListWindow,
  type CalendarResult,
  type Occurrence,
  type CalendarStore,
  type CalendarTime,
  type EventTimeZoneId,
  type LocalDate,
  type UtcInstant,
} from "./types.js";
import { CALENDAR_DDL, CALENDAR_MIGRATIONS, CALENDAR_SCHEMA_VERSION } from "./schema.js";
import { expandRecurrence } from "./expand-recurrence.js";

export const ACCEPTED_CLASSES: ReadonlySet<ResourceClass> = new Set(["calendar-private", "calendar-household"]);

export interface CalendarStoreDeps {
  /** Override only for tests or an embedding store coordinator. */
  migrate?: typeof migrateDatabase;
}

type EventRow = {
  id: string; title: string; description: string | null;
  start_instant: string | null; start_time_zone_id: string | null; start_all_day: number; start_date: string | null;
  end_instant: string | null; end_time_zone_id: string | null; end_all_day: number; end_date: string | null;
  recurrence: string | null; visibility: CalendarEvent["visibility"]; importance: CalendarEvent["importance"];
  group: string | null; notification_policy: string | null; created_at: string; updated_at: string;
};

function storedTime(instant: string | null, zone: string | null, allDay: number, date: string | null): CalendarTime | undefined {
  if (allDay) return date ? { kind: "all-day", date: date as LocalDate } : undefined;
  return instant ? { kind: "timed", instant: instant as UtcInstant, timeZoneId: (zone ?? DEFAULT_EVENT_TIME_ZONE) as EventTimeZoneId } : undefined;
}
function normalizeTime(time: CalendarTime, defaultEventTimeZoneId = DEFAULT_EVENT_TIME_ZONE): CalendarTime {
  return time.kind === "timed" && !time.timeZoneId ? { ...time, timeZoneId: defaultEventTimeZoneId as EventTimeZoneId } : time;
}
function json(value: unknown): string { return JSON.stringify(value); }
function timeSortKey(time: CalendarTime): number {
  return time.kind === "all-day" ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.instant);
}

/** Opens the capability-rooted calendar database at <root>/calendar/calendar.db. */
export function openCalendarStore(cap: Capability, cfg: CalendarConfig, deps: CalendarStoreDeps = {}): CalendarStore {
  if (!ACCEPTED_CLASSES.has(cap.resource)) {
    throw new Error(`openCalendarStore: wrong resource class "${cap.resource}" — expected calendar-private or calendar-household`);
  }
  const defaultEventTimeZoneId = (cfg.defaultEventTimeZoneId ?? DEFAULT_EVENT_TIME_ZONE) as EventTimeZoneId;
  const calendarRoot = join(cap.rootPath, "calendar");
  const dbPath = join(calendarRoot, "calendar.db");
  mkdirSync(calendarRoot, { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  const recordedVersion = readUserVersion(db);
  if (recordedVersion <= CALENDAR_SCHEMA_VERSION) db.exec(CALENDAR_DDL);
  const migrate = deps.migrate ?? migrateDatabase;
  migrate(db, cap.ownerUserId, CALENDAR_MIGRATIONS, CALENDAR_SCHEMA_VERSION, "calendar");

  let closed = false;
  const usable = <T>(operation: () => CalendarResult<T>): CalendarResult<T> => {
    if (closed) return { ok: false, error: "closed" };
    try { return operation(); } catch { return { ok: false, error: "io-error" }; }
  };
  const gate = <T>(operation: () => CalendarResult<T>): CalendarResult<T> =>
    cap.resource === "calendar-household" && !isAdult(cap.role) ? { ok: false, error: "forbidden" } : operation();

  const read = (id: CalendarEventId): CalendarResult<CalendarEvent> => {
    const row = db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    if (!row) return { ok: false, error: "not-found" };
    if (row.visibility === "adults" && !isAdult(cap.role)) return { ok: false, error: "not-found" };
    const start = storedTime(row.start_instant, row.start_time_zone_id, row.start_all_day, row.start_date);
    if (!start) return { ok: false, error: "invalid" };
    let tags: string[] = [];
    const tagRows = db.query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE event_id = ? ORDER BY tag").all(id);
    tags = tagRows.map((tag) => tag.tag);
    const exdates = db.query<{ occurrence_key: string }, [string]>("SELECT occurrence_key FROM exdates WHERE event_id = ? ORDER BY occurrence_key").all(id)
      .map((r) => JSON.parse(r.occurrence_key) as CalendarTime);
    const exceptions = db.query<{ occurrence_key: string; cancelled: number; override_json: string | null }, [string]>("SELECT * FROM exceptions WHERE event_id = ? ORDER BY occurrence_key").all(id)
      .map((r) => ({ ...(JSON.parse(r.occurrence_key) as { occurrence: CalendarTime }), cancelled: !!r.cancelled, ...(r.override_json ? JSON.parse(r.override_json) : {}) }));
    const end = storedTime(row.end_instant, row.end_time_zone_id, row.end_all_day, row.end_date);
    const value: CalendarEvent = {
      id: row.id as CalendarEventId, title: row.title, ...(row.description === null ? {} : { description: row.description }), start,
      ...(end ? { end } : {}), ...(row.recurrence ? { recurrence: JSON.parse(row.recurrence) } : {}), exdates, exceptions,
      visibility: row.visibility, importance: row.importance, ...(row.group === null ? {} : { group: row.group }), tags: new Set(tags),
      ...(row.notification_policy ? { notification: JSON.parse(row.notification_policy) } : {}), createdAt: row.created_at as UtcInstant, updatedAt: row.updated_at as UtcInstant,
    };
    return { ok: true, value };
  };

  const write = (event: CalendarEvent, mode: "create" | "update"): CalendarResult<CalendarEvent> => {
    if (mode === "create" && db.query("SELECT 1 FROM events WHERE id=?").get(event.id)) return { ok: false, error: "already-exists" };
    const start = event.start;
    const end = event.end;
    const timeColumns = (time: CalendarTime | undefined) => time?.kind === "timed"
      ? [time.instant, time.timeZoneId, 0, null] : time ? [null, null, 1, time.date] : [null, null, 0, null];
    const normalizedStart = normalizeTime(start, defaultEventTimeZoneId);
    const normalizedEnd = end ? normalizeTime(end, defaultEventTimeZoneId) : undefined;
    const s = timeColumns(normalizedStart), e = timeColumns(normalizedEnd);
    const tx = db.transaction(() => {
      if (mode === "create") db.query("INSERT INTO events (id,title,description,start_instant,start_time_zone_id,start_all_day,start_date,end_instant,end_time_zone_id,end_all_day,end_date,recurrence,visibility,importance,\"group\",notification_policy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(event.id, event.title, event.description ?? null, ...s, ...e, event.recurrence ? json(event.recurrence) : null, event.visibility, event.importance, event.group ?? null, event.notification ? json(event.notification) : null, event.createdAt, event.updatedAt);
      else db.query("UPDATE events SET title=?,description=?,start_instant=?,start_time_zone_id=?,start_all_day=?,start_date=?,end_instant=?,end_time_zone_id=?,end_all_day=?,end_date=?,recurrence=?,visibility=?,importance=?,\"group\"=?,notification_policy=?,updated_at=? WHERE id=?").run(event.title, event.description ?? null, ...s, ...e, event.recurrence ? json(event.recurrence) : null, event.visibility, event.importance, event.group ?? null, event.notification ? json(event.notification) : null, event.updatedAt, event.id);
      db.query("DELETE FROM exdates WHERE event_id=?").run(event.id); db.query("DELETE FROM exceptions WHERE event_id=?").run(event.id); db.query("DELETE FROM tags WHERE event_id=?").run(event.id);
      for (const value of event.exdates ?? []) db.query("INSERT INTO exdates (event_id,occurrence_key) VALUES (?,?)").run(event.id, json(normalizeTime(value, defaultEventTimeZoneId)));
      for (const exception of event.exceptions ?? []) { const { occurrence, cancelled, ...override } = exception; db.query("INSERT INTO exceptions (event_id,occurrence_key,cancelled,override_json) VALUES (?,?,?,?)").run(event.id, json({ occurrence: normalizeTime(occurrence, defaultEventTimeZoneId) }), cancelled ? 1 : 0, Object.keys(override).length ? json(override) : null); }
      for (const tag of event.tags) db.query("INSERT INTO tags (event_id,tag) VALUES (?,?)").run(event.id, tag);
    });
    tx();
    return { ok: true, value: { ...event, start: normalizedStart, ...(normalizedEnd ? { end: normalizedEnd } : {}) } };
  };

  const list = (window: CalendarListWindow): CalendarResult<Occurrence[]> => {
    if (window.from.kind !== window.to.kind) return { ok: false, error: "invalid" };
    const rows = db.query<{ id: string }, []>("SELECT id FROM events ORDER BY start_instant, start_date, id").all();
    const occurrences: Occurrence[] = [];
    for (const row of rows) {
      const result = read(row.id as CalendarEventId);
      // Hidden events are intentionally indistinguishable from absent events on reads.
      if (!result.ok) {
        if (result.error === "not-found") continue;
        return result;
      }
      const event = result.value;
      if (window.group !== undefined && event.group !== window.group) continue;
      if (window.importance !== undefined && event.importance !== window.importance) continue;
      if (window.tags !== undefined && !window.tags.every((tag) => event.tags.has(tag))) continue;

      // A calendar may contain both time kinds. Each query is intentionally
      // kind-specific, so rows of the other kind are skipped and the caller can
      // issue the complementary query without the store rejecting the calendar.
      if (event.start.kind !== window.from.kind) continue;
      // Recurrence is evaluated in the event's timezone. The instant remains UTC;
      // only the zone attached to the query boundary changes.
      const eventWindow = event.start.kind === "timed"
        ? {
            from: { kind: "timed" as const, instant: window.from.kind === "timed" ? window.from.instant : "" as UtcInstant, timeZoneId: event.start.timeZoneId },
            to: { kind: "timed" as const, instant: window.to.kind === "timed" ? window.to.instant : "" as UtcInstant, timeZoneId: event.start.timeZoneId },
          }
        : { from: window.from, to: window.to };
      const expanded = expandRecurrence(event, eventWindow.from, eventWindow.to);
      if (!expanded.ok) return { ok: false, error: expanded.error.code === "unbounded-rrule" ? "recurrence-limit" : "invalid" };
      occurrences.push(...expanded.value);
    }
    occurrences.sort((a, b) => timeSortKey(a.start) - timeSortKey(b.start) || a.occurrenceId.localeCompare(b.occurrenceId));
    return { ok: true, value: occurrences };
  };

  return {
    get: (id) => usable(() => read(id)),
    list: (window) => usable(() => list(window)),
    create: (event) => usable(() => gate(() => write(event, "create"))),
    update: ((idOrEvent: CalendarEventId | CalendarEvent, patch?: CalendarEventPatch) => usable(() => gate(() => {
      const current = typeof idOrEvent === "string" ? read(idOrEvent) : read(idOrEvent.id);
      if (!current.ok) return current;
      const event = typeof idOrEvent === "string" ? { ...current.value, ...patch, id: idOrEvent } as CalendarEvent : idOrEvent;
      return write(event, "update");
    }))) as CalendarStore["update"],
    "delete": (id) => usable(() => gate(() => {
      const found = read(id);
      if (!found.ok) return found;
      db.transaction(() => {
        db.query("DELETE FROM exdates WHERE event_id=?").run(id);
        db.query("DELETE FROM exceptions WHERE event_id=?").run(id);
        db.query("DELETE FROM tags WHERE event_id=?").run(id);
        db.query("DELETE FROM events WHERE id=?").run(id);
      })();
      return { ok: true, value: undefined };
    })),
    close: () => { if (closed) return; closed = true; db.close(); },
  };
}
