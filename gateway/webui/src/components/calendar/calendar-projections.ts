import type { CalendarImportance, CalendarOccurrence, CalendarReadScope } from "../../services/calendar-api.ts";
import { projectCalendarDensity } from "./calendar-density.ts";
import { deriveCalendarProjection as deriveRichCalendarProjection } from "./calendar-filters.ts";
import { compareProjectedCalendarOccurrences, projectCalendarOccurrences } from "./calendar-occurrence.ts";
import type {
  CalendarDateCell,
  CalendarDayProjection,
  CalendarFilteredProjection,
  CalendarMonthProjection,
  CalendarNavigationState,
  CalendarOccurrenceInput,
  CalendarProjectionOptions,
  CalendarProjectionRequest,
  CalendarProjectionResult,
  CalendarView,
  CalendarWeekProjection,
  CalendarWeekdayIndex,
  CalendarYearMonthProjection,
  CalendarYearProjection,
  ProjectedCalendarOccurrence,
  CalendarFilters as RichCalendarFilters,
  CalendarInterval as RichCalendarInterval,
  CalendarViewProjection as RichCalendarViewProjection,
} from "./calendar-projection-types.ts";
import {
  type CalendarDate,
  type CalendarDateParts,
  addCalendarDays,
  addCalendarMonths,
  addCalendarYears,
  browserLocale,
  browserTimeZone,
  daysInMonth,
  formatAccessibleCalendarDate,
  isCalendarDate,
  localeWeekStart,
  parseCalendarDate,
  startOfCalendarMonth,
  startOfCalendarYear,
  todayCalendarDate,
  weekStartDate,
} from "./calendar-time.ts";

export * from "./calendar-projection-types.ts";
export * from "./calendar-filters.ts";
export * from "./calendar-density.ts";
export * from "./calendar-occurrence.ts";
export * from "./calendar-time.ts";

function validDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) throw new RangeError(`Invalid calendar date: ${value}`);
  return value;
}

function dateParts(value: CalendarDate): CalendarDateParts {
  const parts = parseCalendarDate(value);
  if (!parts) throw new RangeError(`Invalid calendar date: ${value}`);
  return parts;
}

function zoneFromOptions(options: CalendarProjectionOptions = {}): string {
  return options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId ?? browserTimeZone();
}

function localeFromOptions(options: CalendarProjectionOptions = {}): string {
  return options.locale ?? browserLocale();
}

function todayFromOptions(options: CalendarProjectionOptions, timeZone: string): CalendarDate {
  return options.today !== undefined ? validDate(options.today) : todayCalendarDate(new Date(), timeZone);
}

function selectedFromOptions(anchorDate: CalendarDate, options: CalendarProjectionOptions): CalendarDate {
  return options.selectedDate === undefined ? anchorDate : validDate(options.selectedDate);
}

function sorted(events: readonly ProjectedCalendarOccurrence[]): ProjectedCalendarOccurrence[] {
  return [...events].sort(compareProjectedCalendarOccurrences);
}

type CalendarProjectionRows = readonly (CalendarOccurrenceInput | ProjectedCalendarOccurrence)[];

function isProjectedRow(
  value: CalendarOccurrenceInput | ProjectedCalendarOccurrence,
): value is ProjectedCalendarOccurrence {
  return Boolean(value && typeof value === "object" && "source" in value && "accessibleName" in value);
}

function materializeRows(
  rows: CalendarProjectionRows,
  options: CalendarProjectionOptions,
): readonly ProjectedCalendarOccurrence[] {
  if (rows.every(isProjectedRow)) return rows as readonly ProjectedCalendarOccurrence[];
  const displayOptions = {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...((options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId) !== undefined
      ? { timeZone: options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId }
      : {}),
    ...(options.deviceTimeZone !== undefined ? { deviceTimeZone: options.deviceTimeZone } : {}),
  };
  return projectCalendarOccurrences(rows as readonly CalendarOccurrenceInput[], displayOptions);
}

