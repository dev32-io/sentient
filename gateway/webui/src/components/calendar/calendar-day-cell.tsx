import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ActionButton } from "../common/index.ts";
import { presentCalendarEvent } from "./calendar-density.ts";
import type { DayCellProps } from "./calendar-canvas-types.ts";
import { invokeDateSelect } from "./calendar-canvas-intents.ts";
import { EventIndicator } from "./calendar-event-indicator.tsx";
import { OverflowControl } from "./calendar-overflow-control.tsx";
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
      <ActionButton
        buttonRef={dateButtonRef}
        className="calendar-day-cell__date"
        ariaLabel={cell.accessibleLabel}
        aria-pressed={cell.selected}
        onClick={() => invokeDateSelect(callbacks, date)}
      >
        <span aria-hidden="true">{cell.day}</span>
      </ActionButton>
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
      {overflowEvents.length > 0 && (
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
