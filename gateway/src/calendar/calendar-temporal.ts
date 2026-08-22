import type { CalendarError, CalendarTime, EventTimeZoneId, LocalDate, UtcInstant } from "./types.js";
import { DEFAULT_EVENT_TIME_ZONE, isValidCalendarDate } from "./types.js";

/** The limits consumed here are resolved values; YAML/config composition lives elsewhere. */
export interface CalendarTemporalLimits {
  query?: { maxDays: number; maxOccurrences?: number; pageSize?: number };
  input?: {
    maxTitleChars: number;
    maxDescriptionChars: number;
    maxQueryChars: number;
    maxGroupChars: number;
    maxTagChars: number;
    maxTags: number;
  };
  /** Resolved household IANA zone. The aliases ease composition with existing calendar config. */
  householdTimeZone?: string;
  householdTimezone?: string;
  defaultEventTimeZoneId?: string;
}

export interface CalendarInputLimits {
  maxTitleChars: number;
  maxDescriptionChars: number;
  maxQueryChars: number;
  maxGroupChars: number;
  maxTagChars: number;
  maxTags: number;
}

export interface CalendarTemporalError extends CalendarError {
  readonly field?: string;
  readonly limit?: number;
  readonly measured?: number;
  readonly kind?: "all-day" | "timed";
}
export type CalendarTemporalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CalendarTemporalError };

export interface NormalizedCalendarWindow {
  readonly from: CalendarTime;
  readonly to: CalendarTime;
}

export interface NormalizedCalendarEventTimes {
  readonly start: CalendarTime;
  readonly end?: CalendarTime;
}

export interface CalendarInputForLimits {
  readonly title?: string;
  readonly description?: string | null;
  readonly query?: string;
  readonly group?: string | null;
  readonly tags?: readonly string[];
}

export interface CalendarEventTimeInput {
  readonly start: unknown;
  readonly end?: unknown;
  readonly recurring?: boolean;
}

export interface NormalizeTimeOptions {
  /** Event start values for a recurring event use the household wall clock. */
  readonly recurring?: boolean;
  /** Query boundaries use the first/last point of a date period. */
  readonly boundary?: "start" | "end";
}

const DEFAULT_MAX_QUERY_DAYS = 366;
const DEFAULT_INPUT_LIMITS: CalendarInputLimits = {
  maxTitleChars: 512,
  maxDescriptionChars: 8000,
  maxQueryChars: 512,
  maxGroupChars: 128,
  maxTagChars: 64,
  maxTags: 32,
};
const MS_DAY = 86_400_000;
const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
interface ParsedDatePeriod {
  readonly kind: "all-day";
  readonly first: LocalDate;
  readonly last: LocalDate;
}
interface ParsedTimestamp {
  readonly kind: "timed";
  readonly instantMs: number;
  readonly offsetMinutes: number;
}
export type ParsedCalendarTemporal = ParsedDatePeriod | ParsedTimestamp;

function failure(
  code: CalendarTemporalError["code"],
  message: string,
  details: Pick<CalendarTemporalError, "field" | "limit" | "measured" | "kind"> = {},
): CalendarTemporalResult<never> {
  return { ok: false, error: { code, message, ...details } };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
function householdZone(config: CalendarTemporalLimits): string | undefined {
  return config.householdTimeZone ?? config.householdTimezone ?? config.defaultEventTimeZoneId;
}
function queryMaxDays(config: CalendarTemporalLimits): number {
  return config.query?.maxDays ?? DEFAULT_MAX_QUERY_DAYS;
}
function inputLimits(config: CalendarTemporalLimits): CalendarInputLimits {
  return { ...DEFAULT_INPUT_LIMITS, ...(config.input ?? {}) };
}
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
function localDate(year: number, month: number, day: number): LocalDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as LocalDate;
}
function dateAtUtc(date: LocalDate): number {
  const pieces = date.split("-");
  const [yearText, monthText, dayText] = pieces;
  if (yearText === undefined || monthText === undefined || dayText === undefined) return Number.NaN;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(0, 0, 0, 0);
  return result.getTime();
}
function dateAfter(date: LocalDate, days: number): LocalDate {
  const result = new Date(dateAtUtc(date));
  result.setUTCDate(result.getUTCDate() + days);
  return localDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}
