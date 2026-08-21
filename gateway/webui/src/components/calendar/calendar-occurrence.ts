import type { CalendarTime } from "../../services/calendar-api.ts";
import type {
  CalendarActionIdentity,
  CalendarOccurrenceInput,
  ProjectedCalendarOccurrence,
  ProjectedCalendarTime,
} from "./calendar-projection-types.ts";
import {
  type CalendarDate,
  type CalendarTimeFormatOptions,
  calendarDateForInstant,
  formatAccessibleCalendarDate,
  formatAccessibleCalendarTime,
  formatCalendarClock,
  formatCalendarDate,
  formatCalendarTime,
  isCalendarDate,
} from "./calendar-time.ts";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function field(value: CalendarOccurrenceInput, name: string): unknown {
  return (value as unknown as Record<string, unknown>)[name];
}

function stringField(value: CalendarOccurrenceInput, name: string): string | undefined {
  const candidate = field(value, name);
  return typeof candidate === "string" ? candidate : undefined;
}

function rawTemporal(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CalendarTime>;
  if (candidate.kind === "all-day" && typeof candidate.date === "string") return candidate.date;
  if (candidate.kind === "timed" && typeof candidate.instant === "string") return candidate.instant;
  return null;
}

function temporalKind(raw: string): "all-day" | "timed" {
  return isCalendarDate(raw) ? "all-day" : "timed";
}

function sourceTemporal(value: unknown): CalendarTime | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CalendarTime>;
  if (candidate.kind === "all-day" && typeof candidate.date === "string") return candidate as CalendarTime;
  if (candidate.kind === "timed" && typeof candidate.instant === "string") return candidate as CalendarTime;
  return null;
}

function displayOptions(
  options: CalendarTimeFormatOptions & { readonly deviceTimeZone?: string },
): CalendarTimeFormatOptions {
  // `deviceTimeZone` is an explicit caller setting. Never fall back to the
  // source compatibility timeZoneId here; it may be the literal "UTC".
  const zone = options.timeZoneId ?? options.timeZone ?? options.deviceTimeZone;
  return {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...(zone !== undefined ? { timeZone: zone } : {}),
  };
}

function projectedTime(
  value: unknown,
  options: CalendarTimeFormatOptions & { readonly deviceTimeZone?: string },
): ProjectedCalendarTime | null {
  const raw = rawTemporal(value);
  if (!raw) return null;
  const kind = temporalKind(raw);
  const timeOptions = displayOptions(options);
  if (kind === "all-day") {
    if (!isCalendarDate(raw)) return null;
    const date = raw as CalendarDate;
    return {
      kind,
      raw,
      date,
      localDate: date,
      displayDate: formatCalendarDate(date, timeOptions),
      label: formatCalendarDate(date, timeOptions),
      accessibleLabel: formatAccessibleCalendarDate(date, timeOptions),
    };
  }
  // An invalid display-zone setting must not drop an authorized event. UTC is
  // only a formatting fallback; it is never copied into the source identity.
  const localDate = calendarDateForInstant(raw, timeOptions.timeZone) ?? calendarDateForInstant(raw, "UTC");
  if (!localDate) return null;
  const source: CalendarTime = sourceTemporal(value) ?? { kind: "timed", instant: raw, timeZoneId: "UTC" };
  return {
    kind,
    raw,
    instant: raw,
    localDate,
    displayDate: formatCalendarDate(localDate, timeOptions),
    displayTime: formatCalendarClock(source, timeOptions),
    label: formatCalendarTime(source, timeOptions),
    accessibleLabel: formatAccessibleCalendarTime(source, timeOptions),
  };
}

function occurrenceEventId(value: CalendarOccurrenceInput): string {
  return stringField(value, "eventId") ?? stringField(value, "baseEventId") ?? stringField(value, "id") ?? "";
}

function occurrenceOriginalStart(value: CalendarOccurrenceInput): string {
  return (
    rawTemporal(field(value, "originalStart")) ??
    rawTemporal(field(value, "occurrenceStart")) ??
    rawTemporal(field(value, "start")) ??
    ""
  );
}

