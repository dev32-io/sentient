import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { EventIndicatorProps } from "./calendar-canvas-types.ts";
import { invokeEventOpen } from "./calendar-canvas-intents.ts";
import "./calendar-canvas.css";

function joinClasses(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
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
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    button.dataset.calendarEvent = "true";
    button.dataset.eventId = event.eventId;
    button.dataset.occurrenceId = event.occurrenceId;
    button.dataset.calendarEventMode = presentation.mode;
    button.dataset.calendarEventDate = date;
    button.dataset.importance = event.importance;
  }, [date, event.eventId, event.importance, event.occurrenceId, presentation.mode]);
  const title = eventTitle(presentation);
  const time = eventTime(presentation);
  return (
    <SurfaceAction
        type="button"
      buttonRef={buttonRef}
      class={joinClasses(
        "calendar-event-indicator",
        `calendar-event-indicator--${presentation.mode}`,
        compact && "calendar-event-indicator--compact",
        visuallyHidden && "calendar-event-indicator--visually-hidden",
        className,
      )}
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
    </SurfaceAction>
  );
}