function daysBetween(first: LocalDate, last: LocalDate): number {
  return Math.round((dateAtUtc(last) - dateAtUtc(first)) / MS_DAY) + 1;
}

function localParts(atMs: number, zone: string): DateParts {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs)))
    values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}
function localAsUtc(parts: DateParts): number {
  const result = new Date(0);
  result.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  result.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return result.getTime();
}

function zoneOffsetMinutes(atMs: number, zone: string): number {
  const parts = localParts(atMs, zone);
  return Math.round((localAsUtc(parts) - atMs) / 60_000);
}

function parseDatePeriod(value: string): ParsedDatePeriod | undefined {
  const match = DATE_RE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return undefined;
  const first = localDate(year, month, day);
  if (match[2] === undefined) return { kind: "all-day", first, last: localDate(year, 12, 31) };
  if (match[3] === undefined) {
    const nextMonth = month === 12 ? localDate(year + 1, 1, 1) : localDate(year, month + 1, 1);
    return { kind: "all-day", first, last: dateAfter(nextMonth, -1) };
  }
  return { kind: "all-day", first, last: first };
}

function parseTimestamp(value: string): ParsedTimestamp | undefined {
  const match = RFC3339_RE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  if (offset === undefined) return undefined;
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return undefined;
  const fraction = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  const local: DateParts = { year, month, day, hour, minute, second };
  const sign = offset === "Z" || offset[0] === "+" ? 1 : -1;
  const offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  const instantMs = localAsUtc(local) + fraction - offsetMinutes * 60_000;
  return Number.isFinite(instantMs) ? { kind: "timed", instantMs, offsetMinutes } : undefined;
}

/** Parse only the approved external temporal grammar. This function has no side effects. */
export function parseCalendarTemporal(value: unknown): CalendarTemporalResult<ParsedCalendarTemporal> {
  if (typeof value !== "string")
    return failure(
      "invalid_time",
      "time must be a YYYY, YYYY-MM, YYYY-MM-DD, or offset RFC 3339 value; correct the time and retry.",
    );
  const date = parseDatePeriod(value);
  if (date) return { ok: true, value: date };
  const timestamp = parseTimestamp(value);
  if (timestamp) return { ok: true, value: timestamp };
  return failure(
    "invalid_time",
    "time has unsupported precision or an impossible value; use YYYY, YYYY-MM, YYYY-MM-DD, or an offset RFC 3339 timestamp and retry.",
  );
}

function normalizedTimed(
  parsed: ParsedTimestamp,
  config: CalendarTemporalLimits,
  recurring: boolean,
): CalendarTemporalResult<CalendarTime> {
  const zone = householdZone(config);
  if (zone === undefined || !validZone(zone))
    return failure(
      "invalid_time",
      "the configured household timezone is invalid; correct the timezone configuration and retry.",
    );
  if (recurring && zoneOffsetMinutes(parsed.instantMs, zone) !== parsed.offsetMinutes) {
    return failure(
      "invalid_time",
      "the recurring start offset does not match the configured household timezone at the start; use that timezone's offset and retry.",
    );
  }
  return {
    ok: true,
    value: {
      kind: "timed",
      instant: new Date(parsed.instantMs).toISOString() as UtcInstant,
      timeZoneId: (recurring ? zone : zone || DEFAULT_EVENT_TIME_ZONE) as EventTimeZoneId,
    },
  };
}

