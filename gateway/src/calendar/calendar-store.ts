import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Capability, ResourceClass } from "../access/capability.js";
import {
  DEFAULT_EVENT_TIME_ZONE,
  isAdult,
  type CalendarConfig,
  type CalendarPersistenceBaseEvent,
  type CalendarPersistenceChildren,
  type CalendarPersistenceEvent,
  type CalendarEventId,
  type CalendarEventPatch,
  type CalendarRevision,
  type CalendarResult,
  type CalendarStore,
  type CalendarTime,
  type EventTimeZoneId,
  type ExceptionOverride,
  type LocalDate,
  type Occurrence,
  type StoredCalendarEvent,
  type UtcInstant,
} from "./types.js";
import { CALENDAR_DDL, CALENDAR_SCHEMA_VERSION } from "./schema.js";
import { DEFAULT_RECURRENCE_LIMITS, expandRecurrence } from "./expand-recurrence.js";
import { wireCalendarTimeSchema, wireRRuleSchema } from "./types.js";

export const ACCEPTED_CLASSES: ReadonlySet<ResourceClass> = new Set(["calendar-private", "calendar-household"]);

/** Test and embedding hooks. A fault thrown by `fault` is rolled back by SQLite. */
export interface CalendarStoreDeps {
  fault?: (operation: string) => void;
  /** Alias retained for embedders that call the hook an operation observer. */
  onOperation?: (operation: string) => void;
}

export interface CalendarPersistenceTransaction {
  readBaseEvent(id: CalendarEventId): CalendarResult<CalendarPersistenceBaseEvent>;
  getBaseEvent(id: CalendarEventId): CalendarResult<CalendarPersistenceBaseEvent>;
  readChildState(id: CalendarEventId): CalendarResult<CalendarPersistenceChildren>;
  getChildState(id: CalendarEventId): CalendarResult<CalendarPersistenceChildren>;
  readEvent(id: CalendarEventId): CalendarResult<CalendarPersistenceEvent>;
  insertBaseEvent(event: CalendarPersistenceBaseEvent): CalendarResult<void>;
  insertSuccessor(event: CalendarPersistenceBaseEvent): CalendarResult<void>;
  replaceBaseEvent(event: CalendarPersistenceBaseEvent): CalendarResult<void>;
  compareAndSwapRevision(id: CalendarEventId, expectedRevision: CalendarRevision): CalendarResult<CalendarRevision>;
  compareAndSwapBaseRevision(id: CalendarEventId, expectedRevision: CalendarRevision): CalendarResult<CalendarRevision>;
  replaceExceptions(id: CalendarEventId, exceptions: readonly ExceptionOverride[]): CalendarResult<void>;
  replaceExclusions(id: CalendarEventId, exclusions: readonly CalendarTime[]): CalendarResult<void>;
  replaceTags(id: CalendarEventId, tags: readonly string[]): CalendarResult<void>;
  replaceChildren(id: CalendarEventId, children: CalendarPersistenceChildren): CalendarResult<void>;
  deleteSegment(id: CalendarEventId): CalendarResult<void>;
}

export interface CalendarCandidateWindow {
  readonly timedFrom?: UtcInstant;
  readonly timedTo?: UtcInstant;
  readonly allDayFrom?: LocalDate;
  readonly allDayTo?: LocalDate;
}

export interface CalendarCandidateBatch {
  /** At most the requested bound; callers must not use this batch when overflow is true. */
  readonly ids: CalendarEventId[];
  readonly overflow: boolean;
}

export interface CalendarPersistence {
  /** The attenuated resource selected when this persistence handle was opened. */
  readonly scope?: "private" | "household";
  read(id: CalendarEventId): CalendarResult<CalendarPersistenceEvent>;
  get(id: CalendarEventId): CalendarResult<CalendarPersistenceEvent>;
  /** Read a bounded, conservatively windowed candidate set. The store reads max+one rows to signal overflow. */
  readBaseCandidates(limit: number, window: CalendarCandidateWindow): CalendarResult<CalendarCandidateBatch>;
  /** Narrow capability-held seam for query projection; public stores never expose it. */
  readRaw(id: CalendarEventId): CalendarResult<CalendarPersistenceEvent>;
  transaction<T>(work: (tx: CalendarPersistenceTransaction) => CalendarResult<T>): CalendarResult<T>;
  withTransaction<T>(work: (tx: CalendarPersistenceTransaction) => CalendarResult<T>): CalendarResult<T>;
  close(): void;
}

