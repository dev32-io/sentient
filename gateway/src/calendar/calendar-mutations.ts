import type { Capability } from "../access/capability.js";
import { type CalendarPersistence, openCalendarPersistence } from "./calendar-store.js";
import {
  calendarTimeKey,
  normalizeCalendarEventTimes,
  normalizeCalendarTime,
  validateCalendarInputLimits,
} from "./calendar-temporal.js";
import {
  type RecurrenceExpansionLimits,
  canonicalOriginalKey,
  canonicalizeRecurrence,
  enumerateGeneratedSlots,
  verifyGeneratedSlot,
} from "./expand-recurrence.js";
import {
  type CalendarConfig,
  type CalendarCreateInput,
  type CalendarError,
  type CalendarEvent,
  type CalendarEventId,
  type CalendarMutationCommand,
  type CalendarMutationResult as CalendarMutationValue,
  type CalendarNotification,
  type CalendarPersistenceBaseEvent,
  type CalendarPersistenceEvent,
  type CalendarRevision,
  type ExceptionOverride,
  type CalendarScope,
  type CalendarTime,
  type CalendarTimeInput,
  type Recurrence,
  type UtcInstant,
  DEFAULT_EVENT_TIME_ZONE,
  isAdult,
  calendarCreateInputSchema,
  calendarMutationCommandSchema,
} from "./types.js";

/** The service deliberately accepts no principal: authority is carried by the persistence handle. */
export interface CalendarMutationContext {
  readonly persistence: CalendarPersistence;
  readonly config: CalendarConfig;
  readonly signal?: AbortSignal;
}

export type CalendarMutationServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CalendarError };

type MutationArgs = CalendarPersistence | CalendarMutationContext;

const weekdayNames = {
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
  SU: "sunday",
} as const;
const frequencies = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as const;

