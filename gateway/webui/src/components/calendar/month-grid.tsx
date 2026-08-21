import type { JSX } from "preact";
import {
  CalendarEmptyState,
  CalendarLoadingState,
  DayCell,
  weekdayShortLabel,
} from "./calendar-canvas-primitives.tsx";
import type { MonthGridProps } from "./calendar-canvas-types.ts";
import { formatAccessibleCalendarDate } from "./calendar-time.ts";

function monthLabel(year: number, month: number): string {
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as `${number}-${number}-${number}`;
  try {
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00.000Z`),
    );
  } catch {
    return formatAccessibleCalendarDate(date);
  }
}

export function MonthGrid({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel = "No events this month.",
  ...callbacks
}: MonthGridProps): JSX.Element {
  const hasEvents = projection.cells.some((cell) => cell.eventCount > 0);
  const firstWeek = projection.weeks[0] ?? [];
  return (
    <section
      class="calendar-month-grid"
      data-calendar-view="month"
      data-calendar-canvas-view="month"
      aria-label={`Month view for ${monthLabel(projection.year, projection.month)}`}
      aria-busy={loading}
    >
      {loading && <CalendarLoadingState refreshing={refreshing} />}
      <div class="calendar-month-grid__weekdays" role="row" aria-label="Weekdays">
        {firstWeek.map((cell) => (
          <div key={`weekday-${cell.date}`} class="calendar-month-grid__weekday" role="columnheader">
            <span aria-hidden="true">{weekdayShortLabel(cell.date)}</span>
            <span class="calendar-canvas__sr-only">{cell.accessibleLabel}</span>
          </div>
        ))}
      </div>
      <div class="calendar-month-grid__grid" role="grid" aria-label="Six week month calendar grid">
        {projection.weeks.map((week, weekIndex) => (
          <div key={`week-${weekIndex}`} class="calendar-month-grid__row" role="row">
            {week.map((cell) => (
              <DayCell key={cell.date} cell={cell} {...callbacks} />
            ))}
          </div>
        ))}
      </div>
      {!hasEvents && <CalendarEmptyState label={emptyLabel} />}
    </section>
  );
}
