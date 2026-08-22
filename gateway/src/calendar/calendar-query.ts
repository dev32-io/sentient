import { createHash } from "node:crypto";
import type { UserRole } from "@sentient/protocol";
import type { CalendarCandidateWindow, CalendarPersistence } from "./calendar-store.js";
import { normalizeCalendarQuery, normalizeCalendarTime } from "./calendar-temporal.js";
import { type RecurrenceExpansionLimits, expandRecurrence } from "./expand-recurrence.js";
import {
  type CalendarConfig,
  type CalendarError,
  type CalendarEventId,
  type CalendarOccurrenceProjection,
  type CalendarPage,
  type CalendarPersistenceEvent,
  type CalendarReadScope,
  type CalendarRevision,
  type CalendarScope,
  type CalendarTime,
  type CalendarTimeInput,
  type Occurrence,
  type StoredCalendarEvent,
  type UtcInstant,
  isAdult,
} from "./types.js";

/** A domain result; adapter/store errors never cross the query boundary. */
export type CalendarQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CalendarError };

export interface CalendarQuerySources {
  readonly private: CalendarPersistence;
  readonly household?: CalendarPersistence;
  readonly role: UserRole;
  readonly config: CalendarConfig;
  /** Concrete household IANA zone. Defaults to config.defaultEventTimeZoneId. */
  readonly householdTimeZone?: string;
}

export interface CalendarGetInput {
  readonly eventId: string;
  readonly originalStart?: CalendarTimeInput;
  readonly scope?: CalendarReadScope;
}

export type CalendarQueryMode = "rest" | "tool";
export interface CalendarQueryOptions {
  readonly mode?: CalendarQueryMode;
  readonly signal?: AbortSignal;
}

export interface CalendarGetOptions {
  readonly signal?: AbortSignal;
}

/** The complete tool result is intentionally an array, not a page envelope. */
export type CalendarCompleteResult = CalendarOccurrenceProjection[];
export type CalendarGetResult = CalendarOccurrenceProjection | ReturnType<typeof projectEvent>;

const CURSOR_VERSION = 1;
const SCOPE_ORDER: Record<CalendarScope, number> = { private: 0, household: 1 };
const GUIDANCE = "Narrow from/to or add scope, group, tags, or importance and retry.";

interface InternalRow {
  readonly occurrence: Occurrence;
  readonly scope: CalendarScope;
  readonly revision: CalendarRevision;
}
interface SortTuple {
  readonly start: number;
  readonly scope: number;
  readonly eventId: string;
  readonly originalStart: string;
}
interface CursorPayload {
  readonly v: number;
  readonly q: string;
  readonly t: [number, number, string, string];
}
interface NormalizedQuery {
  readonly from: CalendarTime;
  readonly to: CalendarTime;
  readonly scope: CalendarReadScope;
  readonly query?: string;
  readonly group?: string;
  readonly tags?: readonly string[];
  readonly importance?: "normal" | "important" | "pinned";
  readonly cursor?: string;
  readonly limit?: number;
}

