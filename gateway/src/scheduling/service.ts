import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Schedule,
  type ScheduleCreateRequest,
  type ScheduleListResponse,
  type ScheduleTiming,
  type ScheduleTimingInput,
  type ScheduledSessionCard,
  scheduleSchema,
  scheduleSourceSchema,
} from "@sentient/protocol";
import type { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { type UserId, isValidUserId } from "../user-auth/user-id.js";
import type {
  AtomicScheduleFinalizer,
  ContentOutboxEntry,
  DueClaim,
  DueClaimSource,
  FinalizationResult,
  ScheduleCommands,
  ScheduledContentOutbox,
  SchedulingFailure,
  SchedulingResult,
} from "./contracts.js";
import { latestScheduleOccurrence, nextScheduleOccurrence } from "./recurrence.js";

const SCHEMA_VERSION = 2;
const DEFAULT_GRACE_MS = 15 * 60_000;
const DEFAULT_MAX_SCHEDULES = 1_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_CLAIM_LIMIT = 100;
const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
  message TEXT NOT NULL, timing_json TEXT NOT NULL, enabled INTEGER NOT NULL,
  source_json TEXT NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, create_fingerprint TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  deleted_revision INTEGER
);
CREATE TABLE IF NOT EXISTS occurrences (
  occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, generation INTEGER NOT NULL,
  intended_at TEXT NOT NULL, claim_token TEXT, claimed_until TEXT, session_id TEXT,
  outcome TEXT, completed_at TEXT, entry_id TEXT, message TEXT, source_json TEXT, one_time INTEGER,
  UNIQUE(schedule_id, generation, intended_at)
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(deleted, enabled, next_run_at);
CREATE TABLE IF NOT EXISTS scheduled_cards (
  occurrence_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
  intended_at TEXT NOT NULL, completed_at TEXT NOT NULL, status TEXT NOT NULL, preview TEXT
);
CREATE TABLE IF NOT EXISTS content_outbox (
  outbox_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL, entry_id TEXT NOT NULL, available_at TEXT NOT NULL,
  claim_token TEXT, claimed_until TEXT, attempt INTEGER NOT NULL DEFAULT 0, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS content_outbox_due ON content_outbox(completed_at,available_at,claimed_until);
`;

type Row = {
  schedule_id: string;
  owner_user_id: string;
  revision: number;
  generation: number;
  message: string;
  timing_json: string;
  enabled: number;
  source_json: string;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string;
  create_fingerprint: string;
  deleted: number;
  deleted_revision: number | null;
};
type OccurrenceRow = {
  occurrence_id: string;
  claim_token: string | null;
  claimed_until: string | null;
  session_id: string | null;
  outcome: string | null;
};
type Candidate = { db: Database; row: Row; owner: UserId; intendedMs: number };
type RecoverableRow = {
  occurrence_id: string;
  schedule_id: string;
  owner_user_id: string;
  intended_at: string;
  message: string;
  source_json: string;
  one_time: number;
};
type Recoverable = { db: Database; owner: UserId; row: RecoverableRow };

export interface ScheduleServiceOptions {
  /** Optional capability-root parent used by the boot scanner. */
  readonly userDataRoot?: string;
  readonly graceMs?: number;
  readonly maxSchedulesPerUser?: number;
  readonly sessionDbFileName?: string;
  readonly cardsMaxPageSize?: number;
  readonly id?: () => string;
}

export type ClaimSessionAssociation = Readonly<{ occurrenceId: string; sessionId: string; replayed: boolean }>;
/** Durable CAS used by the later chat adapter before it submits any message. */
export interface ScheduleClaimTransactions {
  associateSession(claim: DueClaim, sessionId: string): Promise<SchedulingResult<ClaimSessionAssociation>>;
}

export type ScheduleCreateOutcome = Readonly<{ schedule: Schedule; replayed: boolean }>;
export type CalendarReminderScheduleInput = Readonly<{
  eventId: string;
  reminderId: string;
  enabled: boolean;
  message?: string;
  timing?: ScheduleTimingInput;
}>;
export interface ScheduleService
  extends ScheduleCommands,
    DueClaimSource,
    ScheduleClaimTransactions,
    AtomicScheduleFinalizer,
    ScheduledContentOutbox {
  createDetailed(
    resource: PrivateScheduleResource,
    request: ScheduleCreateRequest,
    acceptedAt: Date,
  ): Promise<SchedulingResult<ScheduleCreateOutcome>>;
  /** Idempotently projects one actor-owned calendar reminder into scheduling. */
  reconcileCalendarReminder(
    resource: PrivateScheduleResource,
    input: CalendarReminderScheduleInput,
    acceptedAt: Date,
  ): Promise<SchedulingResult<void>>;
  calendarReminderOwners(eventId: string): Promise<SchedulingResult<readonly UserId[]>>;
  close(): void;
}

function fail(code: SchedulingFailure["code"], retryable = false): SchedulingResult<never> {
  return { ok: false, error: { code, retryable } };
}
function iso(date: Date): string {
  return date.toISOString();
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function fingerprint(request: ScheduleCreateRequest): string {
  return JSON.stringify(request);
}
function occurrenceId(scheduleId: string, generation: number, intendedAt: string): string {
  return `occ_${scheduleId}_${generation}_${intendedAt.replaceAll(/[^0-9]/g, "")}`;
}

function timingAt(input: ScheduleCreateRequest["timing"], acceptedAt: Date): ScheduleTiming {
  if (input.kind === "once-after")
    return { kind: "once", at: iso(new Date(acceptedAt.getTime() + input.afterSeconds * 1_000)) };
  if (input.kind === "once-at") return { kind: "once", at: iso(new Date(input.at)) };
  return input;
}
function nextRun(timing: ScheduleTiming, acceptedAt: Date, enabled: boolean): string | null {
  if (!enabled) return null;
  return timing.kind === "once" ? iso(new Date(timing.at)) : iso(nextScheduleOccurrence(timing, acceptedAt));
}
function project(row: Row): Schedule | undefined {
  const parsed = scheduleSchema.safeParse({
    scheduleId: row.schedule_id,
    revision: row.revision,
    message: row.message,
    timing: parseJson(row.timing_json),
    enabled: row.enabled === 1,
    source: parseJson(row.source_json),
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : undefined;
}

export function createScheduleService(options: ScheduleServiceOptions = {}): ScheduleService {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxSchedules = options.maxSchedulesPerUser ?? DEFAULT_MAX_SCHEDULES;
  const makeId = options.id ?? (() => crypto.randomUUID());
  if (!Number.isInteger(graceMs) || graceMs < 0 || !Number.isInteger(maxSchedules) || maxSchedules < 1)
    throw new Error("invalid schedule service limits");
  const roots = new Map<UserId, string>();
  let closed = false;

  const remember = (resource: PrivateScheduleResource): void => {
    resource.assertOwner(resource.ownerUserId);
    roots.set(resource.ownerUserId, resource.rootPath);
  };
  const openRoot = (root: string): Database => {
    if (closed) throw new Error("closed");
    const dir = join(root, "scheduling-v1");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "schedules.db"), { create: true });
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new Error("newer schedule schema");
    }
    db.exec(DDL);
    if (version < 2) {
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(occurrences)")
        .all()
        .map((r) => r.name);
      if (!columns.includes("outcome")) db.exec("ALTER TABLE occurrences ADD COLUMN outcome TEXT");
      if (!columns.includes("completed_at")) db.exec("ALTER TABLE occurrences ADD COLUMN completed_at TEXT");
      if (!columns.includes("entry_id")) db.exec("ALTER TABLE occurrences ADD COLUMN entry_id TEXT");
      if (!columns.includes("message")) db.exec("ALTER TABLE occurrences ADD COLUMN message TEXT");
      if (!columns.includes("source_json")) db.exec("ALTER TABLE occurrences ADD COLUMN source_json TEXT");
      if (!columns.includes("one_time")) db.exec("ALTER TABLE occurrences ADD COLUMN one_time INTEGER");
    }
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  };
  const withResource = async <T>(
    resource: PrivateScheduleResource,
    work: (db: Database) => SchedulingResult<T>,
  ): Promise<SchedulingResult<T>> => {
    if (closed) return fail("closed");
    remember(resource);
    let db: Database | undefined;
    try {
      db = openRoot(resource.rootPath);
      return work(db);
    } catch {
      return fail("unavailable", true);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  };

  const createDetailed: ScheduleService["createDetailed"] = (resource, request, acceptedAt) =>
    withResource<ScheduleCreateOutcome>(resource, (db) =>
      db
        .transaction((): SchedulingResult<ScheduleCreateOutcome> => {
          if (!Number.isFinite(acceptedAt.getTime())) return fail("validation");
          const existing = db
            .query<Row, [string]>("SELECT * FROM schedules WHERE idempotency_key = ?")
            .get(request.idempotencyKey);
          if (existing) {
            if (existing.create_fingerprint !== fingerprint(request)) return fail("idempotency_conflict");
            const value = project(existing);
            return value && !existing.deleted
              ? { ok: true, value: { schedule: value, replayed: true } }
              : fail("conflict");
          }
          const count = db.query<{ n: number }, []>("SELECT count(*) n FROM schedules WHERE deleted = 0").get()?.n ?? 0;
          if (count >= maxSchedules) return fail("limit_exceeded");
          const timing = timingAt(request.timing, acceptedAt);
          const at = iso(acceptedAt);
          const id = `sch_${makeId()}`;
          const enabled = request.enabled ?? true;
          let run: string | null;
          try {
            run = nextRun(timing, acceptedAt, enabled);
          } catch {
            return fail("validation");
          }
          try {
            db.query("INSERT INTO schedules VALUES (?,?,1,1,?,?,?,?,?,?,?,?,?,0,NULL)").run(
              id,
              resource.ownerUserId,
              request.message,
              JSON.stringify(timing),
              enabled ? 1 : 0,
              JSON.stringify({ kind: "user" }),
              run,
              at,
              at,
              request.idempotencyKey,
              fingerprint(request),
            );
          } catch {
            const raced = db
              .query<Row, [string]>("SELECT * FROM schedules WHERE idempotency_key = ?")
              .get(request.idempotencyKey);
            const racedValue = raced && project(raced);
            if (racedValue && !raced.deleted && raced.create_fingerprint === fingerprint(request))
              return { ok: true, value: { schedule: racedValue, replayed: true } };
            return raced ? fail("idempotency_conflict") : fail("unavailable", true);
          }
          const row = db.query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id = ?").get(id);
          const value = row && project(row);
          return value ? { ok: true, value: { schedule: value, replayed: false } } : fail("internal");
        })
        .immediate(),
    );
  const create: ScheduleCommands["create"] = async (resource, request, acceptedAt) => {
    const result = await createDetailed(resource, request, acceptedAt);
    return result.ok ? { ok: true, value: result.value.schedule } : result;
  };

  const reconcileCalendarReminder: ScheduleService["reconcileCalendarReminder"] = (resource, input, acceptedAt) =>
    withResource<void>(resource, (db) =>
      db
        .transaction((): SchedulingResult<void> => {
          if (!input.eventId || !input.reminderId || !Number.isFinite(acceptedAt.getTime())) return fail("validation");
          const source = JSON.stringify({
            kind: "calendar-reminder",
            eventId: input.eventId,
            reminderId: input.reminderId,
          });
          const existing = db.query<Row, [string]>("SELECT * FROM schedules WHERE source_json=?").get(source);
          const at = iso(acceptedAt);
          if (!input.enabled) {
            if (existing && !existing.deleted) {
              db.query(
                "UPDATE schedules SET revision=revision+1,generation=generation+1,enabled=0,next_run_at=NULL,updated_at=?,deleted=1,deleted_revision=revision+1 WHERE schedule_id=?",
              ).run(at, existing.schedule_id);
            }
            return { ok: true, value: undefined };
          }
          if (!input.message || !input.timing) return fail("validation");
          let timing: ScheduleTiming;
          let run: string | null;
          try {
            timing = timingAt(input.timing, acceptedAt);
            run = nextRun(timing, acceptedAt, true);
          } catch {
            return fail("validation");
          }
          if (existing) {
            db.query(
              "UPDATE schedules SET revision=revision+1,generation=generation+1,message=?,timing_json=?,enabled=1,next_run_at=?,updated_at=?,deleted=0,deleted_revision=NULL WHERE schedule_id=?",
            ).run(input.message, JSON.stringify(timing), run, at, existing.schedule_id);
            return { ok: true, value: undefined };
          }
          if (
            (db.query<{ n: number }, []>("SELECT count(*) n FROM schedules WHERE deleted=0").get()?.n ?? 0) >=
            maxSchedules
          )
            return fail("limit_exceeded");
          const id = `sch_${makeId()}`;
          const idempotencyKey = `calendar:${resource.ownerUserId}:${input.eventId}:${input.reminderId}`;
          db.query("INSERT INTO schedules VALUES (?,?,1,1,?,?,?,?,?,?,?,?,?,0,NULL)").run(
            id,
            resource.ownerUserId,
            input.message,
            JSON.stringify(timing),
            1,
            source,
            run,
            at,
            at,
            idempotencyKey,
            JSON.stringify({ source, message: input.message, timing }),
          );
          return { ok: true, value: undefined };
        })
        .immediate(),
    );

  const patch: ScheduleCommands["patch"] = (resource, scheduleId, request, acceptedAt) =>
    withResource<Schedule>(resource, (db) =>
      db
        .transaction((): SchedulingResult<Schedule> => {
          const row = db
            .query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id = ? AND deleted = 0")
            .get(scheduleId);
          if (!row) return fail("not_found");
          if (row.revision !== request.expectedRevision) return fail("conflict");
          const prior = project(row);
          if (!prior) return fail("internal");
          const timing = request.changes.timing ? timingAt(request.changes.timing, acceptedAt) : prior.timing;
          const enabled = request.changes.enabled ?? prior.enabled;
          let run: string | null;
          try {
            run =
              request.changes.timing || request.changes.enabled === true
                ? nextRun(timing, acceptedAt, enabled)
                : enabled
                  ? prior.nextRunAt
                  : null;
          } catch {
            return fail("validation");
          }
          const updated = iso(acceptedAt);
          const update = db
            .query(`UPDATE schedules SET revision=revision+1,generation=generation+1,message=?,timing_json=?,enabled=?,next_run_at=?,updated_at=?
      WHERE schedule_id=? AND revision=? AND deleted=0`)
            .run(
              request.changes.message ?? prior.message,
              JSON.stringify(timing),
              enabled ? 1 : 0,
              run,
              updated,
              scheduleId,
              request.expectedRevision,
            );
          if (update.changes !== 1) return fail("conflict");
          const changed = db.query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id = ?").get(scheduleId);
          const value = changed && project(changed);
          return value ? { ok: true, value } : fail("conflict");
        })
        .immediate(),
    );

  const remove: ScheduleCommands["delete"] = (resource, scheduleId, expectedRevision) =>
    withResource<void>(resource, (db) =>
      db
        .transaction((): SchedulingResult<void> => {
          const row = db.query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id = ?").get(scheduleId);
          if (!row) return fail("not_found");
          if (row.deleted)
            return row.deleted_revision === expectedRevision ? { ok: true, value: undefined } : fail("conflict");
          if (row.revision !== expectedRevision) return fail("conflict");
          const deleted = db
            .query(
              "UPDATE schedules SET deleted=1,enabled=0,next_run_at=NULL,generation=generation+1,deleted_revision=? WHERE schedule_id=? AND revision=? AND deleted=0",
            )
            .run(expectedRevision, scheduleId, expectedRevision);
          return deleted.changes === 1 ? { ok: true, value: undefined } : fail("conflict");
        })
        .immediate(),
    );

  const list: ScheduleCommands["list"] = (resource, cursor, limit) =>
    withResource(resource, (db) => {
      const bounded = Math.min(Math.max(1, limit || DEFAULT_PAGE_SIZE), 100);
      const rows = cursor
        ? db
            .query<Row, [string, number]>(
              "SELECT * FROM schedules WHERE deleted=0 AND schedule_id>? ORDER BY schedule_id LIMIT ?",
            )
            .all(cursor, bounded + 1)
        : db
            .query<Row, [number]>("SELECT * FROM schedules WHERE deleted=0 ORDER BY schedule_id LIMIT ?")
            .all(bounded + 1);
      const schedules = rows.slice(0, bounded).map(project);
      if (schedules.some((x) => !x)) return fail("internal");
      const pageEnd = rows[bounded - 1];
      const value: ScheduleListResponse = {
        schedules: schedules as Schedule[],
        ...(rows.length > bounded && pageEnd ? { nextCursor: pageEnd.schedule_id } : {}),
      };
      return { ok: true, value };
    });

  const cards: ScheduleCommands["cards"] = async (resource, cursor, limit) => {
    const bounded = Math.min(Math.max(1, limit || DEFAULT_PAGE_SIZE), options.cardsMaxPageSize ?? 100);
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) return fail("validation");

    // Cards are a projection of the authoritative append-only session store.
    // The schedule database deliberately contains only occurrence/outbox
    // bookkeeping, so one-time consumption cannot erase this inbox entry.
    const sessionDbPath = join(resource.rootPath, options.sessionDbFileName ?? "sessions.db");
    if (!existsSync(sessionDbPath)) return { ok: true, value: { cards: [] } };
    let sessionDb: Database | undefined;
    try {
      sessionDb = new Database(sessionDbPath, { readonly: true });
      const rows = sessionDb
        .query<
          {
            session_id: string;
            schedule_id: string;
            occurrence_id: string;
            intended_at: string;
            completed_at: string;
            outcome: "completed" | "failed" | "interrupted";
            preview: string | null;
          },
          [number, number]
        >(`
          SELECT s.session_id,
                 s.scheduled_schedule_id AS schedule_id,
                 s.scheduled_occurrence_id AS occurrence_id,
                 s.scheduled_intended_at AS intended_at,
                 s.scheduled_completed_at AS completed_at,
                 s.scheduled_outcome AS outcome,
                 e.text AS preview
          FROM sessions s
          LEFT JOIN entries e
            ON e.session_id=s.session_id
           AND CAST(e.seq AS TEXT)=s.scheduled_entry_id
           AND e.kind='assistant'
          WHERE s.scheduled_outcome IS NOT NULL
            AND s.scheduled_completed_at IS NOT NULL
          ORDER BY s.scheduled_completed_at DESC, s.scheduled_occurrence_id DESC
          LIMIT ? OFFSET ?
        `)
        .all(bounded + 1, offset);
      const parsed: ScheduledSessionCard[] = rows.slice(0, bounded).map((row) => {
        const preview = row.preview?.replace(/\s+/gu, " ").trim();
        return {
          sessionId: row.session_id,
          scheduleId: row.schedule_id,
          occurrenceId: row.occurrence_id,
          intendedAt: row.intended_at,
          completedAt: row.completed_at,
          status: row.outcome,
          ...(row.outcome === "completed" && preview ? { preview: Array.from(preview).slice(0, 280).join("") } : {}),
        };
      });
      return {
        ok: true,
        value: {
          cards: parsed,
          ...(rows.length > bounded ? { nextCursor: String(offset + bounded) } : {}),
        },
      };
    } catch {
      return fail("internal");
    } finally {
      sessionDb?.close();
    }
  };

  function discover(): void {
    if (!options.userDataRoot) return;
    let names: string[] = [];
    try {
      names = readdirSync(options.userDataRoot);
    } catch {
      return;
    }
    for (const name of names) if (isValidUserId(name)) roots.set(name, resolve(options.userDataRoot, name));
  }

  const claimDue: DueClaimSource["claimDue"] = async (now, limit, leaseMs) => {
    if (closed) return fail("closed");
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_CLAIM_LIMIT ||
      !Number.isInteger(leaseMs) ||
      leaseMs < 1
    )
      return fail("validation");
    discover();
    const opened: Database[] = [];
    try {
      const found: Candidate[] = [];
      const recoverable: Recoverable[] = [];
      for (const [owner, root] of roots) {
        const db = openRoot(root);
        opened.push(db);
        for (const row of db
          .query<RecoverableRow, [string]>(`
            SELECT o.occurrence_id,o.schedule_id,s.owner_user_id,o.intended_at,o.message,o.source_json,o.one_time
            FROM occurrences o JOIN schedules s ON s.schedule_id=o.schedule_id
            WHERE o.session_id IS NOT NULL AND o.outcome IS NULL
              AND (o.claimed_until IS NULL OR o.claimed_until<=?)
          `)
          .all(iso(now))) {
          if (
            row.owner_user_id !== owner ||
            !row.message ||
            !scheduleSourceSchema.safeParse(parseJson(row.source_json)).success
          )
            return fail("internal");
          recoverable.push({ db, owner, row });
        }
        const rows = db
          .query<Row, []>("SELECT * FROM schedules WHERE deleted=0 AND enabled=1 AND next_run_at IS NOT NULL")
          .all();
        for (const row of rows) {
          const schedule = project(row);
          if (!schedule) return fail("internal");
          const graceStart = new Date(now.getTime() - graceMs);
          let intended: Date | undefined;
          if (!isValidUserId(row.owner_user_id) || row.owner_user_id !== owner) return fail("internal");
          if (schedule.timing.kind === "once") {
            const at = new Date(schedule.timing.at);
            if (at < graceStart) {
              db.query(
                "UPDATE schedules SET deleted=1,enabled=0,next_run_at=NULL,generation=generation+1,deleted_revision=revision WHERE schedule_id=? AND generation=?",
              ).run(row.schedule_id, row.generation);
              continue;
            }
            if (at <= now) intended = at;
          } else {
            if (!row.next_run_at || Date.parse(row.next_run_at) > now.getTime()) continue;
            intended = latestScheduleOccurrence(schedule.timing, graceStart, now);
            if (!intended) {
              const future = nextScheduleOccurrence(schedule.timing, now);
              db.query("UPDATE schedules SET next_run_at=? WHERE schedule_id=? AND generation=?").run(
                iso(future),
                row.schedule_id,
                row.generation,
              );
            }
          }
          if (intended) found.push({ db, row, owner, intendedMs: intended.getTime() });
        }
      }
      found.sort((a, b) => a.intendedMs - b.intendedMs || a.row.schedule_id.localeCompare(b.row.schedule_id));
      recoverable.sort((a, b) => a.row.intended_at.localeCompare(b.row.intended_at));
      const claims: DueClaim[] = [];
      for (const pending of recoverable) {
        if (claims.length >= limit) break;
        const token = makeId();
        const until = iso(new Date(now.getTime() + leaseMs));
        const changed = pending.db
          .query(`UPDATE occurrences SET claim_token=?,claimed_until=? WHERE occurrence_id=? AND outcome IS NULL
            AND (claimed_until IS NULL OR claimed_until<=?)`)
          .run(token, until, pending.row.occurrence_id, iso(now));
        const source = scheduleSourceSchema.safeParse(parseJson(pending.row.source_json));
        if (changed.changes === 1 && source.success) {
          claims.push({
            claimToken: token,
            scheduleId: pending.row.schedule_id,
            occurrenceId: pending.row.occurrence_id,
            ownerUserId: pending.owner,
            source: source.data,
            intendedAt: pending.row.intended_at,
            claimedUntil: until,
            message: pending.row.message,
            oneTime: pending.row.one_time === 1,
          });
        }
      }
      for (const candidate of found) {
        if (claims.length >= limit) break;
        const claim = candidate.db
          .transaction((): DueClaim | undefined => {
            const current = candidate.db
              .query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id=?")
              .get(candidate.row.schedule_id);
            if (!current || current.deleted || !current.enabled || current.generation !== candidate.row.generation)
              return undefined;
            const schedule = project(current);
            if (!schedule || current.owner_user_id !== candidate.owner) return undefined;
            const intendedAt = iso(new Date(candidate.intendedMs));
            const oid = occurrenceId(current.schedule_id, current.generation, intendedAt);
            candidate.db
              .query(
                "INSERT OR IGNORE INTO occurrences(occurrence_id,schedule_id,generation,intended_at,message,source_json,one_time) VALUES (?,?,?,?,?,?,?)",
              )
              .run(
                oid,
                current.schedule_id,
                current.generation,
                intendedAt,
                current.message,
                current.source_json,
                schedule.timing.kind === "once" ? 1 : 0,
              );
            const occurrence = candidate.db
              .query<OccurrenceRow, [string]>(
                "SELECT occurrence_id,claim_token,claimed_until,session_id,outcome FROM occurrences WHERE occurrence_id=?",
              )
              .get(oid);
            if (
              !occurrence ||
              occurrence.outcome ||
              (occurrence.claimed_until && Date.parse(occurrence.claimed_until) > now.getTime())
            )
              return undefined;
            const token = makeId();
            const until = iso(new Date(now.getTime() + leaseMs));
            const changed = candidate.db
              .query(`UPDATE occurrences SET claim_token=?,claimed_until=? WHERE occurrence_id=? AND outcome IS NULL
            AND (claimed_until IS NULL OR claimed_until<=?)`)
              .run(token, until, oid, iso(now));
            if (changed.changes !== 1) return undefined;
            return {
              claimToken: token,
              scheduleId: current.schedule_id,
              occurrenceId: oid,
              ownerUserId: candidate.owner,
              source: schedule.source,
              intendedAt,
              claimedUntil: until,
              message: current.message,
              oneTime: schedule.timing.kind === "once",
            };
          })
          .immediate();
        if (claim) claims.push(claim);
      }
      return { ok: true, value: claims };
    } catch {
      return fail("unavailable", true);
    } finally {
      for (const db of opened)
        try {
          db.close();
        } catch {}
    }
  };

  const calendarReminderOwners: ScheduleService["calendarReminderOwners"] = async (eventId) => {
    if (closed) return fail("closed");
    if (!eventId) return fail("validation");
    discover();
    const owners: UserId[] = [];
    try {
      for (const [owner, root] of roots) {
        const db = openRoot(root);
        try {
          const rows = db.query<{ source_json: string }, []>("SELECT source_json FROM schedules").all();
          if (
            rows.some((row) => {
              const parsed = scheduleSourceSchema.safeParse(parseJson(row.source_json));
              return parsed.success && parsed.data.kind === "calendar-reminder" && parsed.data.eventId === eventId;
            })
          )
            owners.push(owner);
        } finally {
          db.close();
        }
      }
      return { ok: true, value: owners };
    } catch {
      return fail("unavailable", true);
    }
  };

  const associateSession: ScheduleClaimTransactions["associateSession"] = async (claim, sessionId) => {
    const root =
      roots.get(claim.ownerUserId) ??
      (options.userDataRoot ? resolve(options.userDataRoot, claim.ownerUserId) : undefined);
    if (!root || !sessionId) return fail("claim_lost");
    let db: Database | undefined;
    try {
      db = openRoot(root);
      const database = db;
      return database
        .transaction((): SchedulingResult<ClaimSessionAssociation> => {
          const current = database
            .query<
              {
                session_id: string | null;
                claim_token: string | null;
                generation: number;
                current_generation: number;
                enabled: number;
                deleted: number;
                schedule_id: string;
                intended_at: string;
                owner_user_id: string;
              },
              [string]
            >(`
          SELECT o.session_id,o.claim_token,o.generation,o.schedule_id,o.intended_at,s.owner_user_id,
            s.generation current_generation,s.enabled,s.deleted
          FROM occurrences o JOIN schedules s ON s.schedule_id=o.schedule_id WHERE o.occurrence_id=?`)
            .get(claim.occurrenceId);
          if (
            !current ||
            current.claim_token !== claim.claimToken ||
            current.schedule_id !== claim.scheduleId ||
            current.intended_at !== claim.intendedAt ||
            current.owner_user_id !== claim.ownerUserId
          )
            return fail("claim_lost");
          if (current.session_id)
            return current.session_id === sessionId
              ? { ok: true, value: { occurrenceId: claim.occurrenceId, sessionId, replayed: true } }
              : fail("claim_lost");
          if (current.generation !== current.current_generation || current.enabled !== 1 || current.deleted === 1)
            return fail("claim_lost");
          const changed = database
            .query("UPDATE occurrences SET session_id=? WHERE occurrence_id=? AND claim_token=? AND session_id IS NULL")
            .run(sessionId, claim.occurrenceId, claim.claimToken);
          return changed.changes === 1
            ? { ok: true, value: { occurrenceId: claim.occurrenceId, sessionId, replayed: false } }
            : fail("claim_lost");
        })
        .immediate();
    } catch {
      return fail("unavailable", true);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  };

  const finalizeClaim: AtomicScheduleFinalizer["finalizeClaim"] = async (claim, receipt, outbox) => {
    const root =
      roots.get(claim.ownerUserId) ??
      (options.userDataRoot ? resolve(options.userDataRoot, claim.ownerUserId) : undefined);
    if (!root) return fail("claim_lost");
    let db: Database | undefined;
    try {
      db = openRoot(root);
      const database = db;
      return database
        .transaction((): SchedulingResult<FinalizationResult> => {
          const occurrence = database
            .query<
              {
                outcome: string | null;
                session_id: string | null;
                claim_token: string | null;
                generation: number;
                schedule_id: string;
                intended_at: string;
              },
              [string]
            >(
              "SELECT outcome,session_id,claim_token,generation,schedule_id,intended_at FROM occurrences WHERE occurrence_id=?",
            )
            .get(claim.occurrenceId);
          if (!occurrence || occurrence.schedule_id !== claim.scheduleId || occurrence.intended_at !== claim.intendedAt)
            return fail("claim_lost");
          if (occurrence.outcome) {
            const schedule = database
              .query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id=?")
              .get(claim.scheduleId);
            return {
              ok: true,
              value: {
                occurrenceId: claim.occurrenceId,
                scheduleConsumed: schedule?.deleted === 1,
                nextRunAt: schedule?.next_run_at ?? null,
                replayed: true,
              },
            };
          }
          if (occurrence.claim_token !== claim.claimToken) return fail("claim_lost");
          if (receipt.outcome !== "expired" && occurrence.session_id !== receipt.sessionId) return fail("claim_lost");
          if (outbox) {
            if (
              receipt.outcome !== "completed" ||
              outbox.content.occurrenceId !== claim.occurrenceId ||
              outbox.content.ownerUserId !== claim.ownerUserId ||
              outbox.content.sessionId !== receipt.sessionId ||
              outbox.content.entryId !== receipt.content.entryId
            )
              return fail("validation");
            database
              .query(`INSERT OR IGNORE INTO content_outbox
            (outbox_id,occurrence_id,owner_user_id,session_id,entry_id,available_at)
            VALUES (?,?,?,?,?,?)`)
              .run(
                outbox.outboxId,
                claim.occurrenceId,
                outbox.content.ownerUserId,
                outbox.content.sessionId,
                outbox.content.entryId,
                outbox.availableAt,
              );
            const saved = database
              .query<
                {
                  outbox_id: string;
                  owner_user_id: string;
                  session_id: string;
                  entry_id: string;
                  available_at: string;
                },
                [string]
              >(
                "SELECT outbox_id,owner_user_id,session_id,entry_id,available_at FROM content_outbox WHERE occurrence_id=?",
              )
              .get(claim.occurrenceId);
            if (
              !saved ||
              saved.outbox_id !== outbox.outboxId ||
              saved.owner_user_id !== outbox.content.ownerUserId ||
              saved.session_id !== outbox.content.sessionId ||
              saved.entry_id !== outbox.content.entryId ||
              saved.available_at !== outbox.availableAt
            )
              return fail("conflict");
          }
          const entryId = receipt.outcome === "completed" ? receipt.content.entryId : null;
          database
            .query(
              "UPDATE occurrences SET outcome=?,completed_at=?,entry_id=?,claimed_until=NULL WHERE occurrence_id=? AND outcome IS NULL",
            )
            .run(receipt.outcome, receipt.completedAt, entryId, claim.occurrenceId);
          // Session provenance is the authoritative card source. Do not mirror
          // response state or content into the scheduling database.
          const schedule = database
            .query<Row, [string]>("SELECT * FROM schedules WHERE schedule_id=?")
            .get(claim.scheduleId);
          let consumed = false;
          let nextRunAt = schedule?.next_run_at ?? null;
          if (schedule && schedule.generation === occurrence.generation && !schedule.deleted) {
            const timing = project(schedule)?.timing;
            if (claim.oneTime) {
              database
                .query(
                  "UPDATE schedules SET deleted=1,enabled=0,next_run_at=NULL,generation=generation+1,deleted_revision=revision WHERE schedule_id=? AND generation=?",
                )
                .run(claim.scheduleId, occurrence.generation);
              consumed = true;
              nextRunAt = null;
            } else if (timing && timing.kind === "recurring") {
              const from = new Date(Math.max(Date.parse(claim.intendedAt), Date.parse(receipt.completedAt)));
              nextRunAt = iso(nextScheduleOccurrence(timing, from));
              database
                .query(
                  "UPDATE schedules SET next_run_at=? WHERE schedule_id=? AND generation=? AND deleted=0 AND enabled=1",
                )
                .run(nextRunAt, claim.scheduleId, occurrence.generation);
            }
          }
          return {
            ok: true,
            value: { occurrenceId: claim.occurrenceId, scheduleConsumed: consumed, nextRunAt, replayed: false },
          };
        })
        .immediate();
    } catch {
      return fail("unavailable", true);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  };

  const claimOutbox: ScheduledContentOutbox["claim"] = async (now, limit, leaseMs) => {
    if (closed) return fail("closed");
    discover();
    const entries: ContentOutboxEntry[] = [];
    try {
      for (const [owner, root] of roots) {
        if (entries.length >= limit) break;
        const db = openRoot(root);
        try {
          const rows = db
            .query<
              {
                outbox_id: string;
                occurrence_id: string;
                session_id: string;
                entry_id: string;
                available_at: string;
                attempt: number;
              },
              [string, string, number]
            >(`
            SELECT outbox_id,occurrence_id,session_id,entry_id,available_at,attempt FROM content_outbox
            WHERE completed_at IS NULL AND available_at<=? AND (claimed_until IS NULL OR claimed_until<=?) LIMIT ?
          `)
            .all(iso(now), iso(now), limit - entries.length);
          for (const row of rows) {
            const until = iso(new Date(now.getTime() + leaseMs));
            const changed = db
              .query(
                "UPDATE content_outbox SET claimed_until=?,attempt=attempt+1 WHERE outbox_id=? AND completed_at IS NULL AND (claimed_until IS NULL OR claimed_until<=?)",
              )
              .run(until, row.outbox_id, iso(now));
            if (changed.changes === 1)
              entries.push({
                outboxId: row.outbox_id,
                content: {
                  ownerUserId: owner,
                  sessionId: row.session_id,
                  occurrenceId: row.occurrence_id,
                  entryId: row.entry_id,
                },
                availableAt: row.available_at,
                attempt: row.attempt + 1,
              });
          }
        } finally {
          db.close();
        }
      }
      return { ok: true, value: entries };
    } catch {
      return fail("unavailable", true);
    }
  };

  async function mutateOutbox(outboxId: string, sql: string, value?: string): Promise<SchedulingResult<void>> {
    if (closed) return fail("closed");
    discover();
    try {
      for (const root of roots.values()) {
        const db = openRoot(root);
        try {
          const result = value === undefined ? db.query(sql).run(outboxId) : db.query(sql).run(value, outboxId);
          if (result.changes === 1) return { ok: true, value: undefined };
        } finally {
          db.close();
        }
      }
      return fail("not_found");
    } catch {
      return fail("unavailable", true);
    }
  }

  return {
    create,
    createDetailed,
    reconcileCalendarReminder,
    calendarReminderOwners,
    patch,
    delete: remove,
    list,
    cards,
    claimDue,
    associateSession,
    finalizeClaim,
    claim: claimOutbox,
    acknowledge: (outboxId) =>
      mutateOutbox(
        outboxId,
        "UPDATE content_outbox SET completed_at=datetime('now'),claimed_until=NULL WHERE outbox_id=? AND completed_at IS NULL",
      ),
    retry: (outboxId, availableAt) =>
      mutateOutbox(
        outboxId,
        "UPDATE content_outbox SET available_at=?,claimed_until=NULL WHERE outbox_id=? AND completed_at IS NULL",
        iso(availableAt),
      ),
    close: () => {
      closed = true;
      roots.clear();
    },
  };
}
