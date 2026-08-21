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
 * Public render-slot contract for CalendarWorkspace. It is deliberately
 * structural so the shell can pass the slot without importing canvas internals.
 */
export interface CalendarCanvasSlotProps extends CalendarCanvasCallbacks {
  readonly projection?: CalendarViewProjection | null;
  readonly loading?: boolean;
  readonly refreshing?: boolean;
  readonly emptyLabel?: string;
  readonly class?: string;
  readonly className?: string;
}

export type CalendarCanvasSlot = (props: CalendarCanvasSlotProps) => import("preact").ComponentChildren;
export type CalendarCanvasProps = CalendarCanvasSlotProps;
export type CalendarWorkspaceCanvasSlotProps = CalendarCanvasSlotProps;
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