function dateEvents(events: readonly ProjectedCalendarOccurrence[], date: CalendarDate): ProjectedCalendarOccurrence[] {
  return sorted(events.filter((event) => event.start.localDate === date));
}

function groupAgenda(
  events: readonly ProjectedCalendarOccurrence[],
  from?: CalendarDate,
  to?: CalendarDate,
  locale = browserLocale(),
) {
  const grouped = new Map<CalendarDate, ProjectedCalendarOccurrence[]>();
  for (const event of sorted(events)) {
    const date = event.start.localDate;
    if (from !== undefined && date < from) continue;
    if (to !== undefined && date > to) continue;
    const current = grouped.get(date) ?? [];
    current.push(event);
    grouped.set(date, current);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateRows]) => ({
      date,
      label: formatAccessibleCalendarDate(date, { locale }),
      events: dateRows,
    }));
}

function cell(
  date: CalendarDate,
  month: number,
  year: number,
  events: readonly ProjectedCalendarOccurrence[],
  options: CalendarProjectionOptions,
): CalendarDateCell {
  const parts = parseCalendarDate(date);
  if (!parts) throw new RangeError(`Invalid calendar date: ${date}`);
  const today = todayFromOptions(options, zoneFromOptions(options));
  const selectedDate = selectedFromOptions(date, options);
  const outsideMonth = parts.month !== month || parts.year !== year;
  const selected = date === selectedDate;
  const isToday = date === today;
  const baseLabel = formatAccessibleCalendarDate(date, { locale: localeFromOptions(options) });
  const states = [
    isToday ? "today" : "",
    selected ? "selected" : "",
    outsideMonth ? "outside current month" : "",
  ].filter(Boolean);
  const accessibleLabel = states.length > 0 ? `${baseLabel}, ${states.join(", ")}` : baseLabel;
  const density = projectCalendarDensity(events, {
    ...options.density,
    dateLabel: baseLabel,
  });
  return {
    date,
    day: parts.day,
    month: parts.month,
    year: parts.year,
    outsideMonth,
    selected,
    today: isToday,
    accessibleLabel,
    events,
    eventCount: events.length,
    indicators: density.indicators,
    overflowCount: density.overflowCount,
    overflowEvents: density.overflowEvents.map((presentation) => presentation.event),
    density,
  };
}

function cellsForMonth(
  year: number,
  month: number,
  events: readonly ProjectedCalendarOccurrence[],
  options: CalendarProjectionOptions,
): CalendarDateCell[] {
  const first = formatDate(year, month, 1);
  const weekStart = options.weekStartsOn ?? (localeWeekStart(localeFromOptions(options)) as CalendarWeekdayIndex);
  const firstCell = weekStartDate(first, weekStart);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addCalendarDays(firstCell, index);
    return cell(date, month, year, dateEvents(events, date), options);
  });
}

function formatDate(year: number, month: number, day: number): CalendarDate {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return validDate(value);
}

function intervalForView(
  view: CalendarView,
  anchorDate: CalendarDate,
  weekStartsOn: CalendarWeekdayIndex,
): RichCalendarInterval {
  if (view === "day") return { from: anchorDate, to: anchorDate };
  if (view === "week") {
    const from = weekStartDate(anchorDate, weekStartsOn);
    return { from, to: addCalendarDays(from, 6) };
  }
  if (view === "month") {
    return {
      from: startOfCalendarMonth(anchorDate),
      to: (() => {
        const parts = dateParts(anchorDate);
        return formatDate(parts.year, parts.month, daysInMonth(parts.year, parts.month));
      })(),
    };
  }
  return {
    from: startOfCalendarYear(anchorDate),
    to: (() => {
      const parts = dateParts(anchorDate);
      return formatDate(parts.year, 12, 31);
    })(),
  };
}

