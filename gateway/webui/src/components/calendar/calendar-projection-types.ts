import type {
  CalendarEventV2,
  CalendarImportance,
  CalendarOccurrence,
  CalendarOccurrenceV2,
  CalendarReadScope,
  CalendarScope,
  CalendarVisibility,
} from "../../services/calendar-api.ts";
import type { CalendarDate } from "./calendar-time.ts";

export type CalendarView = "day" | "week" | "month" | "year";
export type CalendarViewKind = CalendarView;
export type CalendarWeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** V2 wire rows and the normalized source rows returned by CalendarApi. */
export type CalendarOccurrenceInput = CalendarOccurrence | CalendarOccurrenceV2;
export type CalendarEventInput = CalendarEventV2 | CalendarOccurrenceInput;

/** The filters are presentation state; authorized data has already been loaded. */
export interface CalendarFilters {
  readonly scope?: CalendarReadScope;
  readonly scopes?: readonly CalendarReadScope[];
  readonly group?: string;
  readonly groups?: readonly string[];
  readonly tags?: readonly string[];
  readonly importance?: CalendarImportance | readonly CalendarImportance[];
  readonly importanceValues?: readonly CalendarImportance[];
  readonly text?: string;
  readonly query?: string;
}

export type CalendarSelectedFilters = CalendarFilters;

export interface CalendarFacetOption {
  readonly value: string;
  readonly count: number;
  readonly selected: boolean;
}

export interface CalendarFacets {
  readonly scopes: readonly CalendarFacetOption[];
  readonly groups: readonly CalendarFacetOption[];
  readonly tags: readonly CalendarFacetOption[];
  readonly importance: readonly CalendarFacetOption[];
  /** String-only aliases are convenient for compact filter controls. */
  readonly scopeOptions: readonly string[];
  readonly groupOptions: readonly string[];
  readonly tagOptions: readonly string[];
  readonly importanceOptions: readonly CalendarImportance[];
}

export interface CalendarActionIdentity {
  readonly eventId: string;
  readonly occurrenceId: string;
  /** Exact raw V2 value, including its RFC3339 offset when one was supplied. */
  readonly originalStart: string;
  readonly revision?: number;
  readonly scope: CalendarScope;
}

export interface ProjectedCalendarTime {
  readonly kind: "timed" | "all-day";
  /** Exact source value; never reconstructed from localized display fields. */
  readonly raw: string;
  /** Exact source instant for timed values. */
  readonly instant?: string;
  /** Exact date identity for all-day values. */
  readonly date?: CalendarDate;
  /** Device-local date used for placing the row in a projection. */
  readonly localDate: CalendarDate;
  readonly displayDate: string;
  readonly displayTime?: string;
  readonly label: string;
  readonly accessibleLabel: string;
}

export interface ProjectedCalendarOccurrence {
  readonly eventId: string;
  readonly occurrenceId: string;
  /** Raw RFC3339 occurrence anchor, not a localized or normalized substitute. */
  readonly originalStart: string;
  readonly rawOriginalStart: string;
  readonly recurring: boolean;
  readonly revision?: number;
  readonly scope: CalendarScope;
  readonly title: string;
  readonly description?: string;
  readonly visibility: CalendarVisibility;
  readonly importance: CalendarImportance;
  readonly group?: string;
  readonly tags: readonly string[];
  readonly start: ProjectedCalendarTime;
  readonly end?: ProjectedCalendarTime;
  readonly action: CalendarActionIdentity;
  /** The validated source row remains available to mutation/preview callers. */
  readonly source: CalendarOccurrenceInput;
  /** Compatibility alias for callers that call the source row an occurrence. */
  readonly occurrence: CalendarOccurrenceInput;
  readonly accessibleName: string;
}

export type CalendarProjectionEvent = ProjectedCalendarOccurrence;

export type CalendarEventPresentationMode = "full-pill" | "truncated-pill" | "dot";

export interface CalendarEventIndicator {
  readonly eventId: string;
  readonly occurrenceId: string;
  readonly kind: "timed" | "all-day";
  readonly importance: CalendarImportance;
  readonly accessibleName: string;
}

export interface CalendarEventPresentation {
  readonly event: ProjectedCalendarOccurrence;
  readonly mode: CalendarEventPresentationMode;
  /** Visual text may be compact; accessibleName is always complete. */
  readonly visualLabel: string;
  readonly accessibleName: string;
  readonly indicator: CalendarEventIndicator;
}

export interface CalendarDensityProjection {
  readonly mode: CalendarEventPresentationMode;
  /** All events remain represented for access even when not visible in a cell. */
  readonly events: readonly CalendarEventPresentation[];
  readonly visibleEvents: readonly CalendarEventPresentation[];
  readonly overflowEvents: readonly CalendarEventPresentation[];
  readonly indicators: readonly CalendarEventIndicator[];
  readonly overflowCount: number;
  readonly overflowLabel?: string;
}

export interface CalendarDateCell {
  readonly date: CalendarDate;
  readonly day: number;
  readonly month: number;
  readonly year: number;
  readonly outsideMonth: boolean;
  readonly selected: boolean;
  readonly today: boolean;
  readonly accessibleLabel: string;
  readonly events: readonly ProjectedCalendarOccurrence[];
  readonly eventCount: number;
  readonly indicators: readonly CalendarEventIndicator[];
  readonly overflowCount: number;
  /** Full source rows remain reachable even when compact density hides them. */
  readonly overflowEvents: readonly ProjectedCalendarOccurrence[];
  readonly density: CalendarDensityProjection;
}

