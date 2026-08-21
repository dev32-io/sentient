import type { JSX } from "preact";
import { CalendarEmptyState, CalendarLoadingState, DayCell, weekdayShortLabel } from "./calendar-canvas-primitives.tsx";
import type { WeekGridProps } from "./calendar-canvas-types.ts";

export function WeekGrid({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel = "No events this week.",
  ...callbacks
}: WeekGridProps): JSX.Element {
  const hasEvents = projection.cells.some((cell) => cell.eventCount > 0);
  return (
    <section
      class="calendar-week-grid"
      data-calendar-view="week"
      data-calendar-canvas-view="week"
      aria-label={`Week view from ${projection.interval.from} through ${projection.interval.to}`}
      aria-busy={loading}
    >
      {loading && <CalendarLoadingState refreshing={refreshing} />}
      <div class="calendar-week-grid__weekdays" role="row" aria-label="Weekdays">
        {projection.cells.map((cell) => (
          <div key={`weekday-${cell.date}`} class="calendar-week-grid__weekday" role="columnheader">
            <span aria-hidden="true">{weekdayShortLabel(cell.date)}</span>
            <strong aria-hidden="true">{cell.day}</strong>
            <span class="calendar-canvas__sr-only">{cell.accessibleLabel}</span>
          </div>
        ))}
      </div>
      <div class="calendar-week-grid__grid" role="grid" aria-label="Seven day calendar grid">
        {projection.cells.map((cell) => (
          <DayCell key={cell.date} cell={cell} compact {...callbacks} />
        ))}
      </div>
      {!hasEvents && <CalendarEmptyState label={emptyLabel} />}
    </section>
  );
}
