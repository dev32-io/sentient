import type { JSX } from "preact";
import {
  AgendaSection,
  CalendarEmptyState,
  CalendarLoadingState,
  invokeDateSelect,
} from "./calendar-canvas-primitives.tsx";
import type { DayViewProps } from "./calendar-canvas-types.ts";
import { formatAccessibleCalendarDate } from "./calendar-time.ts";

export function DayView({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel = "No events on this day.",
  ...callbacks
}: DayViewProps): JSX.Element {
  const dateLabel = [
    projection.accessibleLabel,
    projection.isToday ? "today" : "",
    projection.selected ? "selected" : "",
  ].filter(Boolean).join(", ");
  const events = projection.events;
  return (
    <section
      class="calendar-day-view"
      data-calendar-view="day"
      data-calendar-canvas-view="day"
      aria-label={`Day view for ${dateLabel}`}
      aria-busy={loading}
    >
      <header class="calendar-day-view__header">
        <button
          type="button"
          class="calendar-day-view__date"
          aria-label={dateLabel}
          aria-pressed={projection.selected}
          aria-current={projection.isToday ? "date" : undefined}
          onClick={() => invokeDateSelect(callbacks, projection.date)}
        >
          <span class="calendar-day-view__weekday" aria-hidden="true">{dateLabel.split(",")[0]}</span>
          <strong aria-hidden="true">{formatAccessibleCalendarDate(projection.date).replace(/^[^,]+,\s*/, "")}</strong>
        </button>
        <p class="calendar-day-view__note">
          {projection.isToday ? "Today" : projection.selected ? "Selected day" : "Focused agenda"}
        </p>
      </header>
      {loading && <CalendarLoadingState refreshing={refreshing} />}
      {projection.agenda.length > 0 ? (
        <div class="calendar-day-view__agenda" aria-label="Chronological agenda">
          {projection.agenda.map((section) => (
            <AgendaSection
              key={section.date}
              date={section.date}
              label={section.label}
              events={section.events}
              emptyLabel={emptyLabel}
              showDateHeader={false}
              {...callbacks}
            />
          ))}
        </div>
      ) : events.length > 0 ? (
        <ul class="calendar-day-view__events">
          {events.map((event) => (
            <li key={event.occurrenceId}>{event.title}</li>
          ))}
        </ul>
      ) : (
        <CalendarEmptyState label={emptyLabel} />
      )}
    </section>
  );
}
