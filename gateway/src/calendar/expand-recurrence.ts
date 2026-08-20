import { resolveTimeZone } from "../context/message-time.js";
import type {
  StoredCalendarEvent,
  CalendarTime,
  LocalDate,
  Occurrence,
  RRule,
  UtcInstant,
  Weekday,
  CalendarRecurrenceInput,
  Recurrence,
} from "./types.js";
import { DEFAULT_EVENT_TIME_ZONE, parseRRule, WEEKDAYS, calendarRecurrenceInputSchema } from "./types.js";

export type RecurrenceExpansionErrorCode = "invalid-rrule" | "unbounded-rrule" | "invalid-window" | "invalid-override" | "recurrence-limit";
export interface CanonicalRecurrenceError {
  readonly kind: "recurrence-error";
  readonly code: "invalid-rrule" | "unbounded-rrule";
  readonly message: string;
}
export type CanonicalRecurrenceResult =
  | { ok: true; value: Recurrence }
  | { ok: false; error: CanonicalRecurrenceError };
export interface RecurrenceExpansionLimits {
  maxOccurrences: number;
  maxDays: number;
}
export const DEFAULT_RECURRENCE_LIMITS: RecurrenceExpansionLimits = { maxOccurrences: 1000, maxDays: 366 };
export interface RecurrenceExpansionError {
  readonly kind: "recurrence-error";
  readonly code: RecurrenceExpansionErrorCode;
  readonly message: string;
}
export type ExpandRecurrenceResult =
  | { ok: true; value: Occurrence[] }
  | { ok: false; error: RecurrenceExpansionError };

