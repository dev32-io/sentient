import type { JSX } from "preact";
import { presentCalendarEvent } from "./calendar-density.ts";
import {
  CalendarEmptyState,
  CalendarLoadingState,
  EventIndicator,
  invokeDateSelect,
  invokeMonthSelect,
} from "./calendar-canvas-primitives.tsx";
import type { CalendarYearMonthProjection } from "./calendar-projection-types.ts";
import type { CalendarCanvasCallbacks, YearGridProps } from "./calendar-canvas-types.ts";
import { calendarWeekday } from "./calendar-time.ts";

function YearMonthSummary({
  month,
  ...callbacks
}: { readonly month: CalendarYearMonthProjection } & CalendarCanvasCallbacks): JSX.Element {
  const firstDate = month.dates[0];
  const leadingDays = firstDate === undefined ? 0 : calendarWeekday(firstDate);
  const monthId = `calendar-year-month-${month.year}-${month.month}`;
  return (
    <article
      class={`calendar-year-grid__month${month.selected ? " calendar-year-grid__month--selected" : ""}`}
      data-calendar-year-month={`${month.year}-${String(month.month).padStart(2, "0")}`}
      aria-labelledby={monthId}
    >
      <header class="calendar-year-grid__month-header">
        <button
          type="button"
          id={monthId}
          class="calendar-year-grid__month-button"
          aria-label={`Select ${month.label}`}
          aria-pressed={month.selected}
          onClick={() => firstDate && invokeMonthSelect(callbacks, month.year, month.month, firstDate)}
        >
          <strong>{month.label}</strong>
        </button>
        <span class="calendar-year-grid__month-count" aria-label={`${month.eventCount} events`}>
          {month.eventCount > 0 ? `${month.eventCount} ${month.eventCount === 1 ? "event" : "events"}` : ""}
        </span>
      </header>
      <div class="calendar-year-grid__weekdays" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => <span key={index}>{["S", "M", "T", "W", "T", "F", "S"][index]}</span>)}
      </div>
      <div class="calendar-year-grid__days" role="grid" aria-label={`${month.label} dates`}>
        {Array.from({ length: leadingDays }, (_, index) => (
          <span key={`leading-${index}`} class="calendar-year-grid__empty-day" aria-hidden="true" />
        ))}
        {month.days.map((cell) => (
          <div
            key={cell.date}
            class={`calendar-year-grid__day${cell.today ? " calendar-year-grid__day--today" : ""}${cell.selected ? " calendar-year-grid__day--selected" : ""}`}
            role="gridcell"
            data-calendar-year-date={cell.date}
            aria-label={cell.accessibleLabel}
            aria-selected={cell.selected}
          >
            <button
              type="button"
              class="calendar-year-grid__date"
              aria-label={cell.eventCount > 0 ? `${cell.accessibleLabel}, ${cell.eventCount} events` : cell.accessibleLabel}
              aria-pressed={cell.selected}
              aria-current={cell.today ? "date" : undefined}
              onClick={() => invokeDateSelect(callbacks, cell.date)}
            >
              <span aria-hidden="true">{cell.day}</span>
              <span class="calendar-year-grid__dots" aria-hidden="true">
                {cell.indicators.map((indicator) => (
                  <i key={`${indicator.occurrenceId}-${indicator.eventId}`} data-importance={indicator.importance} />
                ))}
              </span>
            </button>
            <ul class="calendar-canvas__accessible-overflow" aria-label={`Events on ${cell.accessibleLabel}`}>
              {cell.density.events.map((presentation) => (
                <li key={presentation.event.occurrenceId}>
                  <EventIndicator
                    presentation={presentCalendarEvent(presentation.event, "truncated-pill")}
                    date={cell.date}
                    visuallyHidden
                    {...callbacks}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </article>
  );
}

export function YearGrid({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel = "No events this year.",
  ...callbacks
}: YearGridProps): JSX.Element {
  const hasEvents = projection.months.some((month) => month.eventCount > 0);
  return (
    <section
      class="calendar-year-grid"
      data-calendar-view="year"
      data-calendar-canvas-view="year"
      aria-label={`Year view for ${projection.anchorDate.slice(0, 4)}`}
      aria-busy={loading}
    >
      {loading && <CalendarLoadingState refreshing={refreshing} />}
      <div class="calendar-year-grid__grid">
        {projection.months.map((month) => (
          <YearMonthSummary key={`${month.year}-${month.month}`} month={month} {...callbacks} />
        ))}
      </div>
      {!hasEvents && <CalendarEmptyState label={emptyLabel} />}
    </section>
  );
}
