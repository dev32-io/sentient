import type { CalendarCanvasCallbacks } from "./calendar-canvas-types.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import type { CalendarDate } from "./calendar-time.ts";

export function invokeDateSelect(callbacks: CalendarCanvasCallbacks, date: CalendarDate): void {
  (callbacks.onSelectDate ?? callbacks.onDateSelect ?? callbacks.onOpenDay ?? callbacks.onDaySelect)?.(date);
}

export function invokeMonthSelect(
  callbacks: CalendarCanvasCallbacks,
  year: number,
  month: number,
  date: CalendarDate,
): void {
  if (callbacks.onSelectMonth) {
    callbacks.onSelectMonth(year, month);
    return;
  }
  if (callbacks.onMonthSelect) {
    callbacks.onMonthSelect(year, month);
    return;
  }
  invokeDateSelect(callbacks, date);
}

export function invokeEventOpen(
  callbacks: CalendarCanvasCallbacks,
  event: ProjectedCalendarOccurrence,
  date: CalendarDate,
): void {
  const callback = callbacks.onOpenEvent ?? callbacks.onEventSelect ?? callbacks.onEventClick;
  if (callback) {
    callback(event, date);
    return;
  }
  // A canvas without a preview callback still reaches the focused day path.
  invokeDateSelect(callbacks, date);
}

export function invokeOverflowOpen(
  callbacks: CalendarCanvasCallbacks,
  date: CalendarDate,
  events: readonly ProjectedCalendarOccurrence[],
): void {
  const callback = callbacks.onOpenOverflow ?? callbacks.onOverflow;
  if (callback) {
    callback(date, events);
    return;
  }
  // Keep +N useful for standalone canvases with only date navigation.
  (callbacks.onOpenDay ?? callbacks.onDaySelect ?? callbacks.onSelectDate ?? callbacks.onDateSelect)?.(date);
}
