import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ActionButton } from "../common/index.ts";
import { formatAccessibleCalendarDate } from "./calendar-time.ts";
import type { OverflowControlProps } from "./calendar-canvas-types.ts";
import { invokeOverflowOpen } from "./calendar-canvas-intents.ts";
import "./calendar-canvas.css";

function joinClasses(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
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
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    button.dataset.calendarOverflow = "true";
    button.dataset.overflowDate = date;
  }, [date]);
  if (count <= 0) return null;
  const accessibleLabel = label ?? `+${count} more events on ${formatAccessibleCalendarDate(date)}`;
  return (
    <ActionButton
      buttonRef={buttonRef}
      className={joinClasses("calendar-overflow-control", className)}
      ariaLabel={accessibleLabel}
      title={accessibleLabel}
      onClick={() => invokeOverflowOpen(callbacks, date, events)}
    >
      <span aria-hidden="true">+{count}</span>
      <span class="calendar-overflow-control__suffix" aria-hidden="true">more</span>
    </ActionButton>
  );
}