const MS_DAY = 86_400_000;
const weekdayIndex: Record<Weekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function parts(ms: number, zone: string): Parts {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: Number(p.year ?? 0), month: Number(p.month ?? 0), day: Number(p.day ?? 0), hour: Number(p.hour ?? 0), minute: Number(p.minute ?? 0), second: Number(p.second ?? 0) };
}
function dateKey(p: Parts): string { return `${p.year.toString().padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; }
function localStamp(p: Parts): string { return `${dateKey(p)}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`; }
function instantForLocal(p: Parts, zone: string): number | undefined {
  // Try the offsets around the naive UTC value. Exact matches are valid; choosing
  // the smaller instant makes repeated times deterministic (the first instance).
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const candidates = new Set<number>();
  for (let d = -2; d <= 2; d++) {
    const probe = naive + d * MS_DAY;
    const q = parts(probe, zone);
    const offset = probe - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    const candidate = naive + offset;
    const got = parts(candidate, zone);
    if (localStamp(got) === localStamp(p)) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : undefined; // nonexistent spring-forward time is skipped
}
function addMonths(date: Date, months: number): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)); }
function dayDate(ms: number): Date { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
export function canonicalOriginalKey(t: CalendarTime): string {
  return t.kind === "all-day" ? t.date : new Date(t.instant).toISOString();
}
function sameTime(a: CalendarTime, b: CalendarTime): boolean { return a.kind === b.kind && canonicalOriginalKey(a) === canonicalOriginalKey(b); }
function failure(code: RecurrenceExpansionErrorCode, message: string): ExpandRecurrenceResult { return { ok: false, error: { kind: "recurrence-error", code, message } }; }

/** Convert the model-facing recurrence into the only RRULE subset we store. */
export function canonicalizeRecurrence(input: CalendarRecurrenceInput): CanonicalRecurrenceResult {
  const parsed = calendarRecurrenceInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { kind: "recurrence-error", code: "invalid-rrule", message: "invalid structured recurrence" } };
  const value = parsed.data;
  const freq = value.frequency.toUpperCase();
  const fields = [`FREQ=${freq}`];
  if (value.interval !== undefined && value.interval !== 1) fields.push(`INTERVAL=${value.interval}`);
  if (value.weekdays) {
    const byDay = value.weekdays.map((day) => ({ monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" } as const)[day]);
    const ordered = [...new Set(byDay)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    fields.push(`BYDAY=${ordered.join(",")}`);
  }
  if (value.count !== undefined) fields.push(`COUNT=${value.count}`);
  if (value.until !== undefined) {
    const until = canonicalUntil(value.until);
    if (!until) return { ok: false, error: { kind: "recurrence-error", code: "invalid-rrule", message: "invalid recurrence until" } };
    fields.push(`UNTIL=${until}`);
  }
  const rrule = fields.join(";");
  const rule = parseRRule(rrule);
  if (!rule.ok) return { ok: false, error: { kind: "recurrence-error", code: "invalid-rrule", message: "invalid structured recurrence" } };
  return { ok: true, value: { rrule, rule: rule.value } };
}
export const canonicalizeRecurrenceInput = canonicalizeRecurrence;

function canonicalUntil(value: string): string | undefined {
  let instant: number;
  if (/^\d{4}$/.test(value)) instant = Date.parse(`${value}-12-31T23:59:59.000Z`);
  else if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    instant = Date.UTC(year!, month!, 0, 23, 59, 59);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) instant = Date.parse(`${value}T23:59:59.000Z`);
  else instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  const d = new Date(instant);
  return `${d.getUTCFullYear().toString().padStart(4, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}

function sameKindTime(a: CalendarTime, b: CalendarTime): boolean { return a.kind === b.kind; }
function occurrence(event: StoredCalendarEvent, original: CalendarTime, start: CalendarTime, end: CalendarTime | undefined): Occurrence {
  const { end: _ignoredEnd, description: _ignoredDescription, group: _ignoredGroup, ...withoutOptionalClears } = event;
  const id = `${event.id}:${canonicalOriginalKey(original)}`;
  return {
    ...withoutOptionalClears,
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.group !== undefined ? { group: event.group } : {}),
    start,
    ...(end ? { end, occurrenceEnd: end } : {}),
    eventId: event.id,
    occurrenceId: id,
    baseEventId: event.id,
    occurrenceStart: original,
    originalStart: original,
  };
}
function applyException(event: StoredCalendarEvent, original: CalendarTime, baseEnd = event.end): Occurrence | undefined {
  const ex = event.exceptions?.find((x) => sameTime(x.occurrence, original));
  if (ex?.cancelled) return undefined;
  if (ex && (!sameKindTime(ex.occurrence, original) || (ex.start && !sameKindTime(ex.start, original)) || (ex.end && !sameKindTime(ex.end, original)) || (ex.start && ex.end && ex.start.kind !== ex.end.kind))) {
    throw new Error("invalid occurrence override time kind");
  }
  const start = ex?.start ?? original;
  const inheritedEnd = ex?.start && ex.end === undefined ? shiftedEnd(baseEnd, original, ex.start) : baseEnd;
  const end = ex?.end === null ? undefined : ex?.end ?? inheritedEnd;
  const result = occurrence(event, original, start, end);
  if (typeof ex?.title === "string") result.title = ex.title;
  if (ex?.description !== undefined) {
    if (ex.description === null) delete result.description;
    else result.description = ex.description;
  }
  if (ex?.visibility !== undefined && ex.visibility !== null) result.visibility = ex.visibility;
  if (ex?.importance !== undefined && ex.importance !== null) result.importance = ex.importance;
  if (ex?.group !== undefined) {
    if (ex.group === null) delete result.group;
    else result.group = ex.group;
  }
  if (ex?.tags !== undefined) result.tags = ex.tags === null ? new Set() : new Set(ex.tags);
  return result;
}

export function expandRecurrence(
  event: StoredCalendarEvent,
  windowStart: CalendarTime,
  windowEnd: CalendarTime,
  limits: RecurrenceExpansionLimits = DEFAULT_RECURRENCE_LIMITS,
): ExpandRecurrenceResult {
  if (!Number.isInteger(limits.maxOccurrences) || limits.maxOccurrences < 1 || !Number.isInteger(limits.maxDays) || limits.maxDays < 1) {
    return failure("recurrence-limit", "invalid recurrence expansion limits");
  }
  if (windowStart.kind !== windowEnd.kind || windowStart.kind !== event.start.kind) return failure("invalid-window", "window and event must use the same time kind");
  if (event.start.kind === "timed" && windowStart.kind === "timed" && windowStart.timeZoneId !== (windowEnd as { kind: "timed"; timeZoneId: string }).timeZoneId) return failure("invalid-window", "window timezone differs");
  const windowStartMs = comparableMillis(windowStart);
  const windowEndMs = comparableMillis(windowEnd);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowStartMs > windowEndMs) return failure("invalid-window", "window bounds are invalid");
  const recurring = event.recurrence;
  if (!recurring) {
    if (inWindow(event.start, windowStart, windowEnd)) {
      const o = applyException(event, event.start, event.end);
      return { ok: true, value: o ? [o] : [] };
    }
    return { ok: true, value: [] };
  }
  const parsed = parseRRule(recurring.rrule);
  if (!parsed.ok) return failure("invalid-rrule", "malformed RRULE");
  const rule = parsed.value;
  if (rule.count === undefined && rule.until === undefined) return failure("unbounded-rrule", "RRULE requires COUNT or UNTIL");
  try {
    return expand(event, rule, windowStart, windowEnd, limits);
  } catch (error) {
    return failure(error instanceof Error && error.message.includes("override") ? "invalid-override" : "invalid-rrule", error instanceof Error ? error.message : "unable to expand RRULE");
  }
}