export function calendarVisibleInterval(
  viewOrState: CalendarView | CalendarNavigationState,
  anchorDate?: CalendarDate,
  options: Pick<CalendarProjectionOptions, "locale" | "weekStartsOn"> = {},
): RichCalendarInterval {
  const view = typeof viewOrState === "string" ? viewOrState : viewOrState.view;
  const anchor = validDate(
    typeof viewOrState === "string" ? (anchorDate ?? todayCalendarDate()) : viewOrState.anchorDate,
  );
  const weekStart =
    options.weekStartsOn ?? (localeWeekStart(options.locale ?? browserLocale()) as CalendarWeekdayIndex);
  return intervalForView(view, anchor, weekStart);
}

export interface CreateCalendarNavigationOptions extends CalendarProjectionOptions {
  readonly view?: CalendarView;
  readonly anchorDate?: CalendarDate;
}

export function createCalendarNavigationState(options: CreateCalendarNavigationOptions = {}): CalendarNavigationState {
  const zone = zoneFromOptions(options);
  const today = todayFromOptions(options, zone);
  const anchorDate = validDate(options.anchorDate ?? today);
  const selectedDate = selectedFromOptions(anchorDate, options);
  return { view: options.view ?? "month", anchorDate, selectedDate };
}

export const createCalendarProjectionState = createCalendarNavigationState;

/** Move the visible interval; selectedDate intentionally remains an explicit selection. */
export function stepCalendar(state: CalendarNavigationState, direction: -1 | 1): CalendarNavigationState {
  const anchorDate =
    state.view === "day"
      ? addCalendarDays(state.anchorDate, direction)
      : state.view === "week"
        ? addCalendarDays(state.anchorDate, direction * 7)
        : state.view === "month"
          ? addCalendarMonths(state.anchorDate, direction)
          : addCalendarYears(state.anchorDate, direction);
  return { ...state, anchorDate };
}

export function previousCalendarInterval(state: CalendarNavigationState): CalendarNavigationState {
  return stepCalendar(state, -1);
}

export function nextCalendarInterval(state: CalendarNavigationState): CalendarNavigationState {
  return stepCalendar(state, 1);
}

export const previousCalendar = previousCalendarInterval;
export const nextCalendar = nextCalendarInterval;
export const navigateCalendar = stepCalendar;

export function todayCalendar(state: CalendarNavigationState, date = todayCalendarDate()): CalendarNavigationState {
  const today = validDate(date);
  return { ...state, anchorDate: today, selectedDate: today };
}

export const goToCalendarToday = todayCalendar;
export const goToToday = todayCalendar;

export function selectCalendarDate(state: CalendarNavigationState, date: CalendarDate): CalendarNavigationState {
  const selectedDate = validDate(date);
  // A Month cell is a navigation target for the focused Day agenda. Week
  // selection keeps the seven-column view active; the other views retain their
  // explicit view until their dedicated navigation action is used.
  const view = state.view === "month" ? "day" : state.view;
  return { ...state, view, anchorDate: selectedDate, selectedDate };
}

export function selectCalendarMonth(state: CalendarNavigationState, date: CalendarDate): CalendarNavigationState {
  const selectedDate = validDate(date);
  const anchorDate = startOfCalendarMonth(selectedDate);
  return { ...state, view: "month", anchorDate, selectedDate };
}

export function setCalendarView(state: CalendarNavigationState, view: CalendarView): CalendarNavigationState {
  return { ...state, view };
}

export const getCalendarInterval = calendarVisibleInterval;
export const getVisibleCalendarInterval = calendarVisibleInterval;

export function getCalendarWeekDates(
  anchorDate: CalendarDate,
  options: Pick<CalendarProjectionOptions, "locale" | "weekStartsOn"> = {},
): CalendarDate[] {
  const weekStart =
    options.weekStartsOn ?? (localeWeekStart(options.locale ?? browserLocale()) as CalendarWeekdayIndex);
  const first = weekStartDate(validDate(anchorDate), weekStart);
  return Array.from({ length: 7 }, (_, index) => addCalendarDays(first, index));
}

export const getWeekDates = getCalendarWeekDates;

