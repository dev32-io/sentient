import type { CalendarTime, CalendarTimeInput } from "../../services/calendar-api.ts";

/** A calendar date is a date-only identity, never an instant. */
export type CalendarDate = `${number}-${number}-${number}`;

export interface CalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface CalendarTimeFormatOptions {
  /** Locale used for labels. Defaults to the browser's resolved locale. */
  readonly locale?: string | readonly string[];
  /** Device display zone. The source CalendarTime.timeZoneId is intentionally not used. */
  readonly timeZone?: string;
  /** Alias accepted by callers that use the service model's terminology. */
  readonly timeZoneId?: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonthValue(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse and validate a full Gregorian calendar date. */
export function parseCalendarDate(value: string): CalendarDateParts | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonthValue(year, month)) return null;
  return { year, month, day };
}

export function isCalendarDate(value: string): value is CalendarDate {
  return parseCalendarDate(value) !== null;
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  return daysInMonthValue(year, month);
}

export function formatCalendarDateKey(parts: CalendarDateParts): CalendarDate {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` as CalendarDate;
}

function utcFieldMillis(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, 0, 0);
  return result.getTime();
}

function dateAtUtcNoon(value: CalendarDate): Date {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return new Date(utcFieldMillis(parts.year, parts.month, parts.day, 12, 0));
}

function calendarDateFromUtcDate(value: Date): CalendarDate {
  return formatCalendarDateKey({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
}

export function compareCalendarDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addCalendarDays(value: CalendarDate, amount: number): CalendarDate {
  if (!Number.isInteger(amount)) throw new RangeError("Calendar day offset must be an integer");
  const result = dateAtUtcNoon(value);
  result.setUTCDate(result.getUTCDate() + amount);
  return calendarDateFromUtcDate(result);
}

/** Add months while clamping the day to the target month's last valid day. */
export function addCalendarMonths(value: CalendarDate, amount: number): CalendarDate {
  if (!Number.isInteger(amount)) throw new RangeError("Calendar month offset must be an integer");
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  const absoluteMonth = parts.year * 12 + (parts.month - 1) + amount;
  const year = Math.floor(absoluteMonth / 12);
  const month = (((absoluteMonth % 12) + 12) % 12) + 1;
  const day = Math.min(parts.day, daysInMonthValue(year, month));
  return formatCalendarDateKey({ year, month, day });
}

export function addCalendarYears(value: CalendarDate, amount: number): CalendarDate {
  if (!Number.isInteger(amount)) throw new RangeError("Calendar year offset must be an integer");
  return addCalendarMonths(value, amount * 12);
}

export function startOfCalendarMonth(value: CalendarDate): CalendarDate {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return formatCalendarDateKey({ ...parts, day: 1 });
}

export function endOfCalendarMonth(value: CalendarDate): CalendarDate {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return formatCalendarDateKey({ ...parts, day: daysInMonthValue(parts.year, parts.month) });
}

export function startOfCalendarYear(value: CalendarDate): CalendarDate {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return formatCalendarDateKey({ year: parts.year, month: 1, day: 1 });
}

export function endOfCalendarYear(value: CalendarDate): CalendarDate {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return formatCalendarDateKey({ year: parts.year, month: 12, day: 31 });
}

export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // Fall through to the portable IANA fallback.
  }
  return "UTC";
}

export function browserLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return locale;
  } catch {
    // Use a stable fallback below.
  }
  return "en-US";
}

function normalizedLocale(locale?: string | readonly string[]): string | readonly string[] {
  return locale ?? browserLocale();
}

function displayZone(options?: CalendarTimeFormatOptions): string {
  return options?.timeZoneId ?? options?.timeZone ?? browserTimeZone();
}

interface ZonedParts {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly minute?: number;
}

function zonedParts(instant: number, timeZoneId: string): ZonedParts | null {
  if (!Number.isFinite(instant)) return null;
  try {
    const values: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone: timeZoneId,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant))) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    return values;
  } catch {
    return null;
  }
}

/** Return the device-local date for an instant without changing the instant. */
export function calendarDateForInstant(instant: string | number, timeZoneId = browserTimeZone()): CalendarDate | null {
  const milliseconds = typeof instant === "number" ? instant : Date.parse(instant);
  const parts = zonedParts(milliseconds, timeZoneId);
  if (parts?.year === undefined || parts.month === undefined || parts.day === undefined) return null;
  const date = formatCalendarDateKey({ year: parts.year, month: parts.month, day: parts.day });
  return isCalendarDate(date) ? date : null;
}

export function todayCalendarDate(now = new Date(), timeZoneId = browserTimeZone()): CalendarDate {
  return calendarDateForInstant(now.getTime(), timeZoneId) ?? calendarDateFromUtcDate(now);
}

/** Format an instant for a datetime-local input without treating UTC fields as local fields. */
export function formatCalendarInputValue(instant: string, timeZoneId = browserTimeZone()): string {
  const parsed = Date.parse(instant);
  const parts = zonedParts(parsed, timeZoneId);
  if (
    parts?.year === undefined ||
    parts.month === undefined ||
    parts.day === undefined ||
    parts.hour === undefined ||
    parts.minute === undefined
  )
    return "";
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Parse a local datetime in an explicit IANA zone to its UTC instant. */
export function parseCalendarInput(value: string, timeZoneId = browserTimeZone()): string | null {
  const match = INPUT_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = formatCalendarDateKey({ year, month, day });
  if (!isCalendarDate(date) || hour > 23 || minute > 59) return null;

  // UTC is used only as a field tuple. The candidate check below applies the
  // zone's actual offset, including DST changes and repeated hours.
  const naive = utcFieldMillis(year, month, day, hour, minute);
  const candidates = new Set<number>();
  for (let offsetDays = -2; offsetDays <= 2; offsetDays += 1) {
    const probe = naive + offsetDays * DAY_MS;
    const parts = zonedParts(probe, timeZoneId);
    if (
      parts?.year === undefined ||
      parts.month === undefined ||
      parts.day === undefined ||
      parts.hour === undefined ||
      parts.minute === undefined
    )
      continue;
    const represented = utcFieldMillis(parts.year, parts.month, parts.day, parts.hour, parts.minute);
    const offset = probe - represented;
    const candidate = naive + offset;
    const checked = zonedParts(candidate, timeZoneId);
    if (
      checked?.year === year &&
      checked.month === month &&
      checked.day === day &&
      checked.hour === hour &&
      checked.minute === minute
    ) {
      candidates.add(candidate);
    }
  }
  if (candidates.size === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

/** Keep the exact source value when adapting service and V2 temporal shapes. */
export function rawCalendarTime(value: CalendarTimeInput | CalendarTime): string {
  if (typeof value === "string") return value;
  return value.kind === "all-day" ? value.date : value.instant;
}

export interface CalendarInputTimeOptions {
  readonly allDay: boolean;
  readonly inputTimeZoneId?: string;
  readonly eventTimeZoneId?: string;
}

/** Convert the shared editor input representation into the source CalendarTime shape. */
export function calendarTimeFromInput(value: string, options: CalendarInputTimeOptions): CalendarTime | null {
  if (options.allDay) {
    const date = value.slice(0, 10);
    return isCalendarDate(date) ? { kind: "all-day", date } : null;
  }
  const instant = parseCalendarInput(value, options.inputTimeZoneId ?? browserTimeZone());
  return instant === null ? null : { kind: "timed", instant, timeZoneId: options.eventTimeZoneId ?? browserTimeZone() };
}

export const parseCalendarDraftTime = calendarTimeFromInput;

export function formatCalendarDate(value: CalendarDate, options: CalendarTimeFormatOptions = {}): string {
  const date = dateAtUtcNoon(value);
  try {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), { dateStyle: "medium", timeZone: "UTC" }).format(
      date,
    );
  } catch {
    return value;
  }
}

export function formatAccessibleCalendarDate(value: CalendarDate, options: CalendarTimeFormatOptions = {}): string {
  const date = dateAtUtcNoon(value);
  try {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), { dateStyle: "full", timeZone: "UTC" }).format(
      date,
    );
  } catch {
    return value;
  }
}

/**
 * Format a source CalendarTime for display. All-day values are formatted as
 * UTC date-only values; timed values use the device display zone. In
 * particular, a compatibility `timeZoneId` on a timed source is not treated
 * as an IANA display zone.
 */
export function formatCalendarTime(value: CalendarTime, options: CalendarTimeFormatOptions = {}): string {
  if (value.kind === "all-day") return formatCalendarDate(value.date as CalendarDate, options);
  const instant = Date.parse(value.instant);
  if (!Number.isFinite(instant)) return value.instant;
  try {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: displayZone(options),
    }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(instant));
  }
}

export function formatCalendarClock(value: CalendarTime, options: CalendarTimeFormatOptions = {}): string {
  if (value.kind === "all-day") return "";
  const instant = Date.parse(value.instant);
  if (!Number.isFinite(instant)) return value.instant;
  try {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), {
      timeStyle: "short",
      timeZone: displayZone(options),
    }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), { timeStyle: "short", timeZone: "UTC" }).format(
      new Date(instant),
    );
  }
}

export const formatCalendarTimeOfDay = formatCalendarClock;

export function formatAccessibleCalendarTime(value: CalendarTime, options: CalendarTimeFormatOptions = {}): string {
  if (value.kind === "all-day") return formatAccessibleCalendarDate(value.date as CalendarDate, options);
  const instant = Date.parse(value.instant);
  if (!Number.isFinite(instant)) return value.instant;
  try {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: displayZone(options),
    }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat(normalizedLocale(options.locale), {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(instant));
  }
}

export function calendarDateFromTime(value: CalendarTime, timeZoneId = browserTimeZone()): CalendarDate | null {
  if (value.kind === "all-day") return isCalendarDate(value.date) ? (value.date as CalendarDate) : null;
  return calendarDateForInstant(value.instant, timeZoneId);
}

/** CLDR's firstDay is Monday=1 through Sunday=7; this API uses Sunday=0. */
export function localeWeekStart(locale = browserLocale()): number {
  try {
    const localeValue = new Intl.Locale(locale);
    const weekInfo = (localeValue as unknown as { weekInfo?: { firstDay?: number } }).weekInfo;
    if (weekInfo?.firstDay) return weekInfo.firstDay % 7;
  } catch {
    // Use the small CLDR-compatible fallback below.
  }
  const region = /[-_]([A-Z]{2}|\d{3})\b/.exec(locale)?.[1] ?? locale.split("-")[1]?.toUpperCase();
  // Regions with Sunday as their CLDR first day. Monday is the safe default.
  if (
    new Set([
      "AR",
      "AU",
      "BR",
      "CA",
      "CO",
      "DO",
      "GT",
      "HK",
      "IL",
      "JP",
      "MX",
      "NI",
      "NZ",
      "PH",
      "PR",
      "SA",
      "SG",
      "TH",
      "TW",
      "US",
      "VE",
    ]).has(region ?? "")
  )
    return 0;
  return 1;
}

export function weekStartDate(value: CalendarDate, weekStart = localeWeekStart()): CalendarDate {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  const weekday = dateAtUtcNoon(value).getUTCDay();
  return addCalendarDays(value, -((weekday - weekStart + 7) % 7));
}

export function calendarWeekday(value: CalendarDate): number {
  return dateAtUtcNoon(value).getUTCDay();
}

/** Retained for tests and callers that need a date-only UTC boundary. */
export function calendarDateToUtcMillis(value: CalendarDate): number {
  return dateAtUtcNoon(value).getTime();
}

/** Locale-aware weekday labels used by every multi-column calendar renderer. */
export function weekdayShortLabel(value: CalendarDate, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale ?? browserLocale(), { weekday: "short", timeZone: "UTC" }).format(
      dateAtUtcNoon(value),
    );
  } catch {
    return "";
  }
}
