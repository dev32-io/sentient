import { projectCalendarDensity } from "./calendar-density.ts";
import { deriveCalendarProjection } from "./calendar-filters.ts";
import { compareProjectedCalendarOccurrences, projectCalendarOccurrences } from "./calendar-occurrence.ts";
import type {
  CalendarDateCell,
  CalendarDayProjection,
  CalendarFilteredProjection,
  CalendarFilters,
  CalendarInterval,
  CalendarMonthProjection,
  CalendarNavigationState,
  CalendarOccurrenceInput,
  CalendarProjectionOptions,
  CalendarProjectionRequest,
  CalendarProjectionResult,
  CalendarView,
  CalendarViewProjection,
  CalendarWeekProjection,
  CalendarWeekdayIndex,
  CalendarYearMonthProjection,
  CalendarYearProjection,
  ProjectedCalendarOccurrence,
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
): CalendarInterval {
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
): CalendarInterval {
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
  return { ...state, anchorDate: selectedDate, selectedDate };
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
  return {
    kind: "year",
    view: "year",
    anchorDate: anchor,
    selectedDate,
    today,
    interval: { from: formatDate(parts.year, 1, 1), to: formatDate(parts.year, 12, 31) },
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
): CalendarViewProjection {
  const projectedOccurrences = materializeRows(rows, options);
  if (view === "day") return buildDayProjection(projectedOccurrences, anchorDate, options);
  if (view === "week") return buildWeekProjection(projectedOccurrences, anchorDate, options);
  if (view === "month") return buildMonthProjection(projectedOccurrences, anchorDate, options);
  return buildYearProjection(projectedOccurrences, anchorDate, options);
}

export function projectCalendar(request: CalendarProjectionRequest): CalendarProjectionResult {
  const filtered: CalendarFilteredProjection = deriveCalendarProjection(
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
  filters: CalendarFilters = {},
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
  readonly filters?: CalendarFilters;
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