function occurrenceId(value: CalendarOccurrenceInput, originalStart: string): string {
  return stringField(value, "occurrenceId") ?? `${occurrenceEventId(value)}@${originalStart}`;
}

export function calendarOccurrenceIdentity(value: CalendarOccurrenceInput): CalendarActionIdentity {
  const originalStart = occurrenceOriginalStart(value);
  return {
    eventId: occurrenceEventId(value),
    occurrenceId: occurrenceId(value, originalStart),
    originalStart,
    ...(typeof field(value, "revision") === "number" ? { revision: field(value, "revision") as number } : {}),
    scope: field(value, "scope") === "household" ? "household" : "private",
  };
}

/**
 * Project one authorized source row for display while retaining every V2
 * action field and exact source temporal string. The source compatibility
 * timezone is intentionally retained only inside `source`, not used for
 * device-local placement or formatting.
 */
export function projectCalendarOccurrence(
  value: CalendarOccurrenceInput,
  options: CalendarTimeFormatOptions & { readonly deviceTimeZone?: string } = {},
): ProjectedCalendarOccurrence {
  const identity = calendarOccurrenceIdentity(value);
  const start = projectedTime(field(value, "start"), options);
  if (!start) throw new RangeError("Calendar occurrence has an invalid start");
  const end =
    field(value, "end") === undefined ? undefined : (projectedTime(field(value, "end"), options) ?? undefined);
  const title = stringField(value, "title") ?? "";
  const recurring = field(value, "recurring") === true || field(value, "recurrence") !== undefined;
  const description = stringField(value, "description");
  const group = stringField(value, "group");
  const tagsValue = field(value, "tags");
  const tags = Array.isArray(tagsValue) ? tagsValue.filter((tag): tag is string => typeof tag === "string") : [];
  const accessibleName = end
    ? `${title}, ${start.accessibleLabel} to ${end.accessibleLabel}`
    : `${title}, ${start.accessibleLabel}`;
  return {
    eventId: identity.eventId,
    occurrenceId: identity.occurrenceId,
    originalStart: identity.originalStart,
    rawOriginalStart: identity.originalStart,
    recurring,
    ...(identity.revision !== undefined ? { revision: identity.revision } : {}),
    scope: identity.scope,
    title,
    ...(description !== undefined ? { description } : {}),
    visibility: field(value, "visibility") === "adults" ? "adults" : "everyone",
    importance:
      field(value, "importance") === "important" || field(value, "importance") === "pinned"
        ? (field(value, "importance") as "important" | "pinned")
        : "normal",
    ...(group !== undefined ? { group } : {}),
    tags,
    start,
    ...(end ? { end } : {}),
    action: identity,
    source: value,
    occurrence: value,
    accessibleName,
  };
}

export function projectCalendarOccurrences(
  values: readonly CalendarOccurrenceInput[],
  options: CalendarTimeFormatOptions & { readonly deviceTimeZone?: string } = {},
): ProjectedCalendarOccurrence[] {
  return values.map((value) => projectCalendarOccurrence(value, options));
}

function projectedTimeValue(event: ProjectedCalendarOccurrence): number {
  if (event.start.kind === "all-day") return Date.parse(`${event.start.localDate}T00:00:00.000Z`);
  const value = Date.parse(event.start.instant ?? event.start.raw);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function compareProjectedCalendarOccurrences(
  a: ProjectedCalendarOccurrence,
  b: ProjectedCalendarOccurrence,
): number {
  return (
    projectedTimeValue(a) - projectedTimeValue(b) ||
    (a.start.kind === "all-day" ? 0 : 1) - (b.start.kind === "all-day" ? 0 : 1) ||
    compareText(a.scope, b.scope) ||
    compareText(a.eventId, b.eventId) ||
    compareText(a.originalStart, b.originalStart) ||
    compareText(a.occurrenceId, b.occurrenceId)
  );
}

export function rawOccurrenceOriginalStart(value: CalendarOccurrenceInput): string {
  return calendarOccurrenceIdentity(value).originalStart;
}
