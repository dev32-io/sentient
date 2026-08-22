import type { ApiHttpError } from "./_helpers";
import { bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";

/** Raw temporal values accepted by the V2 REST contract. */
export type CalendarTimeInput = string;

/** Source-level time convenience; V2 decoding leaves timeZoneId absent unless supplied by the source model. */
export type CalendarTime = { kind: "timed"; instant: string; timeZoneId?: string } | { kind: "all-day"; date: string };

export type CalendarScope = "private" | "household";
export type CalendarReadScope = CalendarScope | "all";
export type CalendarVisibility = "everyone" | "adults";
export type CalendarImportance = "normal" | "important" | "pinned";

export type CalendarWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export interface CalendarRecurrence {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  weekdays?: readonly CalendarWeekday[];
  count?: number;
  until?: CalendarTimeInput;
}

/** The V2 event shape on the wire. */
export interface CalendarEventV2 {
  eventId: string;
  revision: number;
  scope: CalendarScope;
  title: string;
  description?: string;
  start: CalendarTimeInput;
  end?: CalendarTimeInput;
  recurrence?: CalendarRecurrence;
  visibility: CalendarVisibility;
  importance: CalendarImportance;
  group?: string;
  tags: readonly string[];
}

/** The V2 effective occurrence shape on the wire. */
export interface CalendarOccurrenceV2 extends CalendarEventV2 {
  occurrenceId: string;
  originalStart: CalendarTimeInput;
  recurring: boolean;
}

export interface CalendarPageV2 {
  events: CalendarOccurrenceV2[];
  nextCursor?: string;
}

export type CalendarMutationScope = "this_occurrence" | "this_and_following" | "entire_series";
export type CalendarUpdateChanges = {
  title?: string;
  description?: string | null;
  start?: CalendarTimeInput;
  end?: CalendarTimeInput | null;
  visibility?: CalendarVisibility;
  importance?: CalendarImportance;
  group?: string | null;
  tags?: readonly string[];
  recurrence?: CalendarRecurrence | null;
};

export type CalendarMutationCommand =
  | {
      operation: "update";
      applyTo: CalendarMutationScope;
      scope?: CalendarScope;
      originalStart?: CalendarTimeInput;
      expectedRevision?: number;
      changes: CalendarUpdateChanges;
    }
  | {
      operation: "delete";
      applyTo: CalendarMutationScope;
      scope?: CalendarScope;
      originalStart?: CalendarTimeInput;
      expectedRevision?: number;
    };

export interface CalendarMutationResult {
  operation: "create" | "update" | "delete";
  appliedTo: CalendarMutationScope;
  eventId: string;
  successorEventId?: string;
  resultingRevision?: number;
}

export type CalendarErrorCode =
  | "invalid_time"
  | "invalid_range"
  | "range_too_wide"
  | "invalid_scope"
  | "invalid_mutation_scope"
  | "forbidden"
  | "not_found"
  | "occurrence_not_found"
  | "result_too_large"
  | "recurrence_conflict"
  | "conflict"
  | "aborted"
  | "io_error"
  | "missing_token"
  | "malformed"
  | "expired"
  | "signature_invalid"
  | "wrong_purpose"
  | "user_not_found"
  | "invalid_user_record";

export interface CalendarError {
  code: CalendarErrorCode | string;
  message: string;
}
export type CalendarApiError = ApiHttpError & { code: CalendarErrorCode | string; reason?: string };
export type CalendarApiResult<T> = { ok: true; value: T } | { ok: false; error: CalendarApiError };

/**
 * Source-facing event model. V2 responses do not contain timestamps or a
 * legacy id, but those optional fields remain available to unchanged callers
 * and are never sent back by create/mutate adapters.
 */
export type CalendarEvent = {
  id?: string;
  eventId?: string;
  revision?: number;
  scope: CalendarScope;
  title: string;
  description?: string;
  start: CalendarTime;
  end?: CalendarTime;
  recurrence?: CalendarRecurrence;
  visibility: CalendarVisibility;
  importance: CalendarImportance;
  group?: string;
  tags: readonly string[];
  notificationPolicy?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type CalendarOccurrence = CalendarEvent & {
  /** V2 identity fields are present on service responses; optional for legacy test doubles. */
  eventId?: string;
  occurrenceId: string;
  originalStart?: CalendarTime;
  recurring?: boolean;
  /** Compatibility fields consumed by the unchanged calendar view only. */
  baseEventId: string;
  occurrenceStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
};

export interface CalendarListOptions {
  from: CalendarTimeInput | CalendarTime;
  to: CalendarTimeInput | CalendarTime;
  scope?: CalendarReadScope;
  query?: string;
  cursor?: string;
  group?: string;
  tags?: readonly string[];
  importance?: CalendarImportance;
}
export interface CalendarList {
  events: CalendarOccurrence[];
  nextCursor?: string;
}
export type CalendarPatch = Partial<
  Omit<CalendarEvent, "id" | "eventId" | "createdAt" | "updatedAt" | "description" | "end" | "group" | "recurrence">
> & {
  description?: string | null;
  end?: CalendarTime | null;
  group?: string | null;
  recurrence?: CalendarRecurrence | null;
  expectedRevision?: number;
};
export interface CalendarGetOptions {
  scope?: CalendarReadScope;
  originalStart?: CalendarTimeInput | CalendarTime;
}

export type CalendarCreateInput = {
  /** Accepted only for source compatibility; createPayload strips these fields. */
  id?: string;
  eventId?: string;
  revision?: number;
  occurrenceId?: string;
  originalStart?: CalendarTimeInput | CalendarTime;
  recurring?: boolean;
  baseEventId?: string;
  occurrenceStart?: CalendarTimeInput | CalendarTime;
  occurrenceEnd?: CalendarTimeInput | CalendarTime;
  createdAt?: string;
  updatedAt?: string;
  title: string;
  description?: string;
  start: CalendarTimeInput | CalendarTime;
  end?: CalendarTimeInput | CalendarTime;
  recurrence?: CalendarRecurrence;
  scope?: CalendarScope;
  visibility?: CalendarVisibility;
  importance?: CalendarImportance;
  group?: string;
  tags?: readonly string[];
  notificationPolicy?: Record<string, unknown>;
};

export type CalendarGetResult = CalendarEvent | CalendarOccurrence;

export interface CalendarApi {
  list(token: string, options: CalendarListOptions): Promise<CalendarApiResult<CalendarList>>;
  get(token: string, id: string, options?: CalendarGetOptions): Promise<CalendarApiResult<CalendarGetResult>>;
  create(token: string, event: CalendarCreateInput): Promise<CalendarApiResult<CalendarEvent>>;
  mutate(
    token: string,
    eventId: string,
    command: CalendarMutationCommand,
  ): Promise<CalendarApiResult<CalendarMutationResult>>;
  update(token: string, id: string, patch: CalendarPatch): Promise<CalendarApiResult<CalendarMutationResult>>;
  delete(token: string, id: string, expectedRevision?: number): Promise<CalendarApiResult<CalendarMutationResult>>;
}

type Envelope = { version?: unknown; requestId?: unknown; body?: unknown };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isEnvelope(value: unknown): value is Envelope {
  return isRecord(value) && "body" in value;
}
function invalidResponse(): CalendarApiResult<never> {
  return { ok: false, error: { status: 0, code: "invalid-json" } };
}
function decode<T>(result: CalendarApiResult<unknown>, convert: (body: unknown) => T): CalendarApiResult<T> {
  if (!result.ok) return result;
  if (!isEnvelope(result.value)) return invalidResponse();
  try {
    return { ok: true, value: convert(result.value.body) };
  } catch {
    return invalidResponse();
  }
}
function rawTime(value: CalendarTimeInput | CalendarTime): CalendarTimeInput {
  if (typeof value === "string") return value;
  return value.kind === "all-day" ? value.date : value.instant;
}
function sourceTime(value: unknown): CalendarTime {
  if (typeof value !== "string") throw new Error("invalid calendar time");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "all-day", date: value };
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid calendar time");
  // V2 sends an offset-bearing RFC3339 value, not an IANA event zone. Keep
  // the exact wire value and leave the compatibility zone absent unless a
  // caller supplied one through the source-level model.
  return { kind: "timed", instant: value };
}
function sourceRecurrence(value: unknown): CalendarRecurrence | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.frequency !== "string") return undefined;
  return value as unknown as CalendarRecurrence;
}
function sourceEvent(value: unknown): CalendarEvent {
  if (!isRecord(value) || typeof value.eventId !== "string" || typeof value.title !== "string")
    throw new Error("invalid calendar event");
  const event: CalendarEvent = {
    id: value.eventId,
    eventId: value.eventId,
    scope: value.scope as CalendarScope,
    title: value.title,
    start: sourceTime(value.start),
    visibility: value.visibility as CalendarVisibility,
    importance: value.importance as CalendarImportance,
    tags: Array.isArray(value.tags) ? (value.tags as string[]) : [],
  };
  if (typeof value.revision === "number") event.revision = value.revision;
  if (typeof value.description === "string") event.description = value.description;
  if (value.end !== undefined) event.end = sourceTime(value.end);
  if (value.recurrence !== undefined) {
    const recurrence = sourceRecurrence(value.recurrence);
    if (recurrence) event.recurrence = recurrence;
  }
  if (typeof value.group === "string") event.group = value.group;
  return event;
}
function sourceOccurrence(value: unknown): CalendarOccurrence {
  if (!isRecord(value) || typeof value.occurrenceId !== "string" || typeof value.eventId !== "string")
    throw new Error("invalid calendar occurrence");
  const event = sourceEvent(value);
  const originalStart = sourceTime(value.originalStart);
  return {
    ...event,
    eventId: value.eventId,
    occurrenceId: value.occurrenceId,
    originalStart,
    recurring: value.recurring === true,
    baseEventId: value.eventId,
    occurrenceStart: event.start,
    ...(event.end ? { occurrenceEnd: event.end } : {}),
  };
}
function sourcePage(value: unknown): CalendarList {
  if (!isRecord(value) || !Array.isArray(value.events)) throw new Error("invalid calendar page");
  return {
    events: value.events.map(sourceOccurrence),
    ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
  };
}
function mutationResult(value: unknown): CalendarMutationResult {
  if (
    !isRecord(value) ||
    typeof value.operation !== "string" ||
    typeof value.appliedTo !== "string" ||
    typeof value.eventId !== "string"
  )
    throw new Error("invalid calendar mutation result");
  return {
    operation: value.operation as CalendarMutationResult["operation"],
    appliedTo: value.appliedTo as CalendarMutationScope,
    eventId: value.eventId,
    ...(typeof value.successorEventId === "string" ? { successorEventId: value.successorEventId } : {}),
    ...(typeof value.resultingRevision === "number" ? { resultingRevision: value.resultingRevision } : {}),
  };
}
function isStructuredRecurrence(value: unknown): value is CalendarRecurrence {
  if (!isRecord(value)) return false;
  const allowed = new Set(["frequency", "interval", "weekdays", "count", "until"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!(["daily", "weekly", "monthly", "yearly"] as const).includes(value.frequency as CalendarRecurrence["frequency"]))
    return false;
  if (value.interval !== undefined && (!Number.isInteger(value.interval) || (value.interval as number) < 1))
    return false;
  if (
    value.weekdays !== undefined &&
    (!Array.isArray(value.weekdays) ||
      value.weekdays.some(
        (day) =>
          !(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).includes(
            day as CalendarWeekday,
          ),
      ))
  )
    return false;
  if (value.count !== undefined && (!Number.isInteger(value.count) || (value.count as number) < 1)) return false;
  if (value.until !== undefined && typeof value.until !== "string") return false;
  return (value.count === undefined) !== (value.until === undefined);
}

/** Only the structured V2 recurrence shape is accepted; no RRULE fallback exists. */
function recurrencePayload(value: CalendarRecurrence | null | undefined): CalendarRecurrence | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isStructuredRecurrence(value)) throw new Error("invalid recurrence");
  return value;
}
function createPayload(event: CalendarCreateInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: event.title,
    start: rawTime(event.start),
  };
  if (event.visibility !== undefined) payload.visibility = event.visibility;
  if (event.importance !== undefined) payload.importance = event.importance;
  if (event.tags !== undefined) payload.tags = [...event.tags];
  if (event.description !== undefined) payload.description = event.description;
  if (event.end !== undefined) payload.end = rawTime(event.end);
  if (event.recurrence !== undefined) payload.recurrence = recurrencePayload(event.recurrence);
  if (event.group !== undefined) payload.group = event.group;
  if (event.notificationPolicy !== undefined) payload.notificationPolicy = event.notificationPolicy;
  if (event.scope !== undefined) payload.scope = event.scope;
  return payload;
}
function changesPayload(patch: CalendarPatch): CalendarUpdateChanges {
  const changes: CalendarUpdateChanges = {};
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.start !== undefined) changes.start = rawTime(patch.start);
  if (patch.end !== undefined) changes.end = patch.end === null ? null : rawTime(patch.end);
  if (patch.visibility !== undefined) changes.visibility = patch.visibility;
  if (patch.importance !== undefined) changes.importance = patch.importance;
  if (patch.group !== undefined) changes.group = patch.group;
  if (patch.tags !== undefined) changes.tags = [...patch.tags];
  if (patch.recurrence !== undefined) {
    if (patch.recurrence === null) changes.recurrence = null;
    else {
      const recurrence = recurrencePayload(patch.recurrence);
      if (recurrence) changes.recurrence = recurrence;
    }
  }
  return changes;
}
function commandPayload(command: CalendarMutationCommand): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    operation: command.operation,
    applyTo: command.applyTo,
  };
  if (command.scope !== undefined) payload.scope = command.scope;
  if (command.originalStart !== undefined) payload.originalStart = rawTime(command.originalStart);
  if (command.expectedRevision !== undefined) payload.expectedRevision = command.expectedRevision;
  if (command.operation === "update") {
    payload.changes = { ...command.changes };
    if (command.changes.start !== undefined)
      (payload.changes as Record<string, unknown>).start = rawTime(command.changes.start);
    if (command.changes.end !== undefined && command.changes.end !== null)
      (payload.changes as Record<string, unknown>).end = rawTime(command.changes.end);
    if (command.changes.recurrence !== undefined && command.changes.recurrence !== null)
      (payload.changes as Record<string, unknown>).recurrence = recurrencePayload(command.changes.recurrence);
  }
  return payload;
}

