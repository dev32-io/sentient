import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { presentCalendarEvent } from "./calendar-density.ts";
import type { DayCellProps } from "./calendar-canvas-types.ts";
import { invokeDateSelect, invokeOverflowOpen } from "./calendar-canvas-intents.ts";
import { EventIndicator } from "./calendar-event-indicator.tsx";
import { OverflowControl } from "./calendar-overflow-control.tsx";
import { weekdayShortLabel } from "./calendar-agenda.tsx";
import { formatAccessibleCalendarDate } from "./calendar-time.ts";
import "./calendar-canvas.css";

function joinClasses(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/**
 * A shared date cell for Month and Week. The date action and event actions are
 * siblings, so keyboard users never encounter nested interactive controls.
 */
export function DayCell({
  cell,
  class: className,
  compact = false,
  dayAccessOnly = false,
  showOutsideMonth = true,
  ...callbacks
}: DayCellProps): JSX.Element {
  const dateButtonRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const button = dateButtonRef.current;
    if (!button) return;
    if (cell.today) button.setAttribute("aria-current", "date");
    else button.removeAttribute("aria-current");
  }, [cell.today]);
  const visibleEvents = cell.density.visibleEvents;
  const overflowEvents = cell.density.overflowEvents.map((presentation) => presentation.event);
  const date = cell.date;
  return (
    <div
      role="gridcell"
      class={joinClasses(
        "calendar-day-cell",
        dayAccessOnly && "calendar-day-cell--day-access",
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
      <SurfaceAction
        type="button"
        buttonRef={dateButtonRef}
        class="calendar-day-cell__date"
        aria-label={dayAccessOnly ? `Open ${cell.accessibleLabel}, ${cell.eventCount} events` : cell.accessibleLabel}
        aria-pressed={cell.selected}
        onClick={() => {
          if (dayAccessOnly && !(callbacks.onSelectDate ?? callbacks.onDateSelect ?? callbacks.onOpenDay ?? callbacks.onDaySelect)) {
            invokeOverflowOpen(callbacks, date, cell.density.events.map((event) => event.event));
          } else invokeDateSelect(callbacks, date);
        }}
      >
        <span aria-hidden="true">{compact ? `${weekdayShortLabel(date)} ${cell.day}` : cell.day}</span>
        {dayAccessOnly && cell.eventCount > 0 && <small aria-hidden="true">+{cell.eventCount}</small>}
      </SurfaceAction>
      {!dayAccessOnly && <div class="calendar-day-cell__events" aria-label={cell.eventCount ? `${cell.eventCount} events` : undefined}>
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
      </div>}
      {!dayAccessOnly && overflowEvents.length > 0 && (
        <ul class="calendar-canvas__accessible-overflow" aria-label={`Additional events on ${formatAccessibleCalendarDate(date)}`}>
          {overflowEvents.map((event) => (
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
      )}
    </div>
  );
}
