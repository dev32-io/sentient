import type { ComponentChildren } from "preact";
import type {
  CalendarDateCell,
  CalendarDayProjection,
  CalendarEventPresentation,
  CalendarMonthProjection,
  CalendarViewProjection,
  CalendarWeekProjection,
  CalendarYearMonthProjection,
  CalendarYearProjection,
  ProjectedCalendarOccurrence,
} from "./calendar-projection-types.ts";
import type { CalendarFilters as CalendarWorkspaceFilters, CalendarViewMode } from "./calendar-projections.ts";
import type { CalendarDate } from "./calendar-time.ts";

/**
 * Callbacks exposed by the canvas. The canvas only reports intent; it never
 * owns navigation, preview, mutation, persistence, or network state.
 */
export interface CalendarCanvasCallbacks {
  readonly onSelectDate?: (date: CalendarDate) => void;
  readonly onDateSelect?: (date: CalendarDate) => void;
  readonly onOpenDay?: (date: CalendarDate) => void;
  readonly onDaySelect?: (date: CalendarDate) => void;
  readonly onSelectMonth?: (year: number, month: number) => void;
  readonly onMonthSelect?: (year: number, month: number) => void;
  readonly onOpenEvent?: (event: ProjectedCalendarOccurrence, date: CalendarDate) => void;
  readonly onEventSelect?: (event: ProjectedCalendarOccurrence, date: CalendarDate) => void;
  readonly onEventClick?: (event: ProjectedCalendarOccurrence, date: CalendarDate) => void;
  readonly onOpenOverflow?: (date: CalendarDate, events: readonly ProjectedCalendarOccurrence[]) => void;
  readonly onOverflow?: (date: CalendarDate, events: readonly ProjectedCalendarOccurrence[]) => void;
}

/**
 * The one public canvas-slot contract shared by CalendarWorkspace and every
 * leaf canvas. The shell supplies the complete presentation snapshot and
 * intent callbacks; leaves never reach a service or invent a second state
 * shape. State fields are required even when a standalone canvas has no
 * projection yet, so a function-valued slot always receives the same props.
 */
export interface CalendarWorkspaceCanvasSlotProps extends CalendarCanvasCallbacks {
  readonly view: CalendarViewMode;
  readonly selectedView: CalendarViewMode;
  readonly anchorDate: CalendarDate;
  readonly selectedDate: CalendarDate;
  readonly filters: CalendarWorkspaceFilters;
  readonly projection: CalendarViewProjection | null;
  readonly loading?: boolean;
  readonly refreshing?: boolean;
  readonly emptyLabel?: string;
  readonly class?: string;
  readonly className?: string;
}

export type CalendarCanvasSlotProps = CalendarWorkspaceCanvasSlotProps;
export type CalendarCanvasSlot = (props: CalendarWorkspaceCanvasSlotProps) => ComponentChildren;
export type CalendarCanvasRenderSlot = CalendarCanvasSlot;
export type CalendarCanvasChild = ComponentChildren | CalendarCanvasSlot;
/** Standalone convenience props; a slot invocation still uses the complete contract. */
export type CalendarCanvasProps = Partial<CalendarWorkspaceCanvasSlotProps>;
export type CalendarWorkspaceCanvasSlot = CalendarCanvasSlot;

export interface CalendarCanvasRendererProps extends CalendarCanvasCallbacks {
  readonly loading?: boolean;
  readonly refreshing?: boolean;
  readonly emptyLabel?: string;
}

export interface DayViewProps extends CalendarCanvasRendererProps {
  readonly projection: CalendarDayProjection;
}

export interface WeekGridProps extends CalendarCanvasRendererProps {
  readonly projection: CalendarWeekProjection;
}

export interface MonthGridProps extends CalendarCanvasRendererProps {
  readonly projection: CalendarMonthProjection;
}

export interface YearGridProps extends CalendarCanvasRendererProps {
  readonly projection: CalendarYearProjection;
}

export interface DayCellProps extends CalendarCanvasCallbacks {
  readonly cell: CalendarDateCell;
  readonly class?: string;
  readonly compact?: boolean;
  readonly showOutsideMonth?: boolean;
}

export interface EventIndicatorProps extends CalendarCanvasCallbacks {
  readonly presentation: CalendarEventPresentation;
  readonly date: CalendarDate;
  readonly class?: string;
  readonly compact?: boolean;
  readonly visuallyHidden?: boolean;
}

export interface OverflowControlProps extends CalendarCanvasCallbacks {
  readonly date: CalendarDate;
  readonly events: readonly ProjectedCalendarOccurrence[];
  readonly count?: number;
  readonly label?: string;
  readonly class?: string;
}

export interface AgendaSectionProps extends CalendarCanvasCallbacks {
  readonly date: CalendarDate;
  readonly label: string;
  readonly events: readonly ProjectedCalendarOccurrence[];
  readonly class?: string;
  readonly emptyLabel?: string;
  readonly showDateHeader?: boolean;
}

export interface AgendaRowProps extends CalendarCanvasCallbacks {
  readonly date: CalendarDate;
  readonly event: ProjectedCalendarOccurrence;
  readonly presentation?: CalendarEventPresentation;
  readonly class?: string;
}

export interface CalendarCanvasPartProps extends CalendarCanvasCallbacks {
  readonly date: CalendarDate;
}

export type CalendarProjectionByKind =
  | CalendarDayProjection
  | CalendarWeekProjection
  | CalendarMonthProjection
  | CalendarYearProjection;

export type CalendarCanvasProjection = CalendarViewProjection;
export type CalendarMonthSummary = CalendarYearMonthProjection;