export function createCalendarApi(config: { baseUrl?: string; fetch?: Fetcher } = {}): CalendarApi {
  const base = config.baseUrl ?? "";
  const request = config.fetch ?? globalThis.fetch.bind(globalThis);
  const call = <T>(input: RequestInfo | URL, init: RequestInit) => handleFetch<T>(request(input, init));
  return {
    async list(token, options) {
      const params = new URLSearchParams({ from: rawTime(options.from), to: rawTime(options.to) });
      if (options.scope) params.set("scope", options.scope);
      if (options.group) params.set("group", options.group);
      if (options.tags?.length) params.set("tags", options.tags.join(","));
      if (options.importance) params.set("importance", options.importance);
      if (options.query) params.set("query", options.query);
      if (options.cursor) params.set("cursor", options.cursor);
      return decode(
        await call<unknown>(`${base}/api/v1/calendar/events?${params.toString()}`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
        sourcePage,
      );
    },
    async get(token, id, options = {}) {
      const params = new URLSearchParams();
      if (options.scope) params.set("scope", options.scope);
      if (options.originalStart !== undefined) params.set("originalStart", rawTime(options.originalStart));
      const query = params.toString();
      return decode(
        await call<unknown>(`${base}/api/v1/calendar/events/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
        (body) =>
          isRecord(body) && typeof body.occurrenceId === "string" ? sourceOccurrence(body) : sourceEvent(body),
      );
    },
    async create(token, event) {
      return decode(
        await call<unknown>(`${base}/api/v1/calendar/events`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(createPayload(event)),
        }),
        sourceEvent,
      );
    },
    async mutate(token, eventId, command) {
      return decode(
        await call<unknown>(`${base}/api/v1/calendar/events/${encodeURIComponent(eventId)}/mutations`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(commandPayload(command)),
        }),
        mutationResult,
      );
    },
    async update(token, id, patch) {
      const command: CalendarMutationCommand = {
        operation: "update",
        applyTo: "entire_series",
        ...(patch.scope ? { scope: patch.scope } : {}),
        ...((patch.expectedRevision ?? patch.revision) !== undefined
          ? { expectedRevision: patch.expectedRevision ?? patch.revision }
          : {}),
        changes: changesPayload(patch),
      };
      return this.mutate(token, id, command);
    },
    async delete(token, id, expectedRevision) {
      return this.mutate(token, id, {
        operation: "delete",
        applyTo: "entire_series",
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      });
    },
  };
}
