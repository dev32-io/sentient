import type { JSX } from "preact";
import { presentCalendarEvent } from "./calendar-density.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import {
  type AgendaRowProps,
  type AgendaSectionProps,
  type CalendarCanvasCallbacks,
  type DayCellProps,
  type EventIndicatorProps,
  type OverflowControlProps,
} from "./calendar-canvas-types.ts";
import {
  calendarDateToUtcMillis,
  formatAccessibleCalendarDate,
  formatCalendarDate,
  type CalendarDate,
} from "./calendar-time.ts";
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

export function invokeDateSelect(callbacks: CalendarCanvasCallbacks, date: `${number}-${number}-${number}`): void {
  (callbacks.onSelectDate ?? callbacks.onDateSelect ?? callbacks.onOpenDay ?? callbacks.onDaySelect)?.(date);
}

export function invokeMonthSelect(callbacks: CalendarCanvasCallbacks, year: number, month: number, date: `${number}-${number}-${number}`): void {
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
  date: `${number}-${number}-${number}`,
): void {
  const callback = callbacks.onOpenEvent ?? callbacks.onEventSelect ?? callbacks.onEventClick;
  if (callback) {
    callback(event, date);
    return;
  }
  // If preview is not mounted yet, selecting the event's date still reaches
  // the focused Day path instead of leaving a keyboard-activated event inert.
  invokeDateSelect(callbacks, date);
}

export function invokeOverflowOpen(
  callbacks: CalendarCanvasCallbacks,
  date: `${number}-${number}-${number}`,
  events: readonly ProjectedCalendarOccurrence[],
): void {
  const callback = callbacks.onOpenOverflow ?? callbacks.onOverflow;
  if (callback) {
    callback(date, events);
    return;
  }
  // A canvas without a dedicated detail callback still keeps +N useful: date
  // selection is the reachable day-detail path supplied by the shell.
  (callbacks.onOpenDay ?? callbacks.onDaySelect ?? callbacks.onSelectDate ?? callbacks.onDateSelect)?.(date);
}

function eventTitle(presentation: EventIndicatorProps["presentation"]): string {
  if (presentation.mode === "truncated-pill") return presentation.visualLabel || presentation.event.title;
  return presentation.event.title;
}

function eventTime(presentation: EventIndicatorProps["presentation"]): string {
  return presentation.event.start.kind === "all-day" ? "All day" : presentation.event.start.displayTime ?? "";
}

/** A compact visual event that always retains its complete accessible name. */
export function EventIndicator({
  presentation,
  date,
  class: className,
  compact = false,
  visuallyHidden = false,
  ...callbacks
}: EventIndicatorProps): JSX.Element {
  const event = presentation.event;
  const title = eventTitle(presentation);
  const time = eventTime(presentation);
  return (
    <button
      type="button"
      class={joinClasses(
        "calendar-event-indicator",
        `calendar-event-indicator--${presentation.mode}`,
        compact && "calendar-event-indicator--compact",
        visuallyHidden && "calendar-event-indicator--visually-hidden",
        className,
      )}
      data-calendar-event="true"
      data-event-id={event.eventId}
      data-occurrence-id={event.occurrenceId}
      data-calendar-event-mode={presentation.mode}
      data-calendar-event-date={date}
      data-importance={event.importance}
      aria-label={presentation.accessibleName}
      title={presentation.accessibleName}
      aria-haspopup="dialog"
      onClick={() => invokeEventOpen(callbacks, event, date)}
    >
      <span class="calendar-event-indicator__pill" aria-hidden="true">
        <span class="calendar-event-indicator__time">{time}</span>
        <span class="calendar-event-indicator__title">{title}</span>
      </span>
      <span class="calendar-event-indicator__dot" aria-hidden="true" />
    </button>
  );
}

/** A reachable +N action for dense cells. */
export function OverflowControl({
  date,
  events,
  count = events.length,
  label,
  class: className,
  ...callbacks
}: OverflowControlProps): JSX.Element | null {
  if (count <= 0) return null;
  const accessibleLabel = label ?? `+${count} more events on ${formatAccessibleCalendarDate(date)}`;
  return (
    <button
      type="button"
      class={joinClasses("calendar-overflow-control", className)}
      data-calendar-overflow="true"
      data-overflow-date={date}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={() => invokeOverflowOpen(callbacks, date, events)}
    >
      <span aria-hidden="true">+{count}</span>
      <span class="calendar-overflow-control__suffix" aria-hidden="true">more</span>
    </button>
  );
}