/** Normalize one external time. Date periods select their first point by default. */
export function normalizeCalendarTime(
  value: unknown,
  config: CalendarTemporalLimits,
  options: NormalizeTimeOptions = {},
): CalendarTemporalResult<CalendarTime> {
  const parsed = parseCalendarTemporal(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "all-day") {
    return {
      ok: true,
      value: {
        kind: "all-day",
        date: (options.boundary === "end" ? parsed.value.last : parsed.value.first) as LocalDate,
      },
    };
  }
  return normalizedTimed(parsed.value, config, options.recurring === true);
}

/** Stable recurrence/exception identity for a normalized internal time. */
export function calendarTimeKey(time: CalendarTime): string {
  return time.kind === "all-day" ? time.date : new Date(time.instant).toISOString();
}

function compareTimes(a: CalendarTime, b: CalendarTime): number {
  if (a.kind === "all-day" && b.kind === "all-day") return dateAtUtc(a.date) - dateAtUtc(b.date);
  if (a.kind === "timed" && b.kind === "timed") return Date.parse(a.instant) - Date.parse(b.instant);
  return 0;
}

/** Normalize and validate a bounded query before a store is touched. */
export function normalizeCalendarQuery(
  input: unknown,
  config: CalendarTemporalLimits,
): CalendarTemporalResult<NormalizedCalendarWindow> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_range", "from and to are required; provide both bounds and retry.");
  }
  const raw = input as Record<string, unknown>;
  if (raw.from === undefined || raw.to === undefined) {
    return failure("invalid_range", "from and to are required; provide both bounds and retry.", {
      field: raw.from === undefined ? "from" : "to",
    });
  }
  if (raw.query !== undefined && typeof raw.query !== "string")
    return failure("invalid_range", "query must be a string within its configured limit; correct query and retry.", {
      field: "query",
    });
  if (raw.group !== undefined && typeof raw.group !== "string")
    return failure("invalid_range", "group must be a string within its configured limit; correct group and retry.", {
      field: "group",
    });
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string"))) {
    return failure(
      "invalid_range",
      "tags must be a list of strings within its configured limits; correct tags and retry.",
      { field: "tags" },
    );
  }
  const inputBounds = validateCalendarInputLimits(
    {
      ...(typeof raw.query === "string" ? { query: raw.query } : {}),
      ...(typeof raw.group === "string" ? { group: raw.group } : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags as string[] } : {}),
    },
    config,
  );
  if (!inputBounds.ok) return inputBounds;
  const fromParsed = parseCalendarTemporal(raw.from);
  if (!fromParsed.ok)
    return failure("invalid_time", "from is not a supported calendar time; correct from and retry.", { field: "from" });
  const toParsed = parseCalendarTemporal(raw.to);
  if (!toParsed.ok)
    return failure("invalid_time", "to is not a supported calendar time; correct to and retry.", { field: "to" });
  if (fromParsed.value.kind !== toParsed.value.kind) {
    return failure(
      "invalid_range",
      "from and to must use the same all-day or timed kind; use compatible bounds and retry.",
    );
  }
  const from = normalizeCalendarTime(raw.from, config, { boundary: "start" });
  if (!from.ok) return from;
  const to = normalizeCalendarTime(raw.to, config, { boundary: "end" });
  if (!to.ok) return to;
  const measured =
    from.value.kind === "all-day" && to.value.kind === "all-day"
      ? daysBetween(from.value.date, to.value.date)
      : from.value.kind === "timed" && to.value.kind === "timed"
        ? Math.ceil((Date.parse(to.value.instant) - Date.parse(from.value.instant)) / MS_DAY)
        : 0;
  if (compareTimes(from.value, to.value) > 0) {
    return failure("invalid_range", "from must not be after to; reverse or narrow the bounds and retry.", { measured });
  }
  if (measured > queryMaxDays(config)) {
    return failure(
      "range_too_wide",
      `the requested range is ${measured} days, above the configured maximum of ${queryMaxDays(config)}; narrow from/to and retry.`,
      { measured, limit: queryMaxDays(config) },
    );
  }
  return { ok: true, value: { from: from.value, to: to.value } };
}

