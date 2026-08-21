import type {
  CalendarImportance,
  CalendarOccurrence,
  CalendarReadScope,
} from "../../services/calendar-api.ts";
import {
  type CalendarPreferences,
  type CalendarViewMode,
  DEFAULT_CALENDAR_SCOPES,
  isCalendarDate,
} from "./calendar-preferences.ts";

export type { CalendarViewMode } from "./calendar-preferences.ts";

export interface CalendarInterval {
  readonly from: string;
  readonly to: string;
}

export type CalendarFilters = Pick<CalendarPreferences, "scopes" | "groups" | "tags" | "importance" | "search">;

export interface CalendarFacets {
  readonly scopes: readonly CalendarReadScope[];
  readonly groups: readonly string[];
  readonly tags: readonly string[];
  readonly importance: readonly CalendarImportance[];
}

/**
 * This is intentionally a presentation-neutral model. Canvas tasks can add
 * cells/agenda density models without making the controller own filtering or
 * interval math.
 */
export interface CalendarViewProjection {
  readonly view: CalendarViewMode;
  readonly interval: CalendarInterval;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly filteredOccurrences: readonly CalendarOccurrence[];
  readonly count: number;
}

export interface CalendarDerivedProjection {
  readonly filteredOccurrences: readonly CalendarOccurrence[];
  readonly facets: CalendarFacets;
  readonly projection: CalendarViewProjection;
}

const IMPORTANCE_ORDER: readonly CalendarImportance[] = ["normal", "important", "pinned"];
const SCOPE_ORDER: readonly CalendarReadScope[] = ["private", "household", "all"];

function dateAtUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return Number.NaN;
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value.getTime();
}

function dateFromUtc(value: number): string {
  const date = new Date(value);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addCalendarDays(date: string, amount: number): string {
  if (!isCalendarDate(date)) return date;
  return dateFromUtc(dateAtUtc(date) + amount * 86_400_000);
}

function daysInMonth(year: number, monthIndex: number): number {
  const value = new Date(0);
  value.setUTCFullYear(year, monthIndex + 1, 0);
  return value.getUTCDate();
}

function monthDate(date: string, amount: number): string {
  const value = new Date(dateAtUtc(date));
  const originalDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + amount);
  value.setUTCDate(Math.min(originalDay, daysInMonth(value.getUTCFullYear(), value.getUTCMonth())));
  return dateFromUtc(value.getTime());
}

/** Monday is the product default; callers can supply the locale's week start. */
export function calendarIntervalFor(
  view: CalendarViewMode,
  anchorDate: string,
  weekStartsOn = 1,
): CalendarInterval {
  const safeAnchor = isCalendarDate(anchorDate) ? anchorDate : "1970-01-01";
  if (view === "day") return { from: safeAnchor, to: safeAnchor };
  if (view === "year") return { from: `${safeAnchor.slice(0, 4)}-01-01`, to: `${safeAnchor.slice(0, 4)}-12-31` };

  const anchor = new Date(dateAtUtc(safeAnchor));
  const first = view === "month"
    ? `${safeAnchor.slice(0, 7)}-01`
    : safeAnchor;
  const firstDate = new Date(dateAtUtc(first));
  const weekday = firstDate.getUTCDay();
  const normalizedWeekStart = weekStartsOn === 0 ? 0 : 1;
  const offset = (weekday - normalizedWeekStart + 7) % 7;
  if (view === "week") {
    const from = addCalendarDays(safeAnchor, -((anchor.getUTCDay() - normalizedWeekStart + 7) % 7));
    return { from, to: addCalendarDays(from, 6) };
  }
  const from = addCalendarDays(first, -offset);
  return { from, to: addCalendarDays(from, 41) };
}