export interface CalendarAgendaSection {
  readonly date: CalendarDate;
  readonly label: string;
  readonly events: readonly ProjectedCalendarOccurrence[];
}

export interface CalendarInterval {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
}

export interface CalendarNavigationState {
  readonly view: CalendarView;
  /** The date used to calculate the visible interval. */
  readonly anchorDate: CalendarDate;
  /** The independently selected date, retained while the interval moves. */
  readonly selectedDate: CalendarDate;
}

export type CalendarProjectionState = CalendarNavigationState;

export interface CalendarProjectionOptions {
  readonly locale?: string;
  /** Display zone for timed rows; never read from occurrence.start.timeZoneId. */
  readonly timeZone?: string;
  readonly deviceTimeZone?: string;
  readonly timeZoneId?: string;
  readonly weekStartsOn?: CalendarWeekdayIndex;
  readonly today?: CalendarDate;
  readonly selectedDate?: CalendarDate;
  readonly density?: CalendarDensityOptions;
}

export interface CalendarDensityOptions {
  readonly mode?: CalendarEventPresentationMode;
  readonly maxVisibleEvents?: number;
  readonly maxIndicators?: number;
  readonly maxTitleCharacters?: number;
  readonly dateLabel?: string;
}

export interface CalendarDayProjection {
  readonly kind: "day";
  readonly view: "day";
  readonly anchorDate: CalendarDate;
  readonly selectedDate: CalendarDate;
  readonly today: CalendarDate;
  readonly interval: CalendarInterval;
  readonly date: CalendarDate;
  readonly selected: boolean;
  readonly isToday: boolean;
  readonly accessibleLabel: string;
  readonly events: readonly ProjectedCalendarOccurrence[];
  readonly density: CalendarDensityProjection;
  readonly agenda: readonly CalendarAgendaSection[];
}

export interface CalendarWeekProjection {
  readonly kind: "week";
  readonly view: "week";
  readonly anchorDate: CalendarDate;
  readonly selectedDate: CalendarDate;
  readonly today: CalendarDate;
  readonly interval: CalendarInterval;
  readonly weekStartsOn: CalendarWeekdayIndex;
  readonly dates: readonly CalendarDate[];
  readonly cells: readonly CalendarDateCell[];
  readonly agenda: readonly CalendarAgendaSection[];
}

export interface CalendarMonthProjection {
  readonly kind: "month";
  readonly view: "month";
  readonly anchorDate: CalendarDate;
  readonly selectedDate: CalendarDate;
  readonly today: CalendarDate;
  readonly interval: CalendarInterval;
  readonly month: number;
  readonly year: number;
  readonly weekStartsOn: CalendarWeekdayIndex;
  /** Always six rows × seven columns. */
  readonly cells: readonly CalendarDateCell[];
  readonly weeks: readonly (readonly CalendarDateCell[])[];
  readonly agenda: readonly CalendarAgendaSection[];
}

export interface CalendarYearMonthProjection {
  readonly month: number;
  readonly year: number;
  readonly label: string;
  readonly interval: CalendarInterval;
  /** Complete valid dates, including 29–31 where the month has them. */
  readonly dates: readonly CalendarDate[];
  readonly days: readonly CalendarDateCell[];
  readonly eventCount: number;
  readonly selected: boolean;
}

export interface CalendarYearProjection {
  readonly kind: "year";
  readonly view: "year";
  readonly anchorDate: CalendarDate;
  readonly selectedDate: CalendarDate;
  readonly today: CalendarDate;
  readonly interval: CalendarInterval;
  readonly months: readonly CalendarYearMonthProjection[];
}

export type CalendarViewProjection =
  | CalendarDayProjection
  | CalendarWeekProjection
  | CalendarMonthProjection
  | CalendarYearProjection;

export interface CalendarFilteredProjection {
  readonly occurrences: readonly CalendarOccurrenceInput[];
  readonly filteredOccurrences: readonly CalendarOccurrenceInput[];
  /** Short aliases for controller/canvas consumers. */
  readonly filtered: readonly CalendarOccurrenceInput[];
  readonly projectedOccurrences: readonly ProjectedCalendarOccurrence[];
  readonly events: readonly ProjectedCalendarOccurrence[];
  readonly filters: CalendarFilters;
  readonly facets: CalendarFacets;
}

export interface CalendarProjectionRequest extends CalendarProjectionOptions {
  readonly occurrences: readonly CalendarOccurrenceInput[];
  readonly view: CalendarView;
  readonly anchorDate: CalendarDate;
  readonly selectedDate?: CalendarDate;
  readonly filters?: CalendarFilters;
}

export interface CalendarProjectionResult extends CalendarFilteredProjection {
  readonly view: CalendarViewProjection;
}

export type CalendarProjection = CalendarProjectionResult;
export type CalendarDay = CalendarDayProjection;
export type CalendarWeek = CalendarWeekProjection;
export type CalendarMonth = CalendarMonthProjection;
export type CalendarYear = CalendarYearProjection;
export type CalendarFilterState = CalendarFilters;