export function selectCalendarYearMonth(
  state: CalendarNavigationState,
  year: number,
  month: number,
): CalendarNavigationState {
  const date = formatDate(year, month, 1);
  return { ...state, view: "month", anchorDate: date, selectedDate: date };
}

function projectionOptions(options: CalendarProjectionOptions, selectedDate: CalendarDate): CalendarProjectionOptions {
  return { ...options, selectedDate };
}

function buildDayProjection(
  projected: readonly ProjectedCalendarOccurrence[],
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions,
): CalendarDayProjection {
  const date = validDate(anchorDate);
  const selectedDate = selectedFromOptions(date, options);
  const today = todayFromOptions(options, zoneFromOptions(options));
  const events = dateEvents(projected, date);
  const accessibleLabel = formatAccessibleCalendarDate(date, { locale: localeFromOptions(options) });
  const density = projectCalendarDensity(events, { ...options.density, dateLabel: accessibleLabel });
  return {
    kind: "day",
    view: "day",
    anchorDate: date,
    selectedDate,
    today,
    locale: localeFromOptions(options),
    interval: { from: date, to: date },
    date,
    selected: date === selectedDate,
    isToday: date === today,
    accessibleLabel,
    events,
    density,
    agenda: [{ date, label: accessibleLabel, events }],
  };
}

function buildWeekProjection(
  projected: readonly ProjectedCalendarOccurrence[],
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions,
): CalendarWeekProjection {
  const anchor = validDate(anchorDate);
  const selectedDate = selectedFromOptions(anchor, options);
  const today = todayFromOptions(options, zoneFromOptions(options));
  const weekStartsOn = options.weekStartsOn ?? (localeWeekStart(localeFromOptions(options)) as CalendarWeekdayIndex);
  const from = weekStartDate(anchor, weekStartsOn);
  const dates = Array.from({ length: 7 }, (_, index) => addCalendarDays(from, index));
  const cells = dates.map((date) => {
    const cellOptions = projectionOptions(options, selectedDate);
    return cell(date, dateParts(date).month, dateParts(date).year, dateEvents(projected, date), cellOptions);
  });
  return {
    kind: "week",
    view: "week",
    anchorDate: anchor,
    selectedDate,
    today,
    locale: localeFromOptions(options),
    interval: { from, to: addCalendarDays(from, 6) },
    weekStartsOn,
    dates,
    cells,
    agenda: groupAgenda(projected, from, addCalendarDays(from, 6), localeFromOptions(options)),
  };
}

