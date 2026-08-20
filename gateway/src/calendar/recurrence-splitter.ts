import {
  canonicalOriginalKey,
  canonicalizeRecurrence,
  enumerateGeneratedSlots,
  verifyGeneratedSlot,
  isGeneratedSlot,
  type RecurrenceExpansionLimits,
  DEFAULT_RECURRENCE_LIMITS,
} from "./expand-recurrence.js";
import type {
  CalendarRecurrenceInput,
  CalendarTime,
  Recurrence,
  RRule,
  StoredCalendarEvent,
  UtcInstant,
  ExceptionOverride,
} from "./types.js";
import { DEFAULT_EVENT_TIME_ZONE, WEEKDAYS, parseRRule } from "./types.js";

export interface RecurrenceConflictError {
  readonly kind: "recurrence-conflict";
  readonly code: "recurrence_conflict";
  readonly message: string;
}
export interface RecurrenceSplitError {
  readonly kind: "recurrence-error";
  readonly code:
    | "invalid-rrule"
    | "unbounded-rrule"
    | "invalid-window"
    | "invalid-override"
    | "recurrence-limit"
    | "missing-timezone"
    | "invalid-timezone"
    | "recurrence_conflict";
  readonly message: string;
}
export type RecurrenceSplitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RecurrenceSplitError | RecurrenceConflictError };

export interface PartitionedChildState {
  readonly prefix: {
    readonly exceptions: ExceptionOverride[];
    readonly exdates: CalendarTime[];
  };
  readonly successor: {
    readonly exceptions: ExceptionOverride[];
    readonly exdates: CalendarTime[];
  };
}
export interface RecurrenceSegment {
  readonly recurrence: Recurrence;
  readonly start: CalendarTime;
}
export interface RecurrenceSplitProposal {
  readonly splitAt: CalendarTime;
  readonly ordinal: number;
  /** Absent when splitting at the first generated slot. */
  readonly prefix?: RecurrenceSegment;
  readonly successor: RecurrenceSegment;
  readonly state: PartitionedChildState;
}

function failure(code: RecurrenceSplitError["code"], message: string): RecurrenceSplitResult<never> {
  return { ok: false, error: { kind: "recurrence-error", code, message } };
}
function conflict(message: string): RecurrenceSplitResult<never> {
  return { ok: false, error: { kind: "recurrence-conflict", code: "recurrence_conflict", message } };
}
function sameTime(a: CalendarTime, b: CalendarTime): boolean {
  return a.kind === b.kind && canonicalOriginalKey(a) === canonicalOriginalKey(b);
}
/** Compare generated slots in their persisted temporal domain. Timed slots are
 * absolute instants (already resolved in the event timezone); all-day slots are
 * local calendar dates and must not be compared through an offset-bearing instant. */