function comparableMillis(time: CalendarTime): number {
  return time.kind === "all-day" ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.instant);
}
function inWindow(t: CalendarTime, from: CalendarTime, to: CalendarTime): boolean {
  const a = comparableMillis(t);
  const f = comparableMillis(from);
  const z = comparableMillis(to);
  return a >= f && a <= z;
}
function expand(
  event: StoredCalendarEvent,
  rule: RRule,
  from: CalendarTime,
  to: CalendarTime,
  limits: RecurrenceExpansionLimits,
): ExpandRecurrenceResult {
  const allDay = event.start.kind === "all-day";
  const timedStart = event.start.kind === "timed" ? event.start : undefined;
  const zone = allDay
    ? "UTC"
    : timedStart!.timeZoneId === DEFAULT_EVENT_TIME_ZONE
      ? resolveTimeZone().zone()
      : timedStart!.timeZoneId;
  const startMs = allDay ? Date.parse(`${(event.start as { date: LocalDate }).date}T00:00:00Z`) : Date.parse(timedStart!.instant);
  const anchor: Date | Parts = allDay ? dayDate(startMs) : parts(startMs, zone);
  const until = rule.until ? Date.parse(rule.until) : Infinity;
  const fromMs = comparableMillis(from);
  const toMs = comparableMillis(to);
  if (!Number.isFinite(startMs) || (rule.until !== undefined && !Number.isFinite(until)) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return failure("invalid-rrule", "recurrence dates are invalid");
  const startDayMs = allDay ? startMs : Date.parse(`${dateKey(parts(startMs, zone))}T00:00:00Z`);
  const exdates = new Set((event.exdates ?? []).map(canonicalOriginalKey));
  const out: Occurrence[] = [];
  let ordinal = 0;
  let lastGeneratedMs = Number.NEGATIVE_INFINITY;
  const max = rule.count ?? Number.MAX_SAFE_INTEGER;
  // maxDays bounds the amount of recurrence time we will inspect. The explicit
  // cursor ceiling remains a last line of defence for malformed sparse rules.
  const cursorCeiling = Math.min(1_000_000, Math.max(1, limits.maxDays) + 1);
  for (let cursor = 0; ordinal < max && cursor < cursorCeiling; cursor++) {
    const dates: Date[] = [];
    if (allDay) dates.push(...candidateDates(anchor as Date, rule, cursor));
    else { const a = anchor as Parts; dates.push(...candidateDates(new Date(Date.UTC(a.year, a.month - 1, a.day)), rule, cursor)); }
    for (const date of dates) {
      if (ordinal >= max) break;
      const local: CalendarTime | undefined = allDay
        ? { kind: "all-day", date: date.toISOString().slice(0, 10) as LocalDate }
        : (() => { const a = anchor as Parts; const p: Parts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: a.hour, minute: a.minute, second: a.second }; const ms = instantForLocal(p, zone); return ms === undefined ? undefined : { kind: "timed", instant: new Date(ms).toISOString() as UtcInstant, timeZoneId: timedStart!.timeZoneId }; })();
      if (!local) continue;
      const localMs = comparableMillis(local);
      // BYDAY may produce days before DTSTART in the first week.
      if (localMs < startMs) continue;
      if (localMs > until || localMs > toMs) return { ok: true, value: out };
      const localDayMs = allDay ? localMs : Date.parse(`${dateKey(parts(localMs, zone))}T00:00:00Z`);
      if (!Number.isFinite(startDayMs) || !Number.isFinite(localDayMs) || localDayMs - startDayMs > limits.maxDays * MS_DAY) return failure("recurrence-limit", "recurrence exceeds maxDays");
      if (ordinal >= limits.maxOccurrences) return failure("recurrence-limit", "recurrence exceeds maxOccurrences");
      ordinal++;
      lastGeneratedMs = localMs;
      if (exdates.has(canonicalOriginalKey(local))) continue;
      const baseEnd = shiftedEnd(event.end, event.start, local);
      const o = applyException(event, local, baseEnd);
      if (o && inWindow(o.start, from, to)) out.push(o);
    }
  }
  if (rule.count !== undefined && ordinal >= rule.count) return { ok: true, value: out };
  if (rule.until !== undefined && lastGeneratedMs >= until) return { ok: true, value: out };
  return failure("recurrence-limit", "recurrence expansion exceeded its safety limit");
}
function shiftedEnd(end: CalendarTime | undefined, original: CalendarTime, start: CalendarTime): CalendarTime | undefined {
  if (!end || end.kind !== original.kind) return undefined;
  if (start.kind === "timed" && original.kind === "timed") {
    const delta = Date.parse((end as { kind: "timed"; instant: string }).instant) - Date.parse((original as { kind: "timed"; instant: string }).instant);
    return { ...start, instant: new Date(Date.parse(start.instant) + delta).toISOString() as UtcInstant };
  }
  if (start.kind === "all-day" && original.kind === "all-day") {
    const delta = Date.parse(`${(end as { kind: "all-day"; date: string }).date}T00:00:00Z`) - Date.parse(`${(original as { kind: "all-day"; date: string }).date}T00:00:00Z`);
    return { kind: "all-day", date: new Date(Date.parse(`${start.date}T00:00:00Z`) + delta).toISOString().slice(0, 10) as LocalDate };
  }
  return undefined;
}
function candidateDates(anchor: Date, rule: RRule, cursor: number): Date[] {
  const interval = rule.interval ?? 1;
  if (rule.freq === "DAILY") return [new Date(anchor.getTime() + cursor * interval * MS_DAY)];
  if (rule.freq === "WEEKLY") {
    const week = new Date(anchor.getTime() + cursor * interval * 7 * MS_DAY);
    const day = week.getUTCDay();
    const days = (rule.byDay ?? [WEEKDAYS[(day + 6) % 7] as Weekday]).map((x) => weekdayIndex[x]).sort((a, b) => a - b);
    const monday = new Date(week.getTime() - ((day + 6) % 7) * MS_DAY);
    return days.map((d) => new Date(monday.getTime() + ((d + 6) % 7) * MS_DAY));
  }
  if (rule.freq === "MONTHLY") {
    const d = addMonths(anchor, cursor * interval);
    d.setUTCDate(anchor.getUTCDate());
    return d.getUTCMonth() === (anchor.getUTCMonth() + cursor * interval) % 12 ? [d] : [];
  }
  const year = anchor.getUTCFullYear() + cursor * interval;
  const d = new Date(Date.UTC(year, anchor.getUTCMonth(), anchor.getUTCDate()));
  return d.getUTCMonth() === anchor.getUTCMonth() && d.getUTCDate() === anchor.getUTCDate() ? [d] : [];
}