export function stepCalendarAnchor(view: CalendarViewMode, anchorDate: string, direction: -1 | 1): string {
  const safeAnchor = isCalendarDate(anchorDate) ? anchorDate : "1970-01-01";
  if (view === "day") return addCalendarDays(safeAnchor, direction);
  if (view === "week") return addCalendarDays(safeAnchor, direction * 7);
  if (view === "month") return monthDate(safeAnchor, direction);
  const value = new Date(dateAtUtc(safeAnchor));
  value.setUTCFullYear(value.getUTCFullYear() + direction);
  return dateFromUtc(value.getTime());
}

function occurrenceScope(event: CalendarOccurrence): CalendarReadScope | undefined {
  return event.scope === "private" || event.scope === "household" ? event.scope : undefined;
}

function occurrenceText(event: CalendarOccurrence): string {
  return `${event.title}\u0000${event.description ?? ""}`.toLocaleLowerCase();
}

/** Pure local intersection of selected filters over the complete authorized set. */
export function filterCalendarOccurrences(
  occurrences: readonly CalendarOccurrence[],
  filters: CalendarFilters,
): CalendarOccurrence[] {
  const scopes = filters.scopes.length ? filters.scopes : DEFAULT_CALENDAR_SCOPES;
  const hasAllScope = scopes.includes("all");
  const groups = new Set(filters.groups);
  const tags = new Set(filters.tags);
  const search = filters.search.trim().toLocaleLowerCase();
  return occurrences.filter((event) => {
    const scope = occurrenceScope(event);
    if (!hasAllScope && (scope === undefined || !scopes.includes(scope))) return false;
    if (groups.size > 0 && (event.group === undefined || !groups.has(event.group))) return false;
    if (tags.size > 0 && !filters.tags.every((tag) => event.tags.includes(tag))) return false;
    if (filters.importance !== null && event.importance !== filters.importance) return false;
    if (search && !occurrenceText(event).includes(search)) return false;
    return true;
  });
}

/** Derive supported facet values from authorized content, retaining selections that are absent. */
export function deriveCalendarFacets(
  occurrences: readonly CalendarOccurrence[],
  filters: CalendarFilters,
): CalendarFacets {
  const scopes = new Set<CalendarReadScope>(["all", ...filters.scopes]);
  const groups = new Set(filters.groups);
  const tags = new Set(filters.tags);
  const importance = new Set<CalendarImportance>(filters.importance ? [filters.importance] : []);
  for (const event of occurrences) {
    const scope = occurrenceScope(event);
    if (scope) scopes.add(scope);
    if (event.group) groups.add(event.group);
    for (const tag of event.tags) tags.add(tag);
    importance.add(event.importance);
  }
  return {
    scopes: SCOPE_ORDER.filter((scope) => scopes.has(scope)),
    groups: [...groups].sort((a, b) => a.localeCompare(b)),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    importance: IMPORTANCE_ORDER.filter((value) => importance.has(value)),
  };
}

export function projectCalendarInterval(
  view: CalendarViewMode,
  interval: CalendarInterval,
  occurrences: readonly CalendarOccurrence[],
  filteredOccurrences: readonly CalendarOccurrence[],
): CalendarViewProjection {
  return {
    view,
    interval,
    occurrences,
    filteredOccurrences,
    count: filteredOccurrences.length,
  };
}

/** Single pure derivation seam for consumers that need all derived values at once. */
export function deriveCalendarProjection(
  view: CalendarViewMode,
  interval: CalendarInterval,
  occurrences: readonly CalendarOccurrence[],
  filters: CalendarFilters,
): CalendarDerivedProjection {
  const filteredOccurrences = filterCalendarOccurrences(occurrences, filters);
  const facets = deriveCalendarFacets(occurrences, filters);
  const projection = projectCalendarInterval(view, interval, occurrences, filteredOccurrences);
  return { filteredOccurrences, facets, projection };
}

export const applyCalendarFilters = filterCalendarOccurrences;
export const deriveCalendarFacetOptions = deriveCalendarFacets;
export const getCalendarVisibleInterval = calendarIntervalFor;
export const stepCalendarDate = stepCalendarAnchor;