function compareGeneratedTime(a: CalendarTime, b: CalendarTime): number | undefined {
  if (a.kind !== b.kind) return undefined;
  const aValue = a.kind === "all-day" ? Date.parse(`${a.date}T00:00:00Z`) : Date.parse(a.instant);
  const bValue = b.kind === "all-day" ? Date.parse(`${b.date}T00:00:00Z`) : Date.parse(b.instant);
  return Number.isFinite(aValue) && Number.isFinite(bValue) ? aValue - bValue : undefined;
}
function recurrenceFromRule(rule: RRule, terminal?: CalendarTime): Recurrence {
  const fields = [`FREQ=${rule.freq}`];
  if (rule.interval !== undefined && rule.interval !== 1) fields.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay)
    fields.push(`BYDAY=${[...rule.byDay].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(",")}`);
  if (rule.count !== undefined) fields.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) fields.push(`UNTIL=${formatRfcUntil(rule.until, terminal)}`);
  const rrule = fields.join(";");
  const parsed = parseRRule(rrule);
  // The input rule came from parseRRule, so this is an internal invariant.
  if (!parsed.ok) throw new Error("unable to canonicalize recurrence rule");
  return { rrule, rule: parsed.value };
}
function boundedRule(rule: RRule, count: number | undefined, until: UtcInstant | undefined): RRule {
  const next: RRule = {
    freq: rule.freq,
    ...(rule.interval === undefined ? {} : { interval: rule.interval }),
    ...(rule.byDay === undefined ? {} : { byDay: rule.byDay }),
  };
  if (count !== undefined) next.count = count;
  if (until !== undefined) next.until = until;
  return next;
}
function formatRfcUntil(value: UtcInstant, terminal?: CalendarTime): string {
  if (terminal?.kind === "all-day") return `${terminal.date.replaceAll("-", "")}T235959Z`;
  const d = new Date(value);
  return `${d.getUTCFullYear().toString().padStart(4, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}
function terminalFor(previous: CalendarTime): UtcInstant {
  if (previous.kind === "timed") return previous.instant;
  // All-day recurrence terminals are local dates. Construct a valid UTC
  // instant explicitly instead of passing an RFC all-day token to Date.
  return `${previous.date}T23:59:59.000Z` as UtcInstant;
}
function normalizeSuccessorRecurrence(
  value: Recurrence | CalendarRecurrenceInput | undefined,
  timeZoneId?: string,
): RecurrenceSplitResult<Recurrence | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if ("rrule" in value) {
    const parsed = parseRRule(value.rrule);
    if (!parsed.ok || (parsed.value.count === undefined && parsed.value.until === undefined))
      return failure("invalid-rrule", "successor recurrence must be bounded");
    return { ok: true, value: recurrenceFromRule(parsed.value) };
  }
  const canonical = canonicalizeRecurrence(value, timeZoneId);
  return canonical.ok ? canonical : failure(canonical.error.code, canonical.error.message);
}
function validateChildOwnership(event: StoredCalendarEvent): RecurrenceSplitResult<void> {
  const exceptionKeys = new Set<string>();
  for (const exception of event.exceptions ?? []) {
    const key = canonicalOriginalKey(exception.occurrence);
    if (exceptionKeys.has(key)) return conflict("duplicate exception ownership for an original slot");
    exceptionKeys.add(key);
  }
  const exdateKeys = new Set<string>();
  for (const exdate of event.exdates ?? []) {
    const key = canonicalOriginalKey(exdate);
    if (exdateKeys.has(key) || exceptionKeys.has(key))
      return conflict("duplicate cancellation/EXDATE ownership for an original slot");
    exdateKeys.add(key);
  }
  return { ok: true, value: undefined };
}
function partition<T extends { occurrence: CalendarTime }>(
  values: readonly T[],
  splitAt: CalendarTime,
): { past: T[]; future: T[] } {
  const past: T[] = [];
  const future: T[] = [];
  const splitKey = canonicalOriginalKey(splitAt);
  for (const value of values) (canonicalOriginalKey(value.occurrence) < splitKey ? past : future).push(value);
  return { past, future };
}
function partitionExdates(
  values: readonly CalendarTime[],
  splitAt: CalendarTime,
): { past: CalendarTime[]; future: CalendarTime[] } {
  const past: CalendarTime[] = [];
  const future: CalendarTime[] = [];
  const splitKey = canonicalOriginalKey(splitAt);
  for (const value of values) (canonicalOriginalKey(value) < splitKey ? past : future).push(value);
  return { past, future };
}

/**
 * Compute a pure split proposal from generated slots. It intentionally does not
 * call expandRecurrence: hidden slots (EXDATE/cancelled) are part of the
 * arithmetic and effective list output is therefore the wrong source of truth.
 */
export function splitRecurrence(
  event: StoredCalendarEvent,
  originalStart: CalendarTime,
  proposedSuccessorRecurrence?: Recurrence | CalendarRecurrenceInput,
  limits: RecurrenceExpansionLimits = DEFAULT_RECURRENCE_LIMITS,
  successorStart: CalendarTime = originalStart,
): RecurrenceSplitResult<RecurrenceSplitProposal> {
  if (!event.recurrence) return failure("invalid-rrule", "cannot split a non-recurring event");
  if (event.start.kind !== originalStart.kind || event.start.kind !== successorStart.kind)
    return failure("invalid-window", "split key has a different time kind");
  const ownership = validateChildOwnership(event);
  if (!ownership.ok) return ownership;
  const membership = verifyGeneratedSlot(event, originalStart, limits);
  if (!membership.ok) return membership;
  const slots = enumerateGeneratedSlots(event, limits);
  if (!slots.ok) return slots;
  const selected = slots.value.find((slot) => sameTime(slot.originalStart, originalStart));
  if (!selected) return failure("invalid-window", "originalStart is not a generated recurrence slot");
  const parsed = parseRRule(event.recurrence.rrule);
  if (!parsed.ok) return failure("invalid-rrule", "malformed RRULE");
  const oldRule = parsed.value;
  const eventZone = event.start.kind === "timed" && event.start.timeZoneId !== DEFAULT_EVENT_TIME_ZONE
    ? event.start.timeZoneId
    : limits.timeZoneId;
  const normalized = normalizeSuccessorRecurrence(proposedSuccessorRecurrence, eventZone);
  if (!normalized.ok) return normalized;

  let successorRecurrence: Recurrence;
  let prefixRecurrence: Recurrence | undefined;
  if (normalized.value) {
    successorRecurrence = normalized.value;
  } else {
    const remaining = oldRule.count === undefined ? undefined : oldRule.count - selected.ordinal + 1;
    successorRecurrence = recurrenceFromRule(boundedRule(oldRule, remaining, oldRule.until));
  }

  // A re-anchored successor must actually begin at the requested new anchor.
  // Without re-anchoring, retain the historical changed-rule check against the
  // original slot. This keeps recurrence replacement independent of displayed
  // exception starts while making timing changes series-wide.
  const reanchored = !sameTime(successorStart, originalStart);
  const candidate = enumerateGeneratedSlots({ start: successorStart, recurrence: successorRecurrence }, limits);
  if (!candidate.ok) return candidate;
  if (reanchored) {
    if (!candidate.value[0] || !sameTime(candidate.value[0].originalStart, successorStart))
      return conflict("successor recurrence does not generate the re-anchored successor slot");
  } else if (normalized.value && !candidate.value.some((slot) => sameTime(slot.originalStart, originalStart))) {
    return conflict("successor recurrence does not generate the selected slot");
  }

  // The old segment retains every generated slot before the split point. A
  // successor that starts at or before its terminal slot would make two
  // segment identities claim one generated occurrence (or hide a prefix slot).
  // Check this in the same all-day/timed domain as the generated values before
  // partitioning any child state.
  const prefixLast = selected.ordinal > 1 ? slots.value[selected.ordinal - 2]?.originalStart : undefined;
  if (prefixLast) {
    const successorFirst = candidate.value[0]?.originalStart;
    const separation = successorFirst ? compareGeneratedTime(prefixLast, successorFirst) : undefined;
    if (separation === undefined || separation >= 0)
      return conflict("successor starts at or before the retained prefix terminal slot");
  }
  if (prefixLast) {
    prefixRecurrence =
      oldRule.count !== undefined
        ? recurrenceFromRule(boundedRule(oldRule, selected.ordinal - 1, undefined))
        : recurrenceFromRule(boundedRule(oldRule, undefined, terminalFor(prefixLast)), prefixLast);
  }

  // Partition by the old canonical key. When the anchor moved, remap each
  // retained future child by generated ordinal, never by its displayed time.
  // A missing ordinal means the requested schedule would silently orphan
  // persisted state, so reject the whole split.
  const splitKey = canonicalOriginalKey(originalStart);
  const futureExceptions = (event.exceptions ?? []).filter(
    (entry) => canonicalOriginalKey(entry.occurrence) >= splitKey,
  );
  const futureExdates = (event.exdates ?? []).filter((entry) => canonicalOriginalKey(entry) >= splitKey);
  const oldSlots = slots.value;
  const remap = <T extends { occurrence: CalendarTime }>(entry: T): T | undefined => {
    if (!reanchored) return entry;
    const oldSlot = oldSlots.find((slot) => sameTime(slot.originalStart, entry.occurrence));
    if (!oldSlot) return undefined;
    const mapped = candidate.value[oldSlot.ordinal - selected.ordinal];
    if (!mapped) return undefined;
    return { ...entry, occurrence: mapped.originalStart };
  };
  const remappedExceptions = futureExceptions.map(remap);
  const remappedExdates = futureExdates.map((entry) => {
    const oldSlot = oldSlots.find((slot) => sameTime(slot.originalStart, entry));
    if (!oldSlot) return undefined;
    const mapped = candidate.value[oldSlot.ordinal - selected.ordinal];
    return mapped?.originalStart;
  });
  if (remappedExceptions.some((entry) => !entry) || remappedExdates.some((entry) => !entry))
    return conflict("successor recurrence would orphan a future exception or exclusion");
  if (normalized.value && !reanchored) {
    const keys = new Set(candidate.value.map((slot) => canonicalOriginalKey(slot.originalStart)));
    if (
      [...futureExceptions.map((entry) => entry.occurrence), ...futureExdates].some(
        (key) => !keys.has(canonicalOriginalKey(key)),
      )
    ) {
      return conflict("successor recurrence would orphan a future exception or exclusion");
    }
  }

  const exceptions = partition(event.exceptions ?? [], originalStart);
  const exdates = partitionExdates(event.exdates ?? [], originalStart);
  return {
    ok: true,
    value: {
      splitAt: originalStart,
      ordinal: selected.ordinal,
      ...(prefixRecurrence ? { prefix: { recurrence: prefixRecurrence, start: event.start } } : {}),
      successor: { recurrence: successorRecurrence, start: successorStart },
      state: {
        prefix: { exceptions: exceptions.past, exdates: exdates.past },
        successor: {
          exceptions: !reanchored ? exceptions.future : remappedExceptions.filter((entry): entry is ExceptionOverride => entry !== undefined),
          exdates: !reanchored ? exdates.future : remappedExdates.filter((entry): entry is CalendarTime => entry !== undefined),
        },
      },
    },
  };
}

export const partitionRecurrence = splitRecurrence;
export const splitRecurrenceAt = splitRecurrence;
export { canonicalizeRecurrence, enumerateGeneratedSlots, verifyGeneratedSlot, isGeneratedSlot };