function failure(code: CalendarError["code"], message: string): CalendarQueryResult<never> {
  return { ok: false, error: { code, message } };
}
function errorForStorage(error: string): CalendarQueryResult<never> {
  if (error === "closed" || error === "io-error")
    return failure("io_error", "Calendar storage is unavailable. Retry the request.");
  if (error === "forbidden") return failure("forbidden", "Calendar access is not available for this request.");
  if (error === "invalid" || error === "recurrence-limit")
    return failure("result_too_large", `The calendar result cannot be expanded safely. ${GUIDANCE}`);
  return failure("io_error", "Calendar storage returned an invalid result. Retry the request.");
}
function serializedFailure(): CalendarQueryResult<never> {
  return failure("result_too_large", `The calendar result is too large to return. ${GUIDANCE}`);
}
function serializeWithinBudget(value: unknown, maxChars: number): boolean {
  try {
    return JSON.stringify(value).length <= maxChars;
  } catch {
    return false;
  }
}
function timeKey(value: CalendarTime): string {
  return value.kind === "all-day" ? value.date : new Date(value.instant).toISOString();
}
function timeMillis(value: CalendarTime): number {
  return value.kind === "all-day" ? Date.parse(`${value.date}T00:00:00.000Z`) : Date.parse(value.instant);
}
function asInput(value: CalendarTime): CalendarTimeInput {
  return (value.kind === "all-day" ? value.date : value.instant) as CalendarTimeInput;
}
function compareTuple(a: SortTuple, b: SortTuple): number {
  return (
    a.start - b.start ||
    a.scope - b.scope ||
    a.eventId.localeCompare(b.eventId) ||
    a.originalStart.localeCompare(b.originalStart)
  );
}
function tupleFor(row: InternalRow): SortTuple {
  return {
    start: timeMillis(row.occurrence.start),
    scope: SCOPE_ORDER[row.scope],
    eventId: row.occurrence.eventId,
    originalStart: timeKey(row.occurrence.originalStart),
  };
}
function queryHash(query: NormalizedQuery, operation: "list" | "search"): string {
  const shape = JSON.stringify({
    operation,
    from: timeKey(query.from),
    to: timeKey(query.to),
    scope: query.scope,
    query: query.query ?? null,
    group: query.group ?? null,
    tags: query.tags ? [...query.tags].sort() : null,
    importance: query.importance ?? null,
    limit: query.limit ?? null,
  });
  return createHash("sha256").update(shape).digest("hex").slice(0, 32);
}
function encodeCursor(query: NormalizedQuery, operation: "list" | "search", tuple: SortTuple): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    q: queryHash(query, operation),
    t: [tuple.start, tuple.scope, tuple.eventId, tuple.originalStart],
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeCursor(
  cursor: string,
  query: NormalizedQuery,
  operation: "list" | "search",
): CalendarQueryResult<SortTuple> {
  try {
    if (cursor.length > 1024)
      return failure("invalid_range", "The continuation cursor is malformed; restart the query without it.");
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("cursor");
    const value = parsed as Partial<CursorPayload>;
    if (
      value.v !== CURSOR_VERSION ||
      value.q !== queryHash(query, operation) ||
      !Array.isArray(value.t) ||
      value.t.length !== 4
    )
      throw new Error("cursor");
    const [start, scope, eventId, originalStart] = value.t;
    if (
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      (scope !== 0 && scope !== 1) ||
      typeof eventId !== "string" ||
      !eventId ||
      typeof originalStart !== "string" ||
      !originalStart
    )
      throw new Error("cursor");
    return { ok: true, value: { start, scope, eventId, originalStart } };
  } catch {
    return failure(
      "invalid_range",
      "The continuation cursor is malformed or does not match this query; restart without it.",
    );
  }
}

function validScope(value: unknown): value is CalendarReadScope | undefined {
  return value === undefined || value === "private" || value === "household" || value === "all";
}
function normalizeInput(input: unknown, config: CalendarConfig): CalendarQueryResult<NormalizedQuery> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return failure("invalid_range", "from and to are required; provide both bounds and retry.");
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["from", "to", "query", "scope", "cursor", "limit", "group", "tags", "importance"]);
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    return failure("invalid_range", "The calendar query contains an unsupported field; remove it and retry.");
  if (!validScope(raw.scope)) return failure("invalid_scope", "scope must be private, household, or all.");
  if (raw.query === "")
    return failure("invalid_range", "query must not be empty; provide a search term or omit query.");
  if (raw.limit !== undefined && typeof raw.limit === "number" && raw.limit > 100)
    return failure("invalid_range", "limit must not exceed 100.");
  if (raw.importance !== undefined && !["normal", "important", "pinned"].includes(String(raw.importance)))
    return failure("invalid_range", "importance is invalid; correct it and retry.");
  if (raw.cursor !== undefined && (typeof raw.cursor !== "string" || raw.cursor.length === 0))
    return failure("invalid_range", "The continuation cursor is malformed; restart the query without it.");
  if (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1))
    return failure("invalid_range", "limit must be a positive integer.");
  const normalized = normalizeCalendarQuery(input, config);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return {
    ok: true,
    value: {
      from: normalized.value.from,
      to: normalized.value.to,
      scope: (raw.scope as CalendarReadScope | undefined) ?? "private",
      ...(typeof raw.query === "string" ? { query: raw.query } : {}),
      ...(typeof raw.group === "string" ? { group: raw.group } : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags as string[] } : {}),
      ...((["normal", "important", "pinned"] as const).includes(raw.importance as "normal" | "important" | "pinned")
        ? { importance: raw.importance as "normal" | "important" | "pinned" }
        : {}),
      ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    },
  };
}