export interface GeneratedSlot {
  readonly originalStart: CalendarTime;
  /** One-based ordinal in the generated series, before EXDATE/cancellation filtering. */
  readonly ordinal: number;
}
export type GeneratedSlotsResult =
  | { ok: true; value: GeneratedSlot[] }
  | { ok: false; error: RecurrenceExpansionError };

/** Enumerate recurrence slots without applying exclusions, overrides, or a list window. */
export function enumerateGeneratedSlots(
  event: Pick<StoredCalendarEvent, "start" | "recurrence">,
  limits: RecurrenceExpansionLimits = DEFAULT_RECURRENCE_LIMITS,
): GeneratedSlotsResult {
  if (!event.recurrence) return { ok: true, value: [{ originalStart: event.start, ordinal: 1 }] };
  if (!Number.isInteger(limits.maxOccurrences) || limits.maxOccurrences < 1 || !Number.isInteger(limits.maxDays) || limits.maxDays < 1) return { ok: false, error: { kind: "recurrence-error", code: "recurrence-limit", message: "invalid recurrence expansion limits" } };
  const parsed = parseRRule(event.recurrence.rrule);
  if (!parsed.ok) return { ok: false, error: { kind: "recurrence-error", code: "invalid-rrule", message: "malformed RRULE" } };
  const rule = parsed.value;
  if (rule.count === undefined && rule.until === undefined) return { ok: false, error: { kind: "recurrence-error", code: "unbounded-rrule", message: "RRULE requires COUNT or UNTIL" } };
  const allDay = event.start.kind === "all-day";
  const timedStart = event.start.kind === "timed" ? event.start : undefined;
  const zone = allDay ? "UTC" : timedStart!.timeZoneId === DEFAULT_EVENT_TIME_ZONE ? resolveTimeZone().zone() : timedStart!.timeZoneId;
  const startMs = allDay ? Date.parse(`${(event.start as { kind: "all-day"; date: LocalDate }).date}T00:00:00Z`) : Date.parse(timedStart!.instant);
  const anchor: Date | Parts = allDay ? dayDate(startMs) : parts(startMs, zone);
  const until = rule.until ? Date.parse(rule.until) : Infinity;
  if (!Number.isFinite(startMs) || (rule.until !== undefined && !Number.isFinite(until))) return { ok: false, error: { kind: "recurrence-error", code: "invalid-rrule", message: "recurrence dates are invalid" } };
  const startDayMs = allDay ? startMs : Date.parse(`${dateKey(parts(startMs, zone))}T00:00:00Z`);
  const output: GeneratedSlot[] = [];
  let ordinal = 0;
  const max = rule.count ?? Number.MAX_SAFE_INTEGER;
  for (let cursor = 0; cursor < 1_000_000 && ordinal < max; cursor++) {
    const anchorDate = allDay ? anchor as Date : new Date(Date.UTC((anchor as Parts).year, (anchor as Parts).month - 1, (anchor as Parts).day));
    for (const date of candidateDates(anchorDate, rule, cursor)) {
      if (ordinal >= max) break;
      const local: CalendarTime | undefined = allDay
        ? { kind: "all-day", date: date.toISOString().slice(0, 10) as LocalDate }
        : (() => {
          const a = anchor as Parts;
          const p: Parts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: a.hour, minute: a.minute, second: a.second };
          const ms = instantForLocal(p, zone);
          return ms === undefined ? undefined : { kind: "timed", instant: new Date(ms).toISOString() as UtcInstant, timeZoneId: timedStart!.timeZoneId };
        })();
      if (!local) continue;
      const localMs = comparableMillis(local);
      if (localMs < startMs) continue;
      if (localMs > until) return { ok: true, value: output };
      const localDayMs = allDay ? localMs : Date.parse(`${dateKey(parts(localMs, zone))}T00:00:00Z`);
      if (!Number.isFinite(localDayMs) || localDayMs - startDayMs > limits.maxDays * MS_DAY) return { ok: false, error: { kind: "recurrence-error", code: "recurrence-limit", message: "recurrence exceeds maxDays" } };
      if (ordinal >= limits.maxOccurrences) return { ok: false, error: { kind: "recurrence-error", code: "recurrence-limit", message: "recurrence exceeds maxOccurrences" } };
      ordinal++;
      output.push({ originalStart: local, ordinal });
    }
  }
  if (rule.count !== undefined && ordinal >= rule.count) return { ok: true, value: output };
  if (rule.until !== undefined && output.length > 0 && comparableMillis(output[output.length - 1]!.originalStart) >= until) return { ok: true, value: output };
  return { ok: false, error: { kind: "recurrence-error", code: "recurrence-limit", message: "recurrence expansion exceeded its safety limit" } };
}

export function verifyGeneratedSlot(
  event: Pick<StoredCalendarEvent, "start" | "recurrence">,
  originalStart: CalendarTime,
  limits: RecurrenceExpansionLimits = DEFAULT_RECURRENCE_LIMITS,
): { ok: true; ordinal: number } | { ok: false; error: RecurrenceExpansionError } {
  if (event.start.kind !== originalStart.kind) return { ok: false, error: { kind: "recurrence-error", code: "invalid-window", message: "occurrence time kind differs from event" } };
  const slots = enumerateGeneratedSlots(event, limits);
  if (!slots.ok) return slots;
  const found = slots.value.find((slot) => sameTime(slot.originalStart, originalStart));
  return found ? { ok: true, ordinal: found.ordinal } : { ok: false, error: { kind: "recurrence-error", code: "invalid-window", message: "originalStart is not a generated recurrence slot" } };
}
export function isGeneratedSlot(event: Pick<StoredCalendarEvent, "start" | "recurrence">, originalStart: CalendarTime, limits?: RecurrenceExpansionLimits): boolean {
  return verifyGeneratedSlot(event, originalStart, limits).ok;
}
