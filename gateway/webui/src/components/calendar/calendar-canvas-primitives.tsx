import "./calendar-canvas.css";

/**
 * Compatibility barrel for the canvas product parts. Each implementation is
 * now a cohesive composite; this module remains for legacy leaf imports.
 */
export { CalendarEmptyState, CalendarLoadingState } from "./calendar-canvas-states.tsx";
export { DayCell } from "./calendar-day-cell.tsx";
export { EventIndicator } from "./calendar-event-indicator.tsx";
export { OverflowControl } from "./calendar-overflow-control.tsx";
export { AgendaRow, AgendaSection, shortDateLabel, weekdayLabel, weekdayShortLabel } from "./calendar-agenda.tsx";
export {
  invokeDateSelect,
  invokeEventOpen,
  invokeMonthSelect,
  invokeOverflowOpen,
} from "./calendar-canvas-intents.ts";
export type {
  AgendaRowProps,
  AgendaSectionProps,
  CalendarCanvasCallbacks,
  DayCellProps,
  EventIndicatorProps,
  OverflowControlProps,
} from "./calendar-canvas-types.ts";