function AccessibleOverflowEvents({
  date,
  events,
  ...callbacks
}: {
  readonly date: `${number}-${number}-${number}`;
  readonly events: readonly ProjectedCalendarOccurrence[];
} & CalendarCanvasCallbacks): JSX.Element | null {
  if (events.length === 0) return null;
  return (
    <ul class="calendar-canvas__accessible-overflow" aria-label={`Additional events on ${formatAccessibleCalendarDate(date)}`}>
      {events.map((event) => (
        <li key={event.occurrenceId}>
          <EventIndicator
            presentation={presentCalendarEvent(event, "truncated-pill")}
            date={date}
            visuallyHidden
            {...callbacks}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * A date cell is shared by Month and Week. Date state is announced on the
 * native button, while event controls remain siblings so buttons are never
 * nested inside one another.
 */
export function DayCell({
  cell,
  class: className,
  compact = false,
  showOutsideMonth = true,
  ...callbacks
}: DayCellProps): JSX.Element {
  const visibleEvents = cell.density.visibleEvents;
  const overflowEvents = cell.density.overflowEvents.map((presentation) => presentation.event);
  const date = cell.date;
  return (
    <div
      role="gridcell"
      class={joinClasses(
        "calendar-day-cell",
        cell.today && "calendar-day-cell--today",
        cell.selected && "calendar-day-cell--selected",
        showOutsideMonth && cell.outsideMonth && "calendar-day-cell--outside",
        compact && "calendar-day-cell--compact",
        className,
      )}
      data-calendar-date={date}
      data-outside-month={cell.outsideMonth ? "true" : "false"}
      data-today={cell.today ? "true" : "false"}
      data-selected={cell.selected ? "true" : "false"}
      aria-label={cell.accessibleLabel}
      aria-selected={cell.selected}
    >
      <button
        type="button"
        class="calendar-day-cell__date"
        aria-label={cell.accessibleLabel}
        aria-pressed={cell.selected}
        aria-current={cell.today ? "date" : undefined}
        onClick={() => invokeDateSelect(callbacks, date)}
      >
        <span aria-hidden="true">{cell.day}</span>
      </button>
      <div class="calendar-day-cell__events" aria-label={cell.eventCount ? `${cell.eventCount} events` : undefined}>
        {visibleEvents.map((presentation) => (
          <EventIndicator key={presentation.event.occurrenceId} presentation={presentation} date={date} {...callbacks} />
        ))}
        <OverflowControl
          date={date}
          events={overflowEvents}
          count={cell.overflowCount}
          {...(cell.density.overflowLabel === undefined ? {} : { label: cell.density.overflowLabel })}
          {...callbacks}
        />
      </div>
      <AccessibleOverflowEvents date={date} events={overflowEvents} {...callbacks} />
    </div>
  );
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
      <EventIndicator presentation={presentation} date={date} class="calendar-agenda-row__event" {...callbacks} />
      <span class="calendar-agenda-row__time" aria-hidden="true">{time}</span>
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
          <button
            type="button"
            id={sectionId}
            class="calendar-agenda-section__date-button"
            aria-label={label}
            aria-pressed={false}
            onClick={() => invokeDateSelect(callbacks, date)}
          >
            <strong aria-hidden="true">{shortDateLabel(date)}</strong>
            <span aria-hidden="true">{weekdayLabel(date)}</span>
          </button>
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

export function CalendarEmptyState({ label = "No events in this period." }: { readonly label?: string }): JSX.Element {
  return <p class="calendar-canvas__empty" data-calendar-empty="true">{label}</p>;
}

export function CalendarLoadingState({ refreshing = false }: { readonly refreshing?: boolean }): JSX.Element {
  return (
    <div class="calendar-canvas__loading" role="status" aria-live="polite">
      <span class="calendar-canvas__loading-mark" aria-hidden="true" />
      <span>{refreshing ? "Updating calendar…" : "Loading calendar…"}</span>
    </div>
  );
}