function contextOf(
  storeOrContext: MutationArgs,
  config?: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationContext {
  if ("persistence" in storeOrContext) return storeOrContext;
  if (!config) throw new Error("calendar mutation config is required");
  return { persistence: storeOrContext, config, ...(signal ? { signal } : {}) };
}

export type CalendarMutationResult<T> = CalendarMutationServiceResult<T>;
type FailureResult = { readonly ok: false; readonly error: CalendarError };

type MutationCommand = Exclude<CalendarMutationCommand, { operation: "create" }>;

function failure(code: CalendarError["code"], message: string): FailureResult {
  return { ok: false, error: { code, message } };
}
function aborted(): FailureResult {
  return failure("aborted", "calendar mutation was cancelled before it could be committed; retry the operation.");
}
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
function scopeFor(value: unknown): CalendarScope | undefined {
  return value === "private" || value === "household" ? value : undefined;
}
function scopeMismatch(context: CalendarMutationContext, requested: CalendarScope): boolean {
  return context.persistence.scope !== undefined && context.persistence.scope !== requested;
}
function scopeError(requested: unknown): FailureResult {
  if (requested === "all")
    return failure(
      "invalid_scope",
      "calendar writes require exactly one private or household target; all is read-only.",
    );
  return failure(
    "invalid_scope",
    "calendar writes require one private or household target; choose a writable scope and retry.",
  );
}
function storeError(error: string): FailureResult {
  switch (error) {
    case "not-found":
      return failure("not_found", "calendar event was not found.");
    case "forbidden":
      return failure("forbidden", "you are not authorized to mutate this calendar.");
    case "conflict":
      return failure("conflict", "calendar event revision is stale; reread the event and retry intentionally.");
    case "invalid":
      return failure("malformed", "calendar event data is invalid; correct the request and retry.");
    case "recurrence-limit":
      return failure(
        "invalid_range",
        "recurrence exceeds the configured finite calendar limit; narrow the recurrence and retry.",
      );
    case "closed":
    case "io-error":
      return failure("io_error", "calendar storage is unavailable; retry the operation.");
    default:
      return failure("io_error", "calendar storage is unavailable; retry the operation.");
  }
}

function outputTime(time: CalendarTime): CalendarTimeInput {
  return (time.kind === "all-day" ? time.date : time.instant) as CalendarTimeInput;
}
function outputRecurrence(recurrence: Recurrence | undefined): CalendarEvent["recurrence"] {
  if (!recurrence) return undefined;
  const rule = recurrence.rule;
  return {
    frequency: frequencies[rule.freq],
    ...(rule.interval !== undefined ? { interval: rule.interval } : {}),
    ...(rule.byDay ? { weekdays: rule.byDay.map((day) => weekdayNames[day]) } : {}),
    ...(rule.count !== undefined ? { count: rule.count } : {}),
    ...(rule.until !== undefined ? { until: rule.until as unknown as CalendarTimeInput } : {}),
  } as unknown as CalendarEvent["recurrence"];
}
function project(event: CalendarPersistenceEvent, scope: CalendarScope): CalendarEvent {
  return {
    eventId: event.id,
    revision: event.revision,
    scope,
    title: event.title,
    ...(event.description !== undefined ? { description: event.description } : {}),
    start: outputTime(event.start),
    ...(event.end !== undefined ? { end: outputTime(event.end) } : {}),
    visibility: event.visibility,
    importance: event.importance,
    ...(event.group !== undefined ? { group: event.group } : {}),
    tags: [...event.tags],
    ...(event.recurrence ? { recurrence: outputRecurrence(event.recurrence) } : {}),
  } as unknown as CalendarEvent;
}
function recurrenceLimits(config: CalendarConfig): RecurrenceExpansionLimits {
  return {
    maxOccurrences: config.recurrence?.maxOccurrences ?? 1000,
    maxDays: config.recurrence?.maxDays ?? 366,
    timeZoneId: config.defaultEventTimeZoneId,
  };
}
function recurrenceError(error: { code: string }): FailureResult {
  if (error.code === "recurrence-limit" || error.code === "unbounded-rrule") {
    return failure(
      "invalid_range",
      "recurrence exceeds the configured finite calendar limit; narrow the recurrence and retry.",
    );
  }
  if (error.code === "missing-timezone" || error.code === "invalid-timezone") {
    return failure(
      "invalid_time",
      "the configured household timezone cannot be used for recurrence; correct configuration and retry.",
    );
  }
  return failure("malformed", "recurrence is invalid; provide one bounded supported recurrence and retry.");
}

function validateScope(context: CalendarMutationContext, requested: unknown): CalendarMutationResult<CalendarScope> {
  const scope = scopeFor(requested);
  if (!scope) return scopeError(requested);
  if (scopeMismatch(context, scope)) {
    // A handle is already attenuated. Do not let a caller relabel one resource
    // as another, and do not disclose whether the other resource contains data.
    return failure("not_found", "calendar event was not found.");
  }
  return { ok: true, value: scope };
}

function validateCreateInput(
  input: unknown,
  config: CalendarConfig,
):
  | {
      ok: true;
      value: CalendarCreateInput;
      scope: CalendarScope;
      times: { start: CalendarTime; end?: CalendarTime };
      recurrence?: Recurrence;
    }
  | FailureResult {
  if (isRecord(input) && input.scope !== undefined && input.scope !== "private" && input.scope !== "household")
    return scopeError(input.scope);
  const parsed = calendarCreateInputSchema.safeParse(input);
  if (!parsed.success) return failure("malformed", "calendar create input is invalid; correct the fields and retry.");
  const value = parsed.data;
  const requestedScope = scopeFor(value.scope ?? "private");
  if (!requestedScope) return scopeError(value.scope);
  const limits = validateCalendarInputLimits(
    {
      title: value.title,
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(value.group !== undefined ? { group: value.group } : {}),
      tags: value.tags,
    },
    config,
  );
  if (!limits.ok) return failure(limits.error.code, limits.error.message);
  const recurrence = value.recurrence;
  const times = normalizeCalendarEventTimes(value.start, value.end, config, { recurring: recurrence !== undefined });
  if (!times.ok) return failure(times.error.code, times.error.message);
  let canonical: Recurrence | undefined;
  if (recurrence) {
    const result = canonicalizeRecurrence(recurrence, config.defaultEventTimeZoneId);
    if (!result.ok) return recurrenceError(result.error);
    canonical = result.value;
    const slots = enumerateGeneratedSlots(
      { start: times.value.start, recurrence: canonical },
      recurrenceLimits(config),
    );
    if (!slots.ok) return recurrenceError(slots.error);
    if (slots.value.length === 0)
      return failure("malformed", "recurrence does not generate an event occurrence; adjust the recurrence and retry.");
  }
  return {
    ok: true,
    value,
    scope: requestedScope,
    times: times.value,
    ...(canonical ? { recurrence: canonical } : {}),
  };
}

/**
 * Create a V2 event. The overload accepting a context is the preferred seam;
 * the positional form keeps the service convenient for REST/tool adapters.
 */
export function createCalendarEvent(
  input: CalendarCreateInput,
  context: CalendarMutationContext,
): CalendarMutationResult<CalendarEvent>;
export function createCalendarEvent(
  input: CalendarCreateInput,
  persistence: CalendarPersistence,
  config: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationResult<CalendarEvent>;
export function createCalendarEvent(
  input: CalendarCreateInput,
  storeOrContext: MutationArgs,
  config?: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationResult<CalendarEvent> {
  const context = contextOf(storeOrContext, config, signal);
  if (isAborted(context.signal)) return aborted();
  const checked = validateCreateInput(input, context.config);
  if (!checked.ok) return checked;
  if (scopeMismatch(context, checked.scope)) return failure("not_found", "calendar event was not found.");
  const now = new Date().toISOString() as UtcInstant;
  const eventId = crypto.randomUUID() as CalendarEventId;
  const base: CalendarPersistenceBaseEvent = {
    id: eventId,
    revision: 1 as CalendarRevision,
    title: checked.value.title,
    ...(checked.value.description !== undefined ? { description: checked.value.description } : {}),
    start: checked.times.start,
    ...(checked.times.end ? { end: checked.times.end } : {}),
    ...(checked.recurrence ? { recurrence: checked.recurrence } : {}),
    visibility: checked.value.visibility,
    importance: checked.value.importance,
    ...(checked.value.group !== undefined ? { group: checked.value.group } : {}),
    ...(checked.value.notificationPolicy
      ? { notification: checked.value.notificationPolicy as CalendarNotification }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  const children = { exceptions: [], exclusions: [], tags: checked.value.tags } as const;
  const result = context.persistence.transaction((tx) => {
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    const inserted = tx.insertBaseEvent(base);
    if (!inserted.ok) return inserted;
    const childrenResult = tx.replaceChildren(eventId, children);
    if (!childrenResult.ok) return childrenResult;
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    return tx.readEvent(eventId);
  });
  if (!result.ok) {
    if (isAborted(context.signal)) return aborted();
    return storeError(result.error);
  }
  return { ok: true, value: project(result.value, checked.scope) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function invalidMutationScope(message: string): FailureResult {
  return failure("invalid_mutation_scope", message);
}
function parseMutation(value: unknown): { ok: true; value: MutationCommand } | FailureResult {
  if (!isRecord(value))
    return failure("malformed", "calendar mutation command is invalid; provide an update or delete command and retry.");
  const operation = value.operation;
  if (operation !== "update" && operation !== "delete") {
    return failure(
      "malformed",
      "calendar mutation command must be an update or delete command; correct operation and retry.",
    );
  }
  if (value.applyTo === undefined)
    return invalidMutationScope("applyTo is required; choose entire_series, this_occurrence, or this_and_following.");
  if (
    value.applyTo !== "entire_series" &&
    value.applyTo !== "this_occurrence" &&
    value.applyTo !== "this_and_following"
  ) {
    return invalidMutationScope(
      "applyTo is not supported; choose entire_series, this_occurrence, or this_and_following.",
    );
  }
  if (value.scope === "all") return scopeError("all");
  if (value.applyTo === "entire_series" && value.originalStart !== undefined) {
    return invalidMutationScope("originalStart is only valid for an occurrence-scoped mutation.");
  }
  if (value.applyTo !== "entire_series" && value.originalStart === undefined) {
    return invalidMutationScope("originalStart is required for an occurrence-scoped mutation.");
  }
  const parsed = calendarMutationCommandSchema.safeParse(value);
  if (!parsed.success)
    return failure("malformed", "calendar mutation fields are invalid; correct the command and retry.");
  return { ok: true, value: parsed.data as MutationCommand };
}

function compareTime(a: CalendarTime, b: CalendarTime): number {
  if (a.kind === "all-day" && b.kind === "all-day")
    return Date.parse(`${a.date}T00:00:00Z`) - Date.parse(`${b.date}T00:00:00Z`);
  if (a.kind === "timed" && b.kind === "timed") return Date.parse(a.instant) - Date.parse(b.instant);
  return Number.NaN;
}
function validateEffectiveTiming(start: CalendarTime, end: CalendarTime | undefined): CalendarMutationResult<void> {
  if (!end) return { ok: true, value: undefined };
  if (start.kind !== end.kind)
    return failure("invalid_range", "start and end must use the same time kind; correct the event timing and retry.");
  if (compareTime(end, start) < 0)
    return failure("invalid_range", "end must not precede start; correct the event timing and retry.");
  return { ok: true, value: undefined };
}
function childKeys(event: CalendarPersistenceEvent): CalendarMutationResult<Set<string>> {
  const keys = new Set<string>();
  for (const exception of event.exceptions) {
    const key = canonicalOriginalKey(exception.occurrence);
    if (keys.has(key))
      return failure(
        "recurrence_conflict",
        "retained exception state is ambiguous under the requested recurrence; no changes were made.",
      );
    keys.add(key);
  }
  for (const exclusion of event.exclusions) {
    const key = canonicalOriginalKey(exclusion);
    if (keys.has(key))
      return failure("recurrence_conflict", "retained exception and exclusion state overlap; no changes were made.");
    keys.add(key);
  }
  return { ok: true, value: keys };
}
function validateChildrenAgainstRecurrence(
  event: CalendarPersistenceEvent,
  start: CalendarTime,
  recurrence: Recurrence | undefined,
  config: CalendarConfig,
): CalendarMutationResult<void> {
  const keys = childKeys(event);
  if (!keys.ok) return keys;
  if (!keys.value.size) return { ok: true, value: undefined };
  if (!recurrence)
    return failure(
      "recurrence_conflict",
      "the requested recurrence would orphan retained exception state; no changes were made.",
    );
  const slots = enumerateGeneratedSlots({ start, recurrence }, recurrenceLimits(config));
  if (!slots.ok) return recurrenceError(slots.error);
  const generated = new Set(slots.value.map((slot) => canonicalOriginalKey(slot.originalStart)));
  for (const key of keys.value) {
    if (!generated.has(key))
      return failure(
        "recurrence_conflict",
        "the requested recurrence would orphan retained exception state; no changes were made.",
      );
  }
  return { ok: true, value: undefined };
}

function occurrenceTimeConfig(event: CalendarPersistenceEvent, config: CalendarConfig): CalendarConfig {
  if (event.start.kind !== "timed") return config;
  const zone = event.start.timeZoneId === DEFAULT_EVENT_TIME_ZONE ? config.defaultEventTimeZoneId : event.start.timeZoneId;
  return { ...config, defaultEventTimeZoneId: zone };
}

function shiftedOccurrenceEnd(
  end: CalendarTime | undefined,
  original: CalendarTime,
  start: CalendarTime,
): CalendarTime | undefined {
  if (!end || end.kind !== original.kind || start.kind !== original.kind) return undefined;
  if (start.kind === "timed" && original.kind === "timed" && end.kind === "timed") {
    const duration = Date.parse(end.instant) - Date.parse(original.instant);
    return { ...start, instant: new Date(Date.parse(start.instant) + duration).toISOString() as UtcInstant };
  }
  if (start.kind === "all-day" && original.kind === "all-day" && end.kind === "all-day") {
    const duration = Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${original.date}T00:00:00Z`);
    return { kind: "all-day", date: new Date(Date.parse(`${start.date}T00:00:00Z`) + duration).toISOString().slice(0, 10) as never };
  }
  return undefined;
}

function tagsForOverride(value: ExceptionOverride["tags"]): string[] | null | undefined {
  if (value === undefined || value === null) return value;
  return Array.isArray(value) ? [...value] : [...value];
}

function occurrenceNotFound(): FailureResult {
  return failure("occurrence_not_found", "the requested calendar occurrence was not found.");
}

function occurrenceMembershipError(error: { code: string }): FailureResult {
  if (error.code === "recurrence-limit" || error.code === "unbounded-rrule" || error.code === "missing-timezone" || error.code === "invalid-timezone") return recurrenceError(error);
  if (error.code === "invalid-rrule") return failure("malformed", "recurrence is invalid; provide one bounded supported recurrence and retry.");
  return occurrenceNotFound();
}

function updateOccurrence(
  command: Extract<MutationCommand, { operation: "update"; applyTo: "this_occurrence" }>,
  context: CalendarMutationContext,
): CalendarMutationResult<CalendarMutationValue> {
  let domainFailure: CalendarError | undefined;
  const result = context.persistence.transaction((tx) => {
    const current = tx.readEvent(command.eventId as CalendarEventId);
    if (!current.ok) {
      if (current.error === "not-found") domainFailure = occurrenceNotFound().error;
      return current;
    }
    const event = current.value;
    if (command.expectedRevision !== undefined && Number(event.revision) !== Number(command.expectedRevision)) return { ok: false, error: "conflict" as const };
    const originalParsed = normalizeCalendarTime(command.originalStart, context.config);
    if (!originalParsed.ok) {
      domainFailure = originalParsed.error;
      return { ok: false, error: "invalid" as const };
    }
    const original = originalParsed.value;
    if (!event.recurrence) {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }
    const membership = verifyGeneratedSlot(event, original, recurrenceLimits(context.config));
    if (!membership.ok) {
      domainFailure = occurrenceMembershipError(membership.error).error;
      return { ok: false, error: "invalid" as const };
    }
    const key = canonicalOriginalKey(original);
    if (event.exclusions.some((value) => canonicalOriginalKey(value) === key)) {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }
    const existing = event.exceptions.find((value) => canonicalOriginalKey(value.occurrence) === key);
    if (existing?.cancelled) {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }
    const currentVisibility = existing?.visibility ?? event.visibility;
    if (context.persistence.role !== undefined && !isAdult(context.persistence.role) && currentVisibility === "adults") {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }

    const changes = command.changes;
    const timeConfig = occurrenceTimeConfig(event, context.config);
    let nextStart = existing?.start ?? undefined;
    if (changes.start !== undefined) {
      const normalized = normalizeCalendarTime(changes.start, timeConfig);
      if (!normalized.ok) {
        domainFailure = normalized.error;
        return { ok: false, error: "invalid" as const };
      }
      nextStart = normalized.value;
    }
    let nextEnd: CalendarTime | null | undefined = existing?.end;
    if ("end" in changes) {
      if (changes.end === null) nextEnd = null;
      else {
        const normalized = normalizeCalendarTime(changes.end, timeConfig, { boundary: "end" });
        if (!normalized.ok) {
          domainFailure = normalized.error;
          return { ok: false, error: "invalid" as const };
        }
        nextEnd = normalized.value;
      }
    }
    const effectiveStart = nextStart ?? original;
    const effectiveEnd = nextEnd === null
      ? undefined
      : nextEnd ?? shiftedOccurrenceEnd(event.end, event.start, effectiveStart);
    const timing = validateEffectiveTiming(effectiveStart, effectiveEnd);
    if (!timing.ok) {
      domainFailure = timing.error;
      return { ok: false, error: "invalid" as const };
    }
    const eventZone = event.start.kind === "timed" && event.start.timeZoneId === DEFAULT_EVENT_TIME_ZONE
      ? context.config.defaultEventTimeZoneId
      : event.start.kind === "timed" ? event.start.timeZoneId : undefined;
    if (
      event.start.kind !== effectiveStart.kind ||
      (eventZone !== undefined && effectiveStart.kind === "timed" && effectiveStart.timeZoneId !== eventZone) ||
      (eventZone !== undefined && effectiveEnd?.kind === "timed" && effectiveEnd.timeZoneId !== eventZone)
    ) {
      domainFailure = failure("invalid_time", "the occurrence timing must remain anchored to the event timezone; correct start/end and retry.").error;
      return { ok: false, error: "invalid" as const };
    }

    const nextTitle = changes.title ?? existing?.title ?? event.title;
    const nextDescription = "description" in changes
      ? changes.description === null ? undefined : changes.description
      : existing?.description === null ? undefined : existing?.description ?? event.description;
    const nextGroup = "group" in changes
      ? changes.group === null ? undefined : changes.group
      : existing?.group === null ? undefined : existing?.group ?? event.group;
    const existingTags = existing?.tags === null ? [] : tagsForOverride(existing?.tags) ?? [...event.tags];
    const nextTags = changes.tags !== undefined ? changes.tags : existingTags;
    const metadata = validateCalendarInputLimits(
      {
        title: nextTitle,
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(nextGroup !== undefined ? { group: nextGroup } : {}),
        tags: nextTags,
      },
      context.config,
    );
    if (!metadata.ok) {
      domainFailure = metadata.error;
      return { ok: false, error: "invalid" as const };
    }
    if (context.persistence.role !== undefined && !isAdult(context.persistence.role) && (changes.visibility ?? existing?.visibility ?? event.visibility) === "adults") {
      // A child may edit a visible private occurrence, but must not receive or
      // infer a hidden effective target through the mutation result.
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }

    const merged: ExceptionOverride = { occurrence: original };
    const title = changes.title ?? existing?.title;
    if (title !== undefined) merged.title = title;
    if (changes.description !== undefined) merged.description = changes.description;
    else if (existing?.description !== undefined) merged.description = existing.description;
    if (nextStart !== undefined) merged.start = nextStart;
    if (changes.end === null) merged.end = null;
    else if (changes.end !== undefined && nextEnd !== undefined) merged.end = nextEnd;
    else if (existing?.end !== undefined) merged.end = existing.end;
    if (changes.visibility !== undefined) merged.visibility = changes.visibility;
    else if (existing?.visibility !== undefined) merged.visibility = existing.visibility;
    if (changes.importance !== undefined) merged.importance = changes.importance;
    else if (existing?.importance !== undefined) merged.importance = existing.importance;
    if (changes.group !== undefined) merged.group = changes.group;
    else if (existing?.group !== undefined) merged.group = existing.group;
    if (changes.tags !== undefined) merged.tags = changes.tags;
    else if (existing?.tags !== undefined) merged.tags = tagsForOverride(existing.tags) ?? null;

    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    const revision = tx.compareAndSwapRevision(event.id, event.revision);
    if (!revision.ok) return revision;
    const exceptions = event.exceptions.filter((value) => canonicalOriginalKey(value.occurrence) !== key);
    exceptions.push(merged);
    const replaced = tx.replaceExceptions(event.id, exceptions);
    if (!replaced.ok) return replaced;
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    return {
      ok: true,
      value: { operation: "update", appliedTo: "this_occurrence", eventId: event.id, resultingRevision: revision.value } as unknown as CalendarMutationValue,
    };
  });
  if (!result.ok) {
    if (isAborted(context.signal)) return aborted();
    if (domainFailure) return { ok: false, error: domainFailure };
    return storeError(result.error);
  }
  return result;
}

function deleteOccurrence(
  command: Extract<MutationCommand, { operation: "delete"; applyTo: "this_occurrence" }>,
  context: CalendarMutationContext,
): CalendarMutationResult<CalendarMutationValue> {
  let domainFailure: CalendarError | undefined;
  const result = context.persistence.transaction((tx) => {
    const current = tx.readEvent(command.eventId as CalendarEventId);
    if (!current.ok) {
      if (current.error === "not-found") domainFailure = occurrenceNotFound().error;
      return current;
    }
    const event = current.value;
    if (command.expectedRevision !== undefined && Number(event.revision) !== Number(command.expectedRevision)) return { ok: false, error: "conflict" as const };
    const originalParsed = normalizeCalendarTime(command.originalStart, context.config);
    if (!originalParsed.ok) {
      domainFailure = originalParsed.error;
      return { ok: false, error: "invalid" as const };
    }
    const original = originalParsed.value;
    if (!event.recurrence) {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }
    const membership = verifyGeneratedSlot(event, original, recurrenceLimits(context.config));
    if (!membership.ok) {
      domainFailure = occurrenceMembershipError(membership.error).error;
      return { ok: false, error: "invalid" as const };
    }
    const key = canonicalOriginalKey(original);
    const existing = event.exceptions.find((value) => canonicalOriginalKey(value.occurrence) === key);
    if (existing?.cancelled || (context.persistence.role !== undefined && !isAdult(context.persistence.role) && existing?.visibility === "adults")) {
      domainFailure = occurrenceNotFound().error;
      return { ok: false, error: "invalid" as const };
    }
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    const revision = tx.compareAndSwapRevision(event.id, event.revision);
    if (!revision.ok) return revision;
    const exceptions = event.exceptions.filter((value) => canonicalOriginalKey(value.occurrence) !== key);
    exceptions.push({ occurrence: original, cancelled: true });
    const exclusions = event.exclusions.filter((value) => canonicalOriginalKey(value) !== key);
    // Remove an EXDATE before inserting the cancelled exception: each child
    // replacement validates against the other child table inside the same
    // transaction, so the intermediate state must not contain both forms.
    const replacedExclusions = tx.replaceExclusions(event.id, exclusions);
    if (!replacedExclusions.ok) return replacedExclusions;
    const replacedExceptions = tx.replaceExceptions(event.id, exceptions);
    if (!replacedExceptions.ok) return replacedExceptions;
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    return { ok: true, value: { operation: "delete", appliedTo: "this_occurrence", eventId: event.id } as CalendarMutationValue };
  });
  if (!result.ok) {
    if (isAborted(context.signal)) return aborted();
    if (domainFailure) return { ok: false, error: domainFailure };
    return storeError(result.error);
  }
  return result;
}

function updateWholeSeries(
  command: Extract<MutationCommand, { operation: "update"; applyTo: "entire_series" }>,
  context: CalendarMutationContext,
  _scope: CalendarScope,
): CalendarMutationResult<CalendarMutationValue> {
  let domainFailure: CalendarError | undefined;
  let recurrenceConflict = false;
  const result = context.persistence.transaction((tx) => {
    const current = tx.readEvent(command.eventId as CalendarEventId);
    if (!current.ok) return current;
    if (command.expectedRevision !== undefined && Number(current.value.revision) !== Number(command.expectedRevision))
      return { ok: false, error: "conflict" as const };
    const event = current.value;
    const changes = command.changes;
    const recurringStart =
      changes.recurrence === undefined ? event.recurrence !== undefined : changes.recurrence !== null;
    let nextStart = event.start;
    if (changes.start !== undefined) {
      const normalizedStart = normalizeCalendarTime(changes.start, context.config, { recurring: recurringStart });
      if (!normalizedStart.ok) {
        domainFailure = normalizedStart.error;
        return { ok: false, error: "invalid" as const };
      }
      nextStart = normalizedStart.value;
    }
    let nextEnd: CalendarTime | undefined = event.end;
    if ("end" in changes) {
      if (changes.end === null) nextEnd = undefined;
      else {
        const normalized = normalizeCalendarTime(changes.end, context.config, { boundary: "end" });
        if (!normalized.ok) {
          domainFailure = normalized.error;
          return { ok: false, error: "invalid" as const };
        }
        nextEnd = normalized.value;
      }
    }
    const timing = validateEffectiveTiming(nextStart, nextEnd);
    if (!timing.ok) {
      domainFailure = timing.error;
      return { ok: false, error: "invalid" as const };
    }
    let nextRecurrence = event.recurrence;
    if ("recurrence" in changes) {
      if (changes.recurrence === null) nextRecurrence = undefined;
      else {
        const replacement = changes.recurrence;
        if (replacement !== undefined) {
          const canonical = canonicalizeRecurrence(
            replacement,
            nextStart.kind === "timed" ? nextStart.timeZoneId : context.config.defaultEventTimeZoneId,
          );
          if (!canonical.ok) {
            domainFailure = recurrenceError(canonical.error).error;
            return { ok: false, error: "invalid" as const };
          }
          nextRecurrence = canonical.value;
          const slots = enumerateGeneratedSlots(
            { start: nextStart, recurrence: nextRecurrence },
            recurrenceLimits(context.config),
          );
          if (!slots.ok) {
            domainFailure = recurrenceError(slots.error).error;
            return { ok: false, error: "invalid" as const };
          }
          if (slots.value.length === 0) {
            domainFailure = {
              code: "malformed",
              message: "recurrence does not generate an event occurrence; adjust the recurrence and retry.",
            };
            return { ok: false, error: "invalid" as const };
          }
        }
      }
    }
    if (nextRecurrence !== undefined && changes.start !== undefined && !("recurrence" in changes)) {
      const slots = enumerateGeneratedSlots(
        { start: nextStart, recurrence: nextRecurrence },
        recurrenceLimits(context.config),
      );
      if (!slots.ok) {
        domainFailure = recurrenceError(slots.error).error;
        return { ok: false, error: "invalid" as const };
      }
      if (slots.value.length === 0) {
        domainFailure = {
          code: "malformed",
          message: "recurrence does not generate an event occurrence; adjust the recurrence and retry.",
        };
        return { ok: false, error: "invalid" as const };
      }
    }
    const metadata = validateCalendarInputLimits(
      {
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.group !== undefined ? { group: changes.group } : {}),
        ...(changes.tags !== undefined ? { tags: changes.tags } : {}),
      },
      context.config,
    );
    if (!metadata.ok) {
      domainFailure = metadata.error;
      return { ok: false, error: "invalid" as const };
    }
    if ("recurrence" in changes || changes.start !== undefined) {
      const children = validateChildrenAgainstRecurrence(event, nextStart, nextRecurrence, context.config);
      if (!children.ok) {
        domainFailure = children.error;
        recurrenceConflict = children.error.code === "recurrence_conflict";
        return { ok: false, error: "invalid" as const };
      }
    }
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    const {
      exceptions: _exceptions,
      exclusions: _exclusions,
      tags: _tags,
      revision: _revision,
      description: _description,
      end: _end,
      recurrence: _recurrence,
      group: _group,
      ...base
    } = event;
    const next: CalendarPersistenceBaseEvent = {
      ...base,
      title: changes.title ?? event.title,
      ...(changes.description === null
        ? {}
        : changes.description !== undefined
          ? { description: changes.description }
          : event.description !== undefined
            ? { description: event.description }
            : {}),
      start: nextStart,
      ...(nextEnd ? { end: nextEnd } : {}),
      ...(nextRecurrence !== undefined ? { recurrence: nextRecurrence } : {}),
      visibility: changes.visibility ?? event.visibility,
      importance: changes.importance ?? event.importance,
      ...(changes.group === null
        ? {}
        : changes.group !== undefined
          ? { group: changes.group }
          : event.group !== undefined
            ? { group: event.group }
            : {}),
      revision: event.revision,
      updatedAt: new Date().toISOString() as UtcInstant,
    };
    const revision = tx.compareAndSwapRevision(event.id, event.revision);
    if (!revision.ok) return revision;
    const replaced = tx.replaceBaseEvent(next);
    if (!replaced.ok) return replaced;
    if (changes.tags !== undefined) {
      const tags = tx.replaceTags(event.id, changes.tags);
      if (!tags.ok) return tags;
    }
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    return {
      ok: true,
      value: {
        operation: "update",
        appliedTo: "entire_series",
        eventId: event.id,
        resultingRevision: revision.value,
      } as unknown as CalendarMutationValue,
    };
  });
  if (!result.ok) {
    if (isAborted(context.signal)) return aborted();
    if (domainFailure) return { ok: false, error: domainFailure };
    if (recurrenceConflict)
      return failure(
        "recurrence_conflict",
        "the requested recurrence would orphan retained exception state; no changes were made.",
      );
    return storeError(result.error);
  }
  return result;
}

function deleteWholeSeries(
  command: Extract<MutationCommand, { operation: "delete"; applyTo: "entire_series" }>,
  context: CalendarMutationContext,
): CalendarMutationResult<CalendarMutationValue> {
  if (isAborted(context.signal)) return aborted();
  const result = context.persistence.transaction((tx) => {
    const current = tx.readEvent(command.eventId as CalendarEventId);
    if (!current.ok) return current;
    if (command.expectedRevision !== undefined && Number(current.value.revision) !== Number(command.expectedRevision))
      return { ok: false, error: "conflict" as const };
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    const deleted = tx.deleteSegment(current.value.id);
    if (!deleted.ok) return deleted;
    if (isAborted(context.signal)) return { ok: false, error: "conflict" as const };
    return { ok: true, value: { operation: "delete", appliedTo: "entire_series", eventId: current.value.id } as const };
  });
  if (!result.ok) {
    if (isAborted(context.signal)) return aborted();
    return storeError(result.error);
  }
  return result;
}

/** Dispatch update/delete commands. Occurrence branches are intentionally left to later tasks. */
export function mutateCalendarEvent(
  command: CalendarMutationCommand,
  context: CalendarMutationContext,
): CalendarMutationResult<CalendarMutationValue>;
export function mutateCalendarEvent(
  command: CalendarMutationCommand,
  persistence: CalendarPersistence,
  config: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationResult<CalendarMutationValue>;
export function mutateCalendarEvent(
  command: CalendarMutationCommand,
  storeOrContext: MutationArgs,
  config?: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationResult<CalendarMutationValue> {
  const context = contextOf(storeOrContext, config, signal);
  if (isAborted(context.signal)) return aborted();
  const parsed = parseMutation(command);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const scopeResult = validateScope(context, "scope" in value ? (value.scope ?? "private") : "private");
  if (!scopeResult.ok) return scopeResult;
  const scope = scopeResult.value;
  if (value.applyTo === "this_occurrence") {
    if (value.operation === "update") return updateOccurrence(value, context);
    return deleteOccurrence(value, context);
  }
  if (value.applyTo === "this_and_following") {
    const target = context.persistence.read(value.eventId as CalendarEventId);
    if (!target.ok) return storeError(target.error);
    if (!target.value.recurrence)
      return failure("occurrence_not_found", "the selected event has no occurrence at the requested scope.");
    return invalidMutationScope(
      "occurrence-scoped mutations are not available in this mutation branch; use entire_series.",
    );
  }
  if (value.operation === "update") return updateWholeSeries(value, context, scope);
  return deleteWholeSeries(value, context);
}

/** Convenience factory for adapters that already hold a capability. */
export function openCalendarMutationContext(
  capability: Capability,
  config: CalendarConfig,
  signal?: AbortSignal,
): CalendarMutationContext {
  return { persistence: openCalendarPersistence(capability, config), config, ...(signal ? { signal } : {}) };
}

// Kept exported for focused domain tests and later mutation branches.
export { calendarTimeKey };