/** Normalize create/update boundaries, using the earliest start and latest end of date periods. */
export function normalizeCalendarEventTimes(
  start: unknown,
  end: unknown,
  config: CalendarTemporalLimits,
  options: Pick<NormalizeTimeOptions, "recurring"> = {},
): CalendarTemporalResult<NormalizedCalendarEventTimes> {
  if (start === undefined || start === null)
    return failure("invalid_time", "start is required; provide a valid calendar time and retry.", { field: "start" });
  const normalizedStart = normalizeCalendarTime(start, config, {
    boundary: "start",
    ...(options.recurring === undefined ? {} : { recurring: options.recurring }),
  });
  if (!normalizedStart.ok) return { ok: false, error: { ...normalizedStart.error, field: "start" } };
  if (end === undefined || end === null) return { ok: true, value: { start: normalizedStart.value } };
  const normalizedEnd = normalizeCalendarTime(end, config, { boundary: "end" });
  if (!normalizedEnd.ok) return { ok: false, error: { ...normalizedEnd.error, field: "end" } };
  if (normalizedStart.value.kind !== normalizedEnd.value.kind) {
    return failure(
      "invalid_range",
      "start and end must use the same all-day or timed kind; use compatible values and retry.",
    );
  }
  if (compareTimes(normalizedEnd.value, normalizedStart.value) < 0) {
    return failure("invalid_range", "end must not precede start; move end later or move start earlier and retry.");
  }
  return { ok: true, value: { start: normalizedStart.value, end: normalizedEnd.value } };
}

/** Check metadata limits without placing supplied calendar content in an error. */
export function validateCalendarInputLimits(
  input: CalendarInputForLimits,
  config: CalendarTemporalLimits | CalendarInputLimits,
): CalendarTemporalResult<void> {
  const limits = "input" in config ? inputLimits(config) : { ...DEFAULT_INPUT_LIMITS, ...config };
  const fields: Array<[string, string | null | undefined, number]> = [
    ["title", input.title, limits.maxTitleChars],
    ["description", input.description, limits.maxDescriptionChars],
    ["query", input.query, limits.maxQueryChars],
    ["group", input.group, limits.maxGroupChars],
  ];
  for (const [field, value, limit] of fields) {
    if (value !== undefined && value !== null && value.length > limit) {
      return failure(
        "invalid_range",
        `${field} exceeds the configured limit of ${limit} characters; shorten ${field} and retry.`,
        { field, limit, measured: value.length },
      );
    }
  }
  if (input.tags !== undefined) {
    if (input.tags.length > limits.maxTags) {
      return failure(
        "invalid_range",
        `tags contains ${input.tags.length} values, above the configured maximum of ${limits.maxTags}; remove tags and retry.`,
        { field: "tags", limit: limits.maxTags, measured: input.tags.length },
      );
    }
    for (const tag of input.tags) {
      if (tag.length > limits.maxTagChars) {
        return failure(
          "invalid_range",
          `a tag exceeds the configured limit of ${limits.maxTagChars} characters; shorten the tag and retry.`,
          { field: "tags", limit: limits.maxTagChars, measured: tag.length },
        );
      }
    }
  }
  return { ok: true, value: undefined };
}

/** Alias used by adapters that treat these checks as general calendar validation. */
export const validateCalendarStrings = validateCalendarInputLimits;
export const validateCalendarQueryInput = normalizeCalendarQuery;
export const normalizeCalendarRange = normalizeCalendarQuery;
export const normalizeCalendarTimes = normalizeCalendarEventTimes;
export const parseCalendarTime = parseCalendarTemporal;

/** Object-shaped convenience seam for mutation/query adapters. */
export function normalizeCalendarEvent(
  input: CalendarEventTimeInput,
  config: CalendarTemporalLimits,
): CalendarTemporalResult<NormalizedCalendarEventTimes> {
  return normalizeCalendarEventTimes(
    input.start,
    input.end,
    config,
    input.recurring === undefined ? {} : { recurring: input.recurring },
  );
}