function buildMonthProjection(
  projected: readonly ProjectedCalendarOccurrence[],
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions,
): CalendarMonthProjection {
  const anchor = validDate(anchorDate);
  const parts = dateParts(anchor);
  const selectedDate = selectedFromOptions(anchor, options);
  const weekStartsOn = options.weekStartsOn ?? (localeWeekStart(localeFromOptions(options)) as CalendarWeekdayIndex);
  const cells = cellsForMonth(parts.year, parts.month, projected, { ...options, selectedDate, weekStartsOn });
  const weeks = Array.from({ length: 6 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
  const from = startOfCalendarMonth(anchor);
  const to = formatDate(parts.year, parts.month, daysInMonth(parts.year, parts.month));
  return {
    kind: "month",
    view: "month",
    anchorDate: anchor,
    selectedDate,
    today: todayFromOptions(options, zoneFromOptions(options)),
    locale: localeFromOptions(options),
    interval: { from, to },
    month: parts.month,
    year: parts.year,
    weekStartsOn,
    cells,
    weeks,
    agenda: groupAgenda(projected, from, to, localeFromOptions(options)),
  };
}

function yearMonth(
  year: number,
  month: number,
  projected: readonly ProjectedCalendarOccurrence[],
  options: CalendarProjectionOptions,
): CalendarYearMonthProjection {
  const first = formatDate(year, month, 1);
  const last = formatDate(year, month, daysInMonth(year, month));
  const dates = Array.from({ length: daysInMonth(year, month) }, (_, index) => addCalendarDays(first, index));
  const selectedDate = selectedFromOptions(first, options);
  const days = dates.map((date) => cell(date, month, year, dateEvents(projected, date), { ...options, selectedDate }));
  const eventCount = days.reduce((count, day) => count + day.events.length, 0);
  const label = new Intl.DateTimeFormat(localeFromOptions(options), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.parse(`${first}T12:00:00.000Z`)));
  const selectedParts = dateParts(selectedDate);
  return {
    month,
    year,
    label,
    interval: { from: first, to: last },
    dates,
    days,
    eventCount,
    selected: selectedParts.year === year && selectedParts.month === month,
  };
}

function buildYearProjection(
  projected: readonly ProjectedCalendarOccurrence[],
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions,
): CalendarYearProjection {
  const anchor = validDate(anchorDate);
  const parts = dateParts(anchor);
  const selectedDate = selectedFromOptions(anchor, options);
  const today = todayFromOptions(options, zoneFromOptions(options));
  const months = Array.from({ length: 12 }, (_, index) =>
    yearMonth(parts.year, index + 1, projected, { ...options, selectedDate }),
  );
  const weekStartsOn = options.weekStartsOn ?? (localeWeekStart(localeFromOptions(options)) as CalendarWeekdayIndex);
  return {
    kind: "year",
    view: "year",
    anchorDate: anchor,
    selectedDate,
    today,
    locale: localeFromOptions(options),
    interval: { from: formatDate(parts.year, 1, 1), to: formatDate(parts.year, 12, 31) },
    weekStartsOn,
    months,
  };
}

export function projectDay(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): CalendarDayProjection {
  return buildDayProjection(materializeRows(rows, options), anchorDate, options);
}

export function projectWeek(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): CalendarWeekProjection {
  return buildWeekProjection(materializeRows(rows, options), anchorDate, options);
}

export function projectMonth(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): CalendarMonthProjection {
  return buildMonthProjection(materializeRows(rows, options), anchorDate, options);
}

export function projectYear(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): CalendarYearProjection {
  return buildYearProjection(materializeRows(rows, options), anchorDate, options);
}

export function getMonthCells(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): readonly CalendarDateCell[] {
  return projectMonth(rows, anchorDate, options).cells;
}

export function getYearMonths(
  rows: CalendarProjectionRows,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): readonly CalendarYearMonthProjection[] {
  return projectYear(rows, anchorDate, options).months;
}

/** Project already-filtered rows when a controller has invoked the filter seam. */
export function projectCalendarView(
  rows: CalendarProjectionRows,
  view: CalendarView,
  anchorDate: CalendarDate,
  options: CalendarProjectionOptions = {},
): RichCalendarViewProjection {
  const projectedOccurrences = materializeRows(rows, options);
  if (view === "day") return buildDayProjection(projectedOccurrences, anchorDate, options);
  if (view === "week") return buildWeekProjection(projectedOccurrences, anchorDate, options);
  if (view === "month") return buildMonthProjection(projectedOccurrences, anchorDate, options);
  return buildYearProjection(projectedOccurrences, anchorDate, options);
}

export function projectCalendar(request: CalendarProjectionRequest): CalendarProjectionResult {
  const filtered: CalendarFilteredProjection = deriveRichCalendarProjection(
    request.occurrences,
    request.filters ?? {},
    request,
  );
  const requestedZone = request.timeZone ?? request.deviceTimeZone ?? request.timeZoneId;
  const options: CalendarProjectionOptions = {
    ...(request.locale !== undefined ? { locale: request.locale } : {}),
    ...(requestedZone !== undefined ? { timeZone: requestedZone } : {}),
    ...(request.deviceTimeZone !== undefined ? { deviceTimeZone: request.deviceTimeZone } : {}),
    ...(request.weekStartsOn !== undefined ? { weekStartsOn: request.weekStartsOn } : {}),
    ...(request.today !== undefined ? { today: request.today } : {}),
    ...(request.selectedDate !== undefined ? { selectedDate: request.selectedDate } : {}),
    ...(request.density !== undefined ? { density: request.density } : {}),
  };
  const view = projectCalendarView(filtered.projectedOccurrences, request.view, request.anchorDate, options);
  return { ...filtered, view };
}

export function projectCalendarState(
  occurrences: readonly CalendarOccurrenceInput[],
  state: CalendarNavigationState,
  filters: RichCalendarFilters = {},
  options: CalendarProjectionOptions = {},
): CalendarProjectionResult {
  return projectCalendar({
    ...options,
    occurrences,
    view: state.view,
    anchorDate: state.anchorDate,
    selectedDate: state.selectedDate,
    filters,
  });
}

export const projectCalendarFromState = projectCalendarState;

export interface PositionalCalendarProjectionOptions extends CalendarProjectionOptions {
  readonly filters?: RichCalendarFilters;
}

/** Convenience positional seam for controller/canvas callers. */
export function projectCalendarOccurrencesForView(
  occurrences: readonly CalendarOccurrenceInput[],
  view: CalendarView,
  anchorDate: CalendarDate,
  options: PositionalCalendarProjectionOptions = {},
): CalendarProjectionResult {
  return projectCalendar({
    ...options,
    occurrences,
    view,
    anchorDate,
    ...(options.filters !== undefined ? { filters: options.filters } : {}),
  });
}

export function projectDayFromOccurrences(
  occurrences: readonly CalendarOccurrenceInput[],
  anchorDate: CalendarDate,
  options: PositionalCalendarProjectionOptions = {},
): CalendarDayProjection {
  return projectCalendarOccurrencesForView(occurrences, "day", anchorDate, options).view as CalendarDayProjection;
}

export function projectWeekFromOccurrences(
  occurrences: readonly CalendarOccurrenceInput[],
  anchorDate: CalendarDate,
  options: PositionalCalendarProjectionOptions = {},
): CalendarWeekProjection {
  return projectCalendarOccurrencesForView(occurrences, "week", anchorDate, options).view as CalendarWeekProjection;
}

export function projectMonthFromOccurrences(
  occurrences: readonly CalendarOccurrenceInput[],
  anchorDate: CalendarDate,
  options: PositionalCalendarProjectionOptions = {},
): CalendarMonthProjection {
  return projectCalendarOccurrencesForView(occurrences, "month", anchorDate, options).view as CalendarMonthProjection;
}

export function projectYearFromOccurrences(
  occurrences: readonly CalendarOccurrenceInput[],
  anchorDate: CalendarDate,
  options: PositionalCalendarProjectionOptions = {},
): CalendarYearProjection {
  return projectCalendarOccurrencesForView(occurrences, "year", anchorDate, options).view as CalendarYearProjection;
}

export const dayProjection = projectDayFromOccurrences;
export const weekProjection = projectWeekFromOccurrences;
export const monthProjection = projectMonthFromOccurrences;
export const yearProjection = projectYearFromOccurrences;

// The controller contribution consumes a deliberately smaller, source-row
// projection seam. Keep it alongside the rich canvas projection above so both
// callers share date/filter behavior without making the controller own canvas
// density or localized event presentation.
export type CalendarViewMode = CalendarView;

export interface CalendarInterval {
  readonly from: string;
  readonly to: string;
}

export interface CalendarFilters {
  readonly scope?: CalendarReadScope;
  readonly scopes?: readonly CalendarReadScope[];
  readonly group?: string;
  readonly groups?: readonly string[];
  readonly tags?: readonly string[];
  readonly importance?: CalendarImportance | readonly CalendarImportance[] | null;
  readonly importanceValues?: readonly CalendarImportance[];
  readonly text?: string;
  readonly query?: string;
  readonly search?: string;
}

export interface CalendarFacets {
  readonly scopes: readonly CalendarReadScope[];
  readonly groups: readonly string[];
  readonly tags: readonly string[];
  readonly importance: readonly CalendarImportance[];
}

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

const CONTROLLER_IMPORTANCE_ORDER: readonly CalendarImportance[] = ["normal", "important", "pinned"];
const CONTROLLER_SCOPE_ORDER: readonly CalendarReadScope[] = ["private", "household", "all"];

function controllerScopes(filters: CalendarFilters): readonly CalendarReadScope[] | undefined {
  const values = filters.scopes ?? (filters.scope === undefined ? undefined : [filters.scope]);
  if (values === undefined) return undefined;
  return [...new Set(values)].filter(
    (value): value is CalendarReadScope => value === "private" || value === "household" || value === "all",
  );
}

function controllerGroups(filters: CalendarFilters): readonly string[] {
  return [...new Set(filters.groups ?? (filters.group === undefined ? [] : [filters.group]))].filter(
    (value) => value.length > 0,
  );
}

function controllerImportance(filters: CalendarFilters): readonly CalendarImportance[] {
  const source =
    filters.importanceValues ??
    (filters.importance === undefined || filters.importance === null
      ? []
      : Array.isArray(filters.importance)
        ? filters.importance
        : [filters.importance]);
  return [...new Set(source)].filter((value): value is CalendarImportance =>
    CONTROLLER_IMPORTANCE_ORDER.includes(value),
  );
}

function controllerSearch(filters: CalendarFilters): string {
  return (filters.search ?? filters.text ?? filters.query ?? "").trim().toLocaleLowerCase();
}

/** Adapter for the controller's preference-shaped filters to the rich filter model. */
function richFilters(filters: CalendarFilters): RichCalendarFilters {
  const importance = filters.importance === null ? undefined : filters.importance;
  const text = filters.text ?? filters.query ?? filters.search;
  return {
    ...(filters.scope !== undefined ? { scope: filters.scope } : {}),
    ...(filters.scopes !== undefined ? { scopes: filters.scopes } : {}),
    ...(filters.group !== undefined ? { group: filters.group } : {}),
    ...(filters.groups !== undefined ? { groups: filters.groups } : {}),
    ...(filters.tags !== undefined ? { tags: filters.tags } : {}),
    ...(importance !== undefined ? { importance } : {}),
    ...(filters.importanceValues !== undefined ? { importanceValues: filters.importanceValues } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function controllerText(event: CalendarOccurrence): string {
  return `${event.title}\u0000${event.description ?? ""}`.toLocaleLowerCase();
}

/** Filter only the complete authorized source rows; this never fetches a subset. */
export function filterCalendarOccurrences(
  occurrences: readonly CalendarOccurrence[],
  filters: CalendarFilters = {},
): CalendarOccurrence[] {
  const scopes = controllerScopes(filters);
  const groups = new Set(controllerGroups(filters));
  const tags = new Set(filters.tags ?? []);
  const importance = controllerImportance(filters);
  const search = controllerSearch(filters);
  return occurrences.filter((event) => {
    if (scopes !== undefined && !scopes.includes("all") && !scopes.includes(event.scope)) return false;
    if (groups.size > 0 && (event.group === undefined || !groups.has(event.group))) return false;
    if (tags.size > 0 && !(filters.tags ?? []).every((tag) => event.tags.includes(tag))) return false;
    if (importance.length > 0 && !importance.includes(event.importance)) return false;
    if (search && !controllerText(event).includes(search)) return false;
    return true;
  });
}

/** Derive facet values from complete authorized rows, retaining selected empty values. */
export function deriveCalendarFacets(
  occurrences: readonly CalendarOccurrence[],
  filters: CalendarFilters = {},
): CalendarFacets {
  const selectedScopes = controllerScopes(filters) ?? [];
  const scopes = new Set<CalendarReadScope>(["all", ...selectedScopes]);
  const groups = new Set(controllerGroups(filters));
  const tags = new Set(filters.tags ?? []);
  const importance = new Set<CalendarImportance>(controllerImportance(filters));
  for (const event of occurrences) {
    scopes.add(event.scope);
    if (event.group) groups.add(event.group);
    for (const tag of event.tags) tags.add(tag);
    importance.add(event.importance);
  }
  return {
    scopes: CONTROLLER_SCOPE_ORDER.filter((scope) => scopes.has(scope)),
    groups: [...groups].sort((a, b) => a.localeCompare(b)),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    importance: CONTROLLER_IMPORTANCE_ORDER.filter((value) => importance.has(value)),
  };
}

export function calendarIntervalFor(
  view: CalendarViewMode,
  anchorDate: string,
  weekStartsOn: 0 | 1 = 1,
): CalendarInterval {
  const safeAnchor = (isCalendarDate(anchorDate) ? anchorDate : "1970-01-01") as CalendarDate;
  if (view === "day") return { from: safeAnchor, to: safeAnchor };
  if (view === "year") return { from: `${safeAnchor.slice(0, 4)}-01-01`, to: `${safeAnchor.slice(0, 4)}-12-31` };

  const normalizedWeekStart = weekStartsOn === 0 ? 0 : 1;
  if (view === "week") {
    const from = weekStartDate(safeAnchor, normalizedWeekStart as CalendarWeekdayIndex);
    return { from, to: addCalendarDays(from, 6) };
  }

  // Month data covers the six-week canvas window, including outside-month cells.
  const first = startOfCalendarMonth(safeAnchor);
  const from = weekStartDate(first, normalizedWeekStart as CalendarWeekdayIndex);
  return { from, to: addCalendarDays(from, 41) };
}

export function stepCalendarAnchor(view: CalendarViewMode, anchorDate: string, direction: -1 | 1): string {
  const safeAnchor = (isCalendarDate(anchorDate) ? anchorDate : "1970-01-01") as CalendarDate;
  if (view === "day") return addCalendarDays(safeAnchor, direction);
  if (view === "week") return addCalendarDays(safeAnchor, direction * 7);
  if (view === "month") return addCalendarMonths(safeAnchor, direction);
  return addCalendarYears(safeAnchor, direction);
}

export function projectCalendarInterval(
  view: CalendarViewMode,
  interval: CalendarInterval,
  occurrences: readonly CalendarOccurrence[],
  filteredOccurrences: readonly CalendarOccurrence[],
): CalendarViewProjection {
  return { view, interval, occurrences, filteredOccurrences, count: filteredOccurrences.length };
}

export function deriveCalendarProjection(
  occurrences: readonly CalendarOccurrenceInput[],
  filters?: CalendarFilters | RichCalendarFilters,
  options?: CalendarProjectionOptions,
): CalendarFilteredProjection;
export function deriveCalendarProjection(
  view: CalendarViewMode,
  interval: CalendarInterval,
  occurrences: readonly CalendarOccurrence[],
  filters?: CalendarFilters,
): CalendarDerivedProjection;
export function deriveCalendarProjection(
  first: CalendarViewMode | readonly CalendarOccurrenceInput[],
  second: CalendarFilters | RichCalendarFilters | CalendarInterval = {},
  third: CalendarProjectionOptions | readonly CalendarOccurrence[] = {},
  fourth: CalendarFilters = {},
): CalendarFilteredProjection | CalendarDerivedProjection {
  if (typeof first === "string") {
    const interval = second as CalendarInterval;
    const occurrences = third as readonly CalendarOccurrence[];
    const filteredOccurrences = filterCalendarOccurrences(occurrences, fourth);
    return {
      filteredOccurrences,
      facets: deriveCalendarFacets(occurrences, fourth),
      projection: projectCalendarInterval(first, interval, occurrences, filteredOccurrences),
    };
  }
  return deriveRichCalendarProjection(
    first,
    richFilters((second ?? {}) as CalendarFilters),
    (third ?? {}) as CalendarProjectionOptions,
  );
}

export const applyCalendarFilters = filterCalendarOccurrences;
export const deriveCalendarFacetOptions = deriveCalendarFacets;
export const getCalendarVisibleInterval = calendarIntervalFor;
export const stepCalendarDate = stepCalendarAnchor;