interface EventRow {
  id: string;
  revision: number;
  title: string;
  description: string | null;
  start_instant: string | null;
  start_time_zone_id: string | null;
  start_all_day: number;
  start_date: string | null;
  end_instant: string | null;
  end_time_zone_id: string | null;
  end_all_day: number;
  end_date: string | null;
  recurrence: string | null;
  visibility: string;
  importance: string;
  group: string | null;
  notification_policy: string | null;
  created_at: string;
  updated_at: string;
}

const recurrenceSchema = z.object({ rrule: z.string().min(1), rule: wireRRuleSchema }).strict();
const persistedUtcInstantSchema = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const overrideSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  start: wireCalendarTimeSchema.nullable().optional(),
  end: wireCalendarTimeSchema.nullable().optional(),
  visibility: z.enum(["everyone", "adults"]).nullable().optional(),
  importance: z.enum(["normal", "important", "pinned"]).nullable().optional(),
  group: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
}).strict();

function storedTime(instant: string | null, zone: string | null, allDay: number, date: string | null): CalendarTime | undefined {
  if (allDay) return date ? { kind: "all-day", date: date as LocalDate } : undefined;
  return instant
    ? { kind: "timed", instant: instant as UtcInstant, timeZoneId: (zone ?? DEFAULT_EVENT_TIME_ZONE) as EventTimeZoneId }
    : undefined;
}
function normalizeTime(time: CalendarTime, defaultEventTimeZoneId = DEFAULT_EVENT_TIME_ZONE): CalendarTime {
  return time.kind === "timed" && !time.timeZoneId ? { ...time, timeZoneId: defaultEventTimeZoneId as EventTimeZoneId } : time;
}
function timeColumns(time: CalendarTime | undefined): [string | null, string | null, number, string | null] {
  return time?.kind === "timed" ? [time.instant, time.timeZoneId, 0, null] : time ? [null, null, 1, time.date] : [null, null, 0, null];
}
function json(value: unknown): string { return JSON.stringify(value); }
function timeKey(value: CalendarTime): string { return json({ occurrence: value }); }
function parseJson<T>(value: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
function exceptionKey(value: unknown): CalendarTime | undefined {
  const result = z.union([
    z.object({ occurrence: wireCalendarTimeSchema }).strict().transform((v) => v.occurrence),
    wireCalendarTimeSchema,
  ]).safeParse(value);
  return result.success ? result.data as unknown as CalendarTime : undefined;
}
function sortedTags(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}
function keyForTime(value: CalendarTime): string {
  return value.kind === "all-day" ? `d:${value.date}` : `t:${value.instant}:${value.timeZoneId}`;
}

class TransactionAbort extends Error {
  constructor(readonly result: CalendarResult<never>) { super("calendar transaction aborted"); }
}

/** Opens only the fresh V2 database at `<root>/calendar-v2/calendar.db`. */
export function openCalendarPersistence(cap: Capability, _cfg: CalendarConfig, deps: CalendarStoreDeps = {}): CalendarPersistence {
  if (!ACCEPTED_CLASSES.has(cap.resource)) {
    throw new Error(`openCalendarPersistence: wrong resource class "${cap.resource}" — expected calendar-private or calendar-household`);
  }
  const calendarRoot = join(cap.rootPath, "calendar-v2");
  const dbPath = join(calendarRoot, "calendar.db");
  mkdirSync(calendarRoot, { recursive: true });
  const db = new Database(dbPath, { create: true });

  // A database newer than this binary must not be rewritten. This check is
  // intentionally after opening the V2 path, and never looks at V1 storage.
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version <= CALENDAR_SCHEMA_VERSION) {
    if (version === 0) {
      db.exec(CALENDAR_DDL);
      db.exec(`PRAGMA user_version = ${CALENDAR_SCHEMA_VERSION}`);
    } else {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
  let closed = false;
  const touch = (operation: string): void => {
    deps.onOperation?.(operation);
    deps.fault?.(operation);
  };
  const usable = <T>(operation: () => CalendarResult<T>): CalendarResult<T> => {
    if (closed) return { ok: false, error: "closed" };
    try { return operation(); } catch { return { ok: false, error: "io-error" }; }
  };

  const rowToBase = (row: EventRow): CalendarResult<CalendarPersistenceBaseEvent> => {
    const start = storedTime(row.start_instant, row.start_time_zone_id, row.start_all_day, row.start_date);
    if (!start || !Number.isInteger(row.revision) || row.revision < 1) return { ok: false, error: "invalid" };
    const validatedStart = wireCalendarTimeSchema.safeParse(start);
    if (!validatedStart.success) return { ok: false, error: "invalid" };
    const end = storedTime(row.end_instant, row.end_time_zone_id, row.end_all_day, row.end_date);
    if (row.end_instant !== null || row.end_date !== null) {
      if (!end || !wireCalendarTimeSchema.safeParse(end).success) return { ok: false, error: "invalid" };
    }
    const recurrence = row.recurrence ? parseJson(row.recurrence, recurrenceSchema) : undefined;
    if (row.recurrence && !recurrence) return { ok: false, error: "invalid" };
    const createdAt = persistedUtcInstantSchema.safeParse(row.created_at);
    const updatedAt = persistedUtcInstantSchema.safeParse(row.updated_at);
    if (!createdAt.success || !updatedAt.success) return { ok: false, error: "invalid" };
    const notification = row.notification_policy === null ? undefined : parseJson(row.notification_policy, z.record(z.unknown()));
    if (row.notification_policy !== null && !notification) return { ok: false, error: "invalid" };
    const base: CalendarPersistenceBaseEvent = {
      id: row.id as CalendarEventId,
      revision: row.revision as CalendarRevision,
      title: row.title,
      ...(row.description === null ? {} : { description: row.description }),
      start: validatedStart.data as unknown as CalendarTime,
      ...(end ? { end: end as CalendarTime } : {}),
      ...(recurrence ? { recurrence: recurrence as unknown as StoredCalendarEvent["recurrence"] } : {}),
      visibility: row.visibility as StoredCalendarEvent["visibility"],
      importance: row.importance as StoredCalendarEvent["importance"],
      ...(row.group === null ? {} : { group: row.group }),
      ...(notification ? { notification } : {}),
      createdAt: createdAt.data as UtcInstant,
      updatedAt: updatedAt.data as UtcInstant,
    } as CalendarPersistenceBaseEvent;
    if (!z.object({
      id: z.string().min(1), revision: z.number().int().positive(), title: z.string().min(1),
      description: z.string().optional(), start: wireCalendarTimeSchema, end: wireCalendarTimeSchema.optional(),
      recurrence: recurrenceSchema.optional(), visibility: z.enum(["everyone", "adults"]), importance: z.enum(["normal", "important", "pinned"]),
      group: z.string().optional(), notification: z.record(z.unknown()).optional(),
      createdAt: persistedUtcInstantSchema, updatedAt: persistedUtcInstantSchema,
    }).safeParse(base).success) return { ok: false, error: "invalid" };
    return { ok: true, value: base };
  };

  const readBase = (id: CalendarEventId): CalendarResult<CalendarPersistenceBaseEvent> => {
    const row = db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    return row ? rowToBase(row) : { ok: false, error: "not-found" };
  };
  const readChildren = (id: CalendarEventId): CalendarResult<CalendarPersistenceChildren> => {
    const exceptionRows = db.query<{ occurrence_key: string; cancelled: number; override_json: string | null }, [string]>(
      "SELECT occurrence_key, cancelled, override_json FROM exceptions WHERE event_id = ? ORDER BY occurrence_key",
    ).all(id);
    const exceptions: ExceptionOverride[] = [];
    const cancelledKeys = new Set<string>();
    for (const row of exceptionRows) {
      const parsedKey = parseJson(row.occurrence_key, z.unknown());
      const occurrence = parsedKey === undefined ? undefined : exceptionKey(parsedKey);
      if (!occurrence) return { ok: false, error: "invalid" };
      const override = row.override_json === null ? {} : parseJson(row.override_json, overrideSchema);
      if (row.override_json !== null && !override) return { ok: false, error: "invalid" };
      const sparseOverride = Object.fromEntries(Object.entries(override ?? {}).filter(([, value]) => value !== undefined));
      const key = keyForTime(occurrence);
      if (cancelledKeys.has(key)) return { ok: false, error: "invalid" };
      if (row.cancelled) cancelledKeys.add(key);
      exceptions.push({ occurrence, ...(row.cancelled ? { cancelled: true } : {}), ...sparseOverride } as ExceptionOverride);
    }
    const exclusionRows = db.query<{ occurrence_key: string }, [string]>(
      "SELECT occurrence_key FROM exclusions WHERE event_id = ? ORDER BY occurrence_key",
    ).all(id);
    const exclusions: CalendarTime[] = [];
    const exclusionKeys = new Set<string>();
    for (const row of exclusionRows) {
      const parsed = parseJson(row.occurrence_key, z.unknown());
      const occurrence = parsed === undefined ? undefined : exceptionKey(parsed);
      if (!occurrence) return { ok: false, error: "invalid" };
      const key = keyForTime(occurrence);
      if (exclusionKeys.has(key) || cancelledKeys.has(key)) return { ok: false, error: "invalid" };
      exclusionKeys.add(key);
      exclusions.push(occurrence);
    }
    const tags = db.query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE event_id = ? ORDER BY tag").all(id).map((r) => r.tag);
    if (tags.some((tag) => typeof tag !== "string")) return { ok: false, error: "invalid" };
    return { ok: true, value: { exceptions, exclusions, tags } };
  };
  const authorized = (id: CalendarEventId, raw: boolean): CalendarResult<CalendarPersistenceEvent> => {
    const base = readBase(id);
    if (!base.ok) return base;
    if (!raw && base.value.visibility === "adults" && !isAdult(cap.role)) return { ok: false, error: "not-found" };
    const children = readChildren(id);
    if (!children.ok) return children;
    return { ok: true, value: { ...base.value, ...children.value } };
  };

  const validateChildren = (children: CalendarPersistenceChildren): CalendarResult<void> => {
    const excluded = new Set<string>();
    for (const exclusion of children.exclusions) {
      const parsed = wireCalendarTimeSchema.safeParse(exclusion);
      if (!parsed.success || excluded.has(keyForTime(exclusion))) return { ok: false, error: "invalid" };
      excluded.add(keyForTime(exclusion));
    }
    const exceptions = new Set<string>();
    for (const exception of children.exceptions) {
      if (!wireCalendarTimeSchema.safeParse(exception.occurrence).success) return { ok: false, error: "invalid" };
      const key = keyForTime(exception.occurrence);
      if (exceptions.has(key) || (exception.cancelled && excluded.has(key))) return { ok: false, error: "invalid" };
      exceptions.add(key);
      const { occurrence: _occurrence, cancelled: _cancelled, ...override } = exception;
      if (!overrideSchema.safeParse(override).success) return { ok: false, error: "invalid" };
    }
    if (children.tags.some((tag) => typeof tag !== "string")) return { ok: false, error: "invalid" };
    return { ok: true, value: undefined };
  };
  const ensureEvent = (id: CalendarEventId): CalendarResult<void> => {
    const result = readBase(id);
    return result.ok ? { ok: true, value: undefined } : result as CalendarResult<void>;
  };
  const validateBase = (event: CalendarPersistenceBaseEvent): CalendarResult<void> => {
    if (event.revision < 1 || !z.string().min(1).safeParse(event.title).success) return { ok: false, error: "invalid" };
    if (!wireCalendarTimeSchema.safeParse(event.start).success || (event.end !== undefined && !wireCalendarTimeSchema.safeParse(event.end).success)) return { ok: false, error: "invalid" };
    if (event.recurrence !== undefined && !recurrenceSchema.safeParse(event.recurrence).success) return { ok: false, error: "invalid" };
    if (!z.enum(["everyone", "adults"]).safeParse(event.visibility).success || !z.enum(["normal", "important", "pinned"]).safeParse(event.importance).success) return { ok: false, error: "invalid" };
    return { ok: true, value: undefined };
  };

  const transaction = <T>(work: (tx: CalendarPersistenceTransaction) => CalendarResult<T>): CalendarResult<T> => usable(() => {
    try {
      const result = db.transaction(() => {
        // This check is deliberately inside the SQLite transaction. Callers
        // cannot bypass the household write gate through a new transaction.
        if (cap.resource === "calendar-household" && !isAdult(cap.role)) throw new TransactionAbort({ ok: false, error: "forbidden" });
        const tx: CalendarPersistenceTransaction = {
          readBaseEvent: (id) => readBase(id),
          getBaseEvent: (id) => readBase(id),
          readChildState: (id) => readChildren(id),
          getChildState: (id) => readChildren(id),
          readEvent: (id) => authorized(id, false),
          insertBaseEvent: (event) => {
            touch("insert-base-event");
            const valid = validateBase(event);
            if (!valid.ok || event.revision !== 1) return { ok: false, error: "invalid" };
            const exists = db.query("SELECT 1 FROM events WHERE id = ?").get(event.id);
            if (exists) return { ok: false, error: "already-exists" };
            const s = timeColumns(event.start), e = timeColumns(event.end);
            db.query("INSERT INTO events (id,revision,title,description,start_instant,start_time_zone_id,start_all_day,start_date,end_instant,end_time_zone_id,end_all_day,end_date,recurrence,visibility,importance,\"group\",notification_policy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
              .run(event.id, 1, event.title, event.description ?? null, ...s, ...e, event.recurrence ? json(event.recurrence) : null, event.visibility, event.importance, event.group ?? null, event.notification ? json(event.notification) : null, event.createdAt, event.updatedAt);
            return { ok: true, value: undefined };
          },
          insertSuccessor: (event) => {
            touch("insert-successor");
            return tx.insertBaseEvent(event);
          },
          replaceBaseEvent: (event) => {
            touch("replace-base-event");
            const valid = validateBase(event);
            if (!valid.ok) return valid;
            const exists = ensureEvent(event.id);
            if (!exists.ok) return exists;
            const s = timeColumns(event.start), e = timeColumns(event.end);
            db.query("UPDATE events SET title=?,description=?,start_instant=?,start_time_zone_id=?,start_all_day=?,start_date=?,end_instant=?,end_time_zone_id=?,end_all_day=?,end_date=?,recurrence=?,visibility=?,importance=?,\"group\"=?,notification_policy=?,created_at=?,updated_at=? WHERE id=?")
              .run(event.title, event.description ?? null, ...s, ...e, event.recurrence ? json(event.recurrence) : null, event.visibility, event.importance, event.group ?? null, event.notification ? json(event.notification) : null, event.createdAt, event.updatedAt, event.id);
            return { ok: true, value: undefined };
          },
          compareAndSwapRevision: (id, expectedRevision) => {
            touch("compare-and-swap-revision");
            const current = readBase(id);
            if (!current.ok) return current as CalendarResult<CalendarRevision>;
            if (current.value.revision !== expectedRevision) return { ok: false, error: "conflict" };
            const next = expectedRevision + 1;
            const changed = db.query("UPDATE events SET revision = ? WHERE id = ? AND revision = ?").run(next, id, expectedRevision);
            if (changed.changes !== 1) return { ok: false, error: "conflict" };
            return { ok: true, value: next as CalendarRevision };
          },
          compareAndSwapBaseRevision: (id, expectedRevision) => tx.compareAndSwapRevision(id, expectedRevision),
          replaceExceptions: (id, exceptions) => {
            const exists = ensureEvent(id);
            if (!exists.ok) return exists;
            const current = readChildren(id);
            if (!current.ok) return current;
            const checked = validateChildren({ ...current.value, exceptions });
            if (!checked.ok) return checked;
            touch("replace-exceptions");
            db.query("DELETE FROM exceptions WHERE event_id = ?").run(id);
            for (const exception of exceptions) {
              const { occurrence, cancelled, ...override } = exception;
              const overrideJson = Object.keys(override).length ? json(override) : null;
              db.query("INSERT INTO exceptions (event_id,occurrence_key,cancelled,override_json) VALUES (?,?,?,?)")
                .run(id, timeKey(occurrence), cancelled ? 1 : 0, overrideJson);
            }
            return { ok: true, value: undefined };
          },
          replaceExclusions: (id, exclusions) => {
            const exists = ensureEvent(id);
            if (!exists.ok) return exists;
            const current = readChildren(id);
            if (!current.ok) return current;
            const checked = validateChildren({ ...current.value, exclusions });
            if (!checked.ok) return checked;
            touch("replace-exclusions");
            db.query("DELETE FROM exclusions WHERE event_id = ?").run(id);
            for (const exclusion of exclusions) db.query("INSERT INTO exclusions (event_id,occurrence_key) VALUES (?,?)").run(id, timeKey(exclusion));
            return { ok: true, value: undefined };
          },
          replaceTags: (id, tags) => {
            const exists = ensureEvent(id);
            if (!exists.ok) return exists;
            const current = readChildren(id);
            if (!current.ok) return current;
            const checked = validateChildren({ ...current.value, tags });
            if (!checked.ok) return checked;
            touch("replace-tags");
            db.query("DELETE FROM tags WHERE event_id = ?").run(id);
            for (const tag of sortedTags(tags)) db.query("INSERT INTO tags (event_id,tag) VALUES (?,?)").run(id, tag);
            return { ok: true, value: undefined };
          },
          replaceChildren: (id, children) => {
            const checked = validateChildren(children);
            if (!checked.ok) return checked;
            const exists = ensureEvent(id);
            if (!exists.ok) return exists;
            const exceptions = tx.replaceExceptions(id, children.exceptions);
            if (!exceptions.ok) return exceptions;
            const exclusions = tx.replaceExclusions(id, children.exclusions);
            if (!exclusions.ok) return exclusions;
            return tx.replaceTags(id, children.tags);
          },
          deleteSegment: (id) => {
            touch("delete-segment");
            const exists = ensureEvent(id);
            if (!exists.ok) return exists;
            db.query("DELETE FROM events WHERE id = ?").run(id);
            return { ok: true, value: undefined };
          },
        };
        const result = work(tx);
        if (!result.ok) throw new TransactionAbort(result as CalendarResult<never>);
        touch("commit");
        return result;
      })();
      return result;
    } catch (error) {
      if (error instanceof TransactionAbort) return error.result as CalendarResult<T>;
      return { ok: false, error: "io-error" };
    }
  });

  const readBaseCandidates = (limit: number, window: CalendarCandidateWindow): CalendarResult<CalendarCandidateBatch> => usable(() => {
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: "invalid" };
    const timedFrom = window.timedFrom ?? "9999-12-31T23:59:59.999Z";
    const timedTo = window.timedTo ?? "0001-01-01T00:00:00.000Z";
    const allDayFrom = window.allDayFrom ?? "9999-12-31";
    const allDayTo = window.allDayTo ?? "0001-01-01";
    // Recurring rows can begin before the window; exception rows are included
    // conservatively because an override may move an occurrence into it.
    const rows = db.query<{ id: string }, [string, string, string, string, string, string, number]>(`
      SELECT id FROM events
      WHERE (
        (start_instant BETWEEN ? AND ? OR (recurrence IS NOT NULL AND start_instant <= ?))
        OR (start_date BETWEEN ? AND ? OR (recurrence IS NOT NULL AND start_date <= ?))
        OR EXISTS (SELECT 1 FROM exceptions WHERE exceptions.event_id = events.id)
      )
      ORDER BY id
      LIMIT ?
    `).all(timedFrom, timedTo, timedTo, allDayFrom, allDayTo, allDayTo, limit + 1);
    return {
      ok: true,
      value: {
        ids: rows.slice(0, limit).map((row) => row.id as CalendarEventId),
        overflow: rows.length > limit,
      },
    };
  });

  return {
    scope: cap.resource === "calendar-household" ? "household" : "private",
    read: (id) => usable(() => authorized(id, false)),
    get: (id) => usable(() => authorized(id, false)),
    readBaseCandidates,
    readRaw: (id) => usable(() => authorized(id, true)),
    transaction,
    withTransaction: transaction,
    close: () => { if (!closed) { closed = true; db.close(); } },
  };
}

function eventWithoutPersistenceFields(event: CalendarPersistenceEvent): StoredCalendarEvent {
  const { revision: _revision, exclusions, exceptions, tags, ...base } = event;
  return { ...base, exdates: exclusions, exceptions, tags: new Set(tags) };
}

/**
 * Compatibility-facing occurrence store. New query/mutation code should use
 * `openCalendarPersistence`; this facade only keeps the existing nudge and
 * adapters source-compatible while they migrate to explicit V2 operations.
 */
export function openCalendarStore(cap: Capability, cfg: CalendarConfig, deps: CalendarStoreDeps = {}): CalendarStore {
  const persistence = openCalendarPersistence(cap, cfg, deps);
  const defaultEventTimeZoneId = (cfg.defaultEventTimeZoneId ?? DEFAULT_EVENT_TIME_ZONE) as EventTimeZoneId;
  const recurrenceLimits = {
    ...(cfg.recurrence ?? DEFAULT_RECURRENCE_LIMITS),
    timeZoneId: defaultEventTimeZoneId,
  };
  let closed = false;
  const usable = <T>(operation: () => CalendarResult<T>): CalendarResult<T> => {
    if (closed) return { ok: false, error: "closed" };
    try { return operation(); } catch { return { ok: false, error: "io-error" }; }
  };
  const gate = <T>(operation: () => CalendarResult<T>): CalendarResult<T> =>
    cap.resource === "calendar-household" && !isAdult(cap.role) ? { ok: false, error: "forbidden" } : operation();
  const read = (id: CalendarEventId): CalendarResult<StoredCalendarEvent> => {
    const result = persistence.read(id);
    if (!result.ok) return result;
    return { ok: true, value: eventWithoutPersistenceFields(result.value) };
  };
  const write = (event: StoredCalendarEvent, mode: "create" | "update"): CalendarResult<StoredCalendarEvent> => {
    const normalizedStart = normalizeTime(event.start, defaultEventTimeZoneId);
    const normalizedEnd = event.end ? normalizeTime(event.end, defaultEventTimeZoneId) : undefined;
    const base: CalendarPersistenceBaseEvent = {
      ...event,
      start: normalizedStart,
      ...(normalizedEnd ? { end: normalizedEnd } : {}),
      revision: 1 as CalendarRevision,
    };
    const children: CalendarPersistenceChildren = {
      exceptions: (event.exceptions ?? []).map((value) => ({ ...value, occurrence: normalizeTime(value.occurrence, defaultEventTimeZoneId) })),
      exclusions: (event.exdates ?? []).map((value) => normalizeTime(value, defaultEventTimeZoneId)),
      tags: [...event.tags],
    };
    const result = persistence.transaction((tx) => {
      if (mode === "create") {
        const inserted = tx.insertBaseEvent(base);
        if (!inserted.ok) return inserted;
        return tx.replaceChildren(event.id, children);
      }
      const current = tx.readEvent(event.id);
      if (!current.ok) return current;
      const revision = current.value.revision;
      const replaced = tx.replaceBaseEvent({ ...base, revision });
      if (!replaced.ok) return replaced;
      const cas = tx.compareAndSwapRevision(event.id, revision);
      if (!cas.ok) return cas;
      return tx.replaceChildren(event.id, children);
    });
    if (!result.ok) return result;
    return { ok: true, value: { ...event, start: normalizedStart, ...(normalizedEnd ? { end: normalizedEnd } : {}) } };
  };
  const list = (window: { from: CalendarTime; to: CalendarTime; group?: string; tags?: readonly string[]; importance?: StoredCalendarEvent["importance"] }): CalendarResult<Occurrence[]> => {
    if (window.from.kind !== window.to.kind) return { ok: false, error: "invalid" };
    const candidateLimit = cfg.query?.maxOccurrences ?? cfg.recurrence?.maxOccurrences ?? 1000;
    const candidates = persistence.readBaseCandidates(candidateLimit, window.from.kind === "timed"
      ? { timedFrom: window.from.instant, timedTo: window.to.kind === "timed" ? window.to.instant : window.from.instant }
      : { allDayFrom: window.from.date, allDayTo: window.to.kind === "all-day" ? window.to.date : window.from.date });
    if (!candidates.ok) return candidates;
    if (candidates.value.overflow) return { ok: false, error: "recurrence-limit" };
    const occurrences: Occurrence[] = [];
    for (const id of candidates.value.ids) {
      const result = read(id);
      if (!result.ok) { if (result.error === "not-found") continue; return result; }
      const event = result.value;
      if (window.group !== undefined && event.group !== window.group) continue;
      if (window.importance !== undefined && event.importance !== window.importance) continue;
      if (window.tags !== undefined && !window.tags.every((tag) => event.tags.has(tag))) continue;
      if (event.start.kind !== window.from.kind) continue;
      const eventWindow = event.start.kind === "timed"
        ? { from: { kind: "timed" as const, instant: window.from.kind === "timed" ? window.from.instant : "" as UtcInstant, timeZoneId: event.start.timeZoneId }, to: { kind: "timed" as const, instant: window.to.kind === "timed" ? window.to.instant : "" as UtcInstant, timeZoneId: event.start.timeZoneId } }
        : { from: window.from, to: window.to };
      const expanded = expandRecurrence(event, eventWindow.from, eventWindow.to, recurrenceLimits);
      if (!expanded.ok) return { ok: false, error: expanded.error.code === "recurrence-limit" || expanded.error.code === "unbounded-rrule" ? "recurrence-limit" : "invalid" };
      occurrences.push(...expanded.value);
    }
    occurrences.sort((a, b) => (a.start.kind === "all-day" ? Date.parse(`${a.start.date}T00:00:00Z`) : Date.parse(a.start.instant)) - (b.start.kind === "all-day" ? Date.parse(`${b.start.date}T00:00:00Z`) : Date.parse(b.start.instant)) || a.occurrenceId.localeCompare(b.occurrenceId));
    return { ok: true, value: occurrences };
  };
  const store: CalendarStore = {
    get: (id) => usable(() => read(id)),
    list: (window) => usable(() => list(window)),
    create: (event) => usable(() => gate(() => write(event, "create"))),
    update: ((idOrEvent: CalendarEventId | StoredCalendarEvent, patch?: CalendarEventPatch) => usable(() => gate(() => {
      const id = typeof idOrEvent === "string" ? idOrEvent : idOrEvent.id;
      const current = read(id);
      if (!current.ok) return current;
      const event = typeof idOrEvent === "string" ? { ...current.value, ...patch, id } as StoredCalendarEvent : idOrEvent;
      return write(event, "update");
    }))) as CalendarStore["update"],
    delete: (id) => usable(() => gate(() => {
      const found = read(id);
      if (!found.ok) return found;
      const result = persistence.transaction((tx) => tx.deleteSegment(id));
      if (!result.ok) return result;
      return { ok: true, value: undefined };
    })),
    close: () => { if (!closed) { closed = true; persistence.close(); } },
  };
  return store;
}

export { CALENDAR_SCHEMA_VERSION };
