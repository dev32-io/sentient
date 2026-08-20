import { resolveTimeZone } from "../context/message-time.js";
import type {
  StoredCalendarEvent,
  CalendarTime,
  LocalDate,
  Occurrence,
  RRule,
  UtcInstant,
  Weekday,
} from "./types.js";
import { DEFAULT_EVENT_TIME_ZONE, parseRRule, WEEKDAYS } from "./types.js";

export type RecurrenceExpansionErrorCode = "invalid-rrule" | "unbounded-rrule" | "invalid-window" | "recurrence-limit";
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
function keyOf(t: CalendarTime): string { return t.kind === "all-day" ? t.date : new Date(t.instant).toISOString(); }
function sameTime(a: CalendarTime, b: CalendarTime): boolean { return a.kind === b.kind && keyOf(a) === keyOf(b); }
function failure(code: RecurrenceExpansionErrorCode, message: string): ExpandRecurrenceResult { return { ok: false, error: { kind: "recurrence-error", code, message } }; }

function occurrence(event: StoredCalendarEvent, original: CalendarTime, start: CalendarTime, end: CalendarTime | undefined): Occurrence {
  const { end: _ignoredEnd, ...withoutEnd } = event;
  const id = `${event.id}:${keyOf(original)}`;
  return { ...withoutEnd, start, ...(end ? { end, occurrenceEnd: end } : {}), occurrenceId: id, baseEventId: event.id, occurrenceStart: original };
}
function applyException(event: StoredCalendarEvent, original: CalendarTime, baseEnd = event.end): Occurrence | undefined {
  const ex = event.exceptions?.find((x) => sameTime(x.occurrence, original));
  if (ex?.cancelled) return undefined;
  const start = ex?.start ?? original;
  const end = ex?.end ?? baseEnd;
  const result = occurrence(event, original, start, end);
  if (ex?.title !== undefined) result.title = ex.title;
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
  } catch {
    return failure("invalid-rrule", "unable to expand RRULE");
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
  const exdates = new Set((event.exdates ?? []).map(keyOf));
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
      if (exdates.has(keyOf(local))) continue;
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