function localDateForInstant(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}`;
}
function addDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Convert a household-local date to an instant, including DST transitions. */
function localMidnight(date: string, zone: string): number {
  const guess = Date.parse(`${date}T00:00:00.000Z`);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(guess))) parts[part.type] = part.value;
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return guess + (guess - represented);
  } catch {
    return guess;
  }
}
function timedWindow(
  query: NormalizedQuery,
  zone: string,
  eventZone: string,
): { from: CalendarTime; to: CalendarTime } {
  if (query.from.kind === "timed" && query.to.kind === "timed") {
    return {
      from: { ...query.from, timeZoneId: eventZone as never },
      to: { ...query.to, timeZoneId: eventZone as never },
    };
  }
  const fromDate = query.from.kind === "all-day" ? query.from.date : localDateForInstant(timeMillis(query.from), zone);
  const toDate = query.to.kind === "all-day" ? query.to.date : localDateForInstant(timeMillis(query.to), zone);
  return {
    from: {
      kind: "timed",
      instant: new Date(localMidnight(fromDate, zone)).toISOString() as UtcInstant,
      timeZoneId: eventZone as never,
    },
    to: {
      kind: "timed",
      instant: new Date(localMidnight(addDate(toDate, 1), zone) - 1).toISOString() as UtcInstant,
      timeZoneId: eventZone as never,
    },
  };
}
function allDayWindow(query: NormalizedQuery, zone: string): { from: CalendarTime; to: CalendarTime } {
  if (query.from.kind === "all-day" && query.to.kind === "all-day") return { from: query.from, to: query.to };
  return {
    from: { kind: "all-day", date: localDateForInstant(timeMillis(query.from), zone) as never },
    to: { kind: "all-day", date: localDateForInstant(timeMillis(query.to), zone) as never },
  };
}
function candidateWindow(query: NormalizedQuery, zone: string): CalendarCandidateWindow {
  if (query.from.kind === "timed" && query.to.kind === "timed") {
    return {
      timedFrom: query.from.instant,
      timedTo: query.to.instant,
      allDayFrom: localDateForInstant(timeMillis(query.from), zone) as never,
      allDayTo: localDateForInstant(timeMillis(query.to), zone) as never,
    };
  }
  const from = localMidnight(
    query.from.kind === "all-day" ? query.from.date : localDateForInstant(timeMillis(query.from), zone),
    zone,
  );
  const toDate = query.to.kind === "all-day" ? query.to.date : localDateForInstant(timeMillis(query.to), zone);
  const to = localMidnight(addDate(toDate, 1), zone) - 1;
  return {
    timedFrom: new Date(from).toISOString() as UtcInstant,
    timedTo: new Date(to).toISOString() as UtcInstant,
    allDayFrom:
      query.from.kind === "all-day" ? query.from.date : (localDateForInstant(timeMillis(query.from), zone) as never),
    allDayTo: toDate as never,
  };
}
function withinWindow(value: CalendarTime, window: { from: CalendarTime; to: CalendarTime }): boolean {
  return (
    value.kind === window.from.kind &&
    timeMillis(value) >= timeMillis(window.from) &&
    timeMillis(value) <= timeMillis(window.to)
  );
}
/**
 * A moved exception can have an original slot outside the requested window.
 * Expand just far enough to inspect such explicitly overridden slots, then
 * filter the effective value again. This preserves bounded expansion while
 * making the effective start (rather than the stale base slot) queryable.
 */
function expandEffective(
  event: StoredCalendarEvent,
  window: { from: CalendarTime; to: CalendarTime },
  limits: RecurrenceExpansionLimits,
  requestedOriginal?: CalendarTime,
): ReturnType<typeof expandRecurrence> {
  let broad = window;
  for (const exception of event.exceptions ?? []) {
    if (!exception.start || exception.start.kind !== window.from.kind || exception.occurrence.kind !== window.from.kind)
      continue;
    const effectiveMatches = withinWindow(exception.start, window);
    const originalMatches =
      requestedOriginal !== undefined && timeKey(exception.occurrence) === timeKey(requestedOriginal);
    if (!effectiveMatches && !originalMatches) continue;
    const from = Math.min(timeMillis(broad.from), timeMillis(exception.occurrence));
    const to = Math.max(timeMillis(broad.to), timeMillis(exception.occurrence));
    broad =
      exception.occurrence.kind === "timed"
        ? {
            from: {
              ...(broad.from as Extract<CalendarTime, { kind: "timed" }>),
              instant: new Date(from).toISOString() as UtcInstant,
            },
            to: {
              ...(broad.to as Extract<CalendarTime, { kind: "timed" }>),
              instant: new Date(to).toISOString() as UtcInstant,
            },
          }
        : {
            from: { kind: "all-day", date: new Date(from).toISOString().slice(0, 10) as never },
            to: { kind: "all-day", date: new Date(to).toISOString().slice(0, 10) as never },
          };
  }
  const expanded = expandRecurrence(event, broad.from, broad.to, limits);
  if (!expanded.ok) return expanded;
  return {
    ok: true,
    value: expanded.value.filter(
      (occurrence) =>
        withinWindow(occurrence.start, window) ||
        (requestedOriginal !== undefined && timeKey(occurrence.originalStart) === timeKey(requestedOriginal)),
    ),
  };
}

function materialize(event: CalendarPersistenceEvent): StoredCalendarEvent {
  const { revision: _revision, exclusions, exceptions, tags, ...base } = event;
  return { ...base, exdates: exclusions, exceptions, tags: new Set(tags) };
}
function frequency(value: string): "daily" | "weekly" | "monthly" | "yearly" {
  return value.toLowerCase() as "daily" | "weekly" | "monthly" | "yearly";
}
function recurrenceInput(event: StoredCalendarEvent): Record<string, unknown> | undefined {
  const rule = event.recurrence?.rule;
  if (!rule) return undefined;
  const weekdays: Record<string, string> = {
    MO: "monday",
    TU: "tuesday",
    WE: "wednesday",
    TH: "thursday",
    FR: "friday",
    SA: "saturday",
    SU: "sunday",
  };
  return {
    frequency: frequency(rule.freq),
    ...(rule.interval !== undefined ? { interval: rule.interval } : {}),
    ...(rule.byDay ? { weekdays: rule.byDay.map((day) => weekdays[day]) } : {}),
    ...(rule.count !== undefined ? { count: rule.count } : {}),
    ...(rule.until !== undefined ? { until: rule.until } : {}),
  };
}
function projectedFields(event: StoredCalendarEvent): Record<string, unknown> {
  return {
    title: event.title,
    ...(event.description !== undefined ? { description: event.description } : {}),
    start: asInput(event.start),
    ...(event.end !== undefined ? { end: asInput(event.end) } : {}),
    ...(event.recurrence ? { recurrence: recurrenceInput(event) } : {}),
    visibility: event.visibility,
    importance: event.importance,
    ...(event.group !== undefined ? { group: event.group } : {}),
    tags: [...event.tags].sort(),
  };
}

/** Project an effective occurrence without exposing exception or exclusion rows. */
export function projectOccurrence(
  row: Occurrence,
  scope: CalendarScope,
  revision: CalendarRevision,
): CalendarOccurrenceProjection {
  return {
    eventId: row.eventId,
    occurrenceId: row.occurrenceId,
    originalStart: asInput(row.originalStart),
    recurring: row.recurrence !== undefined,
    revision,
    scope,
    ...projectedFields(row),
  } as unknown as CalendarOccurrenceProjection;
}
/** Project a full effective event for get; internal child rows are never returned. */
export function projectEvent(
  event: StoredCalendarEvent,
  scope: CalendarScope,
  revision: CalendarRevision,
): {
  eventId: string;
  revision: CalendarRevision;
  scope: CalendarScope;
  [key: string]: unknown;
} {
  return { eventId: event.id, revision, scope, ...projectedFields(event) };
}

export class CalendarQueryService {
  private readonly deps: CalendarQuerySources;
  private readonly zone: string;
  private readonly recurrenceLimits: RecurrenceExpansionLimits;

  public constructor(deps: CalendarQuerySources) {
    this.deps = deps;
    this.zone = deps.householdTimeZone ?? deps.config.defaultEventTimeZoneId;
    this.recurrenceLimits = { ...deps.config.recurrence, timeZoneId: this.zone };
  }

  private sources(scope: CalendarReadScope): Array<[CalendarPersistence, CalendarScope]> | CalendarQueryResult<never> {
    if (scope === "private") return [[this.deps.private, "private"]];
    if (!this.deps.household)
      return failure("io_error", "Household calendar storage is unavailable. Retry the request.");
    if (scope === "household") return [[this.deps.household, "household"]];
    return [
      [this.deps.private, "private"],
      [this.deps.household, "household"],
    ];
  }

  private collect(query: NormalizedQuery, signal?: AbortSignal): CalendarQueryResult<{ rows: InternalRow[] }> {
    if (signal?.aborted) return failure("aborted", "The calendar operation was cancelled; retry the request.");
    const sources = this.sources(query.scope);
    if (!Array.isArray(sources)) return sources;
    const rows: InternalRow[] = [];
    const max = this.deps.config.query.maxOccurrences;
    const candidatesWindow = candidateWindow(query, this.zone);
    const expansionLimits = { ...this.recurrenceLimits, maxOccurrences: max };
    for (const [persistence, scope] of sources) {
      if (signal?.aborted) return failure("aborted", "The calendar operation was cancelled; retry the request.");
      const candidates = persistence.readBaseCandidates(max, candidatesWindow);
      if (!candidates.ok) return errorForStorage(candidates.error);
      // Never expand or return the prefix of an over-bound candidate set. The
      // store has already read max+one rows, so this is a complete-or-error
      // decision before any occurrence work begins.
      if (candidates.value.overflow) return serializedFailure();
      for (const id of candidates.value.ids) {
        if (signal?.aborted) return failure("aborted", "The calendar operation was cancelled; retry the request.");
        const raw = persistence.readRaw(id);
        if (!raw.ok) {
          if (raw.error === "not-found") continue;
          return errorForStorage(raw.error);
        }
        const event = materialize(raw.value);
        const windows =
          event.start.kind === "timed"
            ? timedWindow(query, this.zone, event.start.timeZoneId)
            : allDayWindow(query, this.zone);
        const expanded = expandEffective(event, windows, expansionLimits);
        if (!expanded.ok)
          return errorForStorage(expanded.error.code === "recurrence-limit" ? "recurrence-limit" : "invalid");
        for (const occurrence of expanded.value) {
          if (!isAdult(this.deps.role) && occurrence.visibility === "adults") continue;
          if (query.query !== undefined) {
            const needle = query.query.toLocaleLowerCase();
            if (
              !occurrence.title.toLocaleLowerCase().includes(needle) &&
              !(occurrence.description ?? "").toLocaleLowerCase().includes(needle)
            )
              continue;
          }
          if (query.group !== undefined && occurrence.group !== query.group) continue;
          if (query.importance !== undefined && occurrence.importance !== query.importance) continue;
          if (query.tags !== undefined && !query.tags.every((tag) => occurrence.tags.has(tag))) continue;
          rows.push({ occurrence, scope, revision: raw.value.revision });
          if (rows.length > max) return serializedFailure();
        }
      }
    }
    // Paging is deliberately applied only after every authorized effective
    // row has been collected and ordered. Source order is not a sort key.
    rows.sort((a, b) => compareTuple(tupleFor(a), tupleFor(b)));
    return { ok: true, value: { rows } };
  }

  private page(
    input: unknown,
    operation: "list" | "search",
    options: CalendarQueryOptions = {},
  ): CalendarQueryResult<CalendarPage | CalendarCompleteResult> {
    const normalized = normalizeInput(input, this.deps.config);
    if (!normalized.ok) return normalized;
    const query = normalized.value;
    if (operation === "search" && !query.query) return failure("invalid_range", "query is required for search.");
    const cursor = query.cursor ? decodeCursor(query.cursor, query, operation) : undefined;
    if (cursor && !cursor.ok) return cursor;
    const collected = this.collect(query, options.signal);
    if (!collected.ok) return collected;
    const mode = options.mode ?? "rest";
    const start = cursor?.ok ? cursor.value : undefined;
    const after = collected.value.rows.filter((row) => !start || compareTuple(tupleFor(row), start) > 0);
    const limit = Math.min(query.limit ?? this.deps.config.query.pageSize, this.deps.config.query.pageSize);
    if (mode === "tool") {
      // Tools cannot represent a continuation. This check is intentionally
      // independent of maxOccurrences: a complete result larger than one REST
      // page is still incomplete from the tool's perspective.
      if (start || after.length > limit) return serializedFailure();
      const complete = after.map((row) => projectOccurrence(row.occurrence, row.scope, row.revision));
      if (!serializeWithinBudget(complete, this.deps.config.output.maxResultChars)) return serializedFailure();
      return { ok: true, value: complete };
    }
    const events = after.slice(0, limit).map((row) => projectOccurrence(row.occurrence, row.scope, row.revision));
    const last = after[events.length - 1];
    const hasMore = after.length > events.length;
    // REST consumers receive bounded pages and may traverse the complete
    // aggregate with the cursor. The model-result character budget applies to
    // complete tool results, not to the REST aggregate (or its pages).
    const page: CalendarPage = {
      events,
      ...(hasMore && last ? { nextCursor: encodeCursor(query, operation, tupleFor(last)) } : {}),
    };
    return { ok: true, value: page };
  }

  /** REST-shaped bounded page. */
  public list(input: unknown): CalendarQueryResult<CalendarPage>;
  public list(input: unknown, options: { readonly mode: "tool" }): CalendarQueryResult<CalendarCompleteResult>;
  public list(
    input: unknown,
    options?: CalendarQueryOptions,
  ): CalendarQueryResult<CalendarPage | CalendarCompleteResult> {
    const result = this.page(input, "list", options);
    return result;
  }
  /** REST-shaped bounded search page. */
  public search(input: unknown): CalendarQueryResult<CalendarPage>;
  public search(input: unknown, options: { readonly mode: "tool" }): CalendarQueryResult<CalendarCompleteResult>;
  public search(
    input: unknown,
    options?: CalendarQueryOptions,
  ): CalendarQueryResult<CalendarPage | CalendarCompleteResult> {
    const result = this.page(input, "search", options);
    return result;
  }
  public listPage(input: unknown): CalendarQueryResult<CalendarPage> {
    return this.list(input);
  }
  public searchPage(input: unknown): CalendarQueryResult<CalendarPage> {
    return this.search(input);
  }
  public listComplete(input: unknown, options: CalendarQueryOptions = {}): CalendarQueryResult<CalendarCompleteResult> {
    const result = this.page(input, "list", { ...options, mode: "tool" });
    return result.ok ? { ok: true, value: result.value as CalendarCompleteResult } : result;
  }
  public searchComplete(
    input: unknown,
    options: CalendarQueryOptions = {},
  ): CalendarQueryResult<CalendarCompleteResult> {
    const result = this.page(input, "search", { ...options, mode: "tool" });
    return result.ok ? { ok: true, value: result.value as CalendarCompleteResult } : result;
  }

  /** Resolve one event/occurrence only inside the requested scope. */
  public get(
    input: CalendarGetInput | string,
    originalStart?: CalendarTimeInput,
    requestedScope?: CalendarReadScope,
    options: CalendarGetOptions = {},
  ): CalendarQueryResult<CalendarGetResult> {
    if (options.signal?.aborted) return failure("aborted", "The calendar operation was cancelled; retry the request.");
    const target: CalendarGetInput =
      typeof input === "string"
        ? {
            eventId: input,
            ...(originalStart !== undefined ? { originalStart } : {}),
            ...(requestedScope !== undefined ? { scope: requestedScope } : {}),
          }
        : input;
    if (!target || typeof target.eventId !== "string" || target.eventId.length === 0)
      return failure("not_found", "The requested calendar event was not found.");
    if (!validScope(target.scope)) return failure("invalid_scope", "scope must be private, household, or all.");
    const scope = target.scope ?? "private";
    const sources = this.sources(scope);
    if (!Array.isArray(sources)) return sources;
    let normalizedOriginal: CalendarTime | undefined;
    if (target.originalStart !== undefined) {
      const parsed = normalizeCalendarTime(target.originalStart, this.deps.config);
      if (!parsed.ok) return failure("invalid_time", "originalStart is not a supported calendar time.");
      normalizedOriginal = parsed.value;
    }
    for (const [persistence, storeScope] of sources) {
      if (options.signal?.aborted)
        return failure("aborted", "The calendar operation was cancelled; retry the request.");
      const raw = persistence.readRaw(target.eventId as CalendarEventId);
      if (!raw.ok) {
        if (raw.error === "not-found") continue;
        return errorForStorage(raw.error);
      }
      const event = materialize(raw.value);
      if (!normalizedOriginal) {
        if (!isAdult(this.deps.role) && event.visibility === "adults") continue;
        const result = projectEvent(event, storeScope, raw.value.revision);
        if (!serializeWithinBudget(result, this.deps.config.output.maxResultChars)) return serializedFailure();
        return { ok: true, value: result };
      }
      const broad =
        normalizedOriginal.kind === "timed"
          ? timedWindow(
              { from: normalizedOriginal, to: normalizedOriginal, scope: storeScope },
              this.zone,
              event.start.kind === "timed" ? event.start.timeZoneId : normalizedOriginal.timeZoneId,
            )
          : allDayWindow({ from: normalizedOriginal, to: normalizedOriginal, scope: storeScope }, this.zone);
      const expanded =
        event.start.kind === normalizedOriginal.kind
          ? expandEffective(event, broad, this.recurrenceLimits, normalizedOriginal)
          : { ok: true as const, value: [] as Occurrence[] };
      if (!expanded.ok)
        return errorForStorage(expanded.error.code === "recurrence-limit" ? "recurrence-limit" : "invalid");
      const occurrence = expanded.value.find(
        (candidate) => timeKey(candidate.originalStart) === timeKey(normalizedOriginal),
      );
      if (!occurrence || (!isAdult(this.deps.role) && occurrence.visibility === "adults")) continue;
      const result = projectOccurrence(occurrence, storeScope, raw.value.revision);
      if (!serializeWithinBudget(result, this.deps.config.output.maxResultChars)) return serializedFailure();
      return { ok: true, value: result };
    }
    return failure(
      normalizedOriginal ? "occurrence_not_found" : "not_found",
      normalizedOriginal
        ? "The requested calendar occurrence was not found."
        : "The requested calendar event was not found.",
    );
  }

  public getEvent(
    input: CalendarGetInput | string,
    originalStart?: CalendarTimeInput,
    requestedScope?: CalendarReadScope,
    options?: CalendarGetOptions,
  ): CalendarQueryResult<CalendarGetResult> {
    return this.get(input, originalStart, requestedScope, options);
  }
  public listEvents(input: unknown): CalendarQueryResult<CalendarPage> {
    return this.list(input);
  }
  public searchEvents(input: unknown): CalendarQueryResult<CalendarPage> {
    return this.search(input);
  }
}

export function createCalendarQueryService(deps: CalendarQuerySources): CalendarQueryService {
  return new CalendarQueryService(deps);
}
export const createCalendarQuery = createCalendarQueryService;
export const CalendarQuery = CalendarQueryService;
export const projectCalendarOccurrence = projectOccurrence;

/** Internal bounded seam for nudge composition and other trusted producers.
 * REST pages are traversed here rather than using the tool-complete mode so a
 * small operator page_size cannot make a bounded nudge disappear. The service
 * still enforces maxOccurrences before returning any page, and the hard page
 * count is one above the shipped 1000-occurrence ceiling. */
export function queryEffectiveOccurrences(
  service: CalendarQueryService,
  input: Parameters<CalendarQueryService["listComplete"]>[0],
): CalendarQueryResult<CalendarCompleteResult> {
  const occurrences: CalendarCompleteResult = [];
  let cursor: string | undefined;
  for (let page = 0; page <= 1000; page++) {
    const pageInput = cursor === undefined ? input : { ...(input as Record<string, unknown>), cursor };
    const result = service.list(pageInput);
    if (!result.ok) return result as CalendarQueryResult<CalendarCompleteResult>;
    occurrences.push(...result.value.events);
    if (result.value.nextCursor === undefined) return { ok: true, value: occurrences };
    cursor = result.value.nextCursor;
  }
  return failure("result_too_large", `The calendar result is too large to return. ${GUIDANCE}`);
}
