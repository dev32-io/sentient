import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { presentCalendarEvent } from "./calendar-density.ts";
import type { AgendaRowProps, AgendaSectionProps } from "./calendar-canvas-types.ts";
import { Icon } from "../common/icon.tsx";
import { invokeDateSelect, invokeEventOpen } from "./calendar-canvas-intents.ts";
import { calendarDateToUtcMillis, formatCalendarDate, type CalendarDate } from "./calendar-time.ts";
import "./calendar-canvas.css";

function joinClasses(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

function dateId(date: string): string {
  return date.replace(/[^0-9a-z]+/gi, "-");
}

export function shortDateLabel(date: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date(calendarDateToUtcMillis(date as CalendarDate)),
    );
  } catch {
    return formatCalendarDate(date as CalendarDate, locale === undefined ? {} : { locale });
  }
}

export function weekdayLabel(date: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(calendarDateToUtcMillis(date as CalendarDate)),
    );
  } catch {
    return "";
  }
}

export function weekdayShortLabel(date: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
      new Date(calendarDateToUtcMillis(date as CalendarDate)),
    );
  } catch {
    return weekdayLabel(date, locale).slice(0, 3);
  }
}

/** A full-width chronological event row used by the Day agenda. */
export function AgendaRow({
  date,
  event,
  presentation = presentCalendarEvent(event, "full-pill"),
  class: className,
  ...callbacks
}: AgendaRowProps): JSX.Element {
  const time = event.start.kind === "all-day" ? "All day" : event.start.displayTime ?? event.start.label;
  return (
    <li class={joinClasses("calendar-agenda-row", className)} data-calendar-event-row="true">
      <SurfaceAction type="button" class="calendar-agenda-row__event" data-calendar-event="true"
        data-event-id={event.eventId} data-occurrence-id={event.occurrenceId} data-importance={event.importance}
        aria-label={presentation.accessibleName} aria-haspopup="dialog" onClick={() => invokeEventOpen(callbacks, event, date)}>
        <time class="calendar-agenda-row__time" aria-hidden="true">{time}</time>
        <span class="calendar-agenda-row__marker" aria-hidden="true" />
        <span class="calendar-agenda-row__copy"><strong>{event.title}</strong><small>{event.description ?? event.group}</small></span>
        <span class="calendar-agenda-row__scope" aria-label={event.scope === "private" ? "Private" : "Household"}>
          <Icon name={event.scope === "private" ? "key" : "users-group"} size={16} />
        </span>
      </SurfaceAction>
    </li>
  );
}

export function AgendaSection({
  date,
  label,
  events,
  class: className,
  emptyLabel = "No events",
  showDateHeader = true,
  ...callbacks
}: AgendaSectionProps): JSX.Element {
  const sectionId = `calendar-agenda-${dateId(date)}`;
  return (
    <section
      class={joinClasses("calendar-agenda-section", !showDateHeader && "calendar-agenda-section--no-date", className)}
      data-calendar-agenda={date}
      aria-labelledby={showDateHeader ? sectionId : undefined}
      aria-label={showDateHeader ? undefined : label}
    >
      {showDateHeader && (
        <header class="calendar-agenda-section__date">
          <SurfaceAction
            type="button"
            id={sectionId}
            class="calendar-agenda-section__date-button"
            aria-label={label}
            aria-pressed={false}
            onClick={() => invokeDateSelect(callbacks, date)}
          >
            <strong aria-hidden="true">{shortDateLabel(date)}</strong>
            <span aria-hidden="true">{weekdayLabel(date)}</span>
          </SurfaceAction>
        </header>
      )}
      {events.length > 0 ? (
        <ul class="calendar-agenda-section__list">
          {events.map((event) => (
            <AgendaRow key={event.occurrenceId} date={date} event={event} {...callbacks} />
          ))}
        </ul>
      ) : (
        <p class="calendar-canvas__empty calendar-agenda-section__empty">{emptyLabel}</p>
      )}
    </section>
  );
}
