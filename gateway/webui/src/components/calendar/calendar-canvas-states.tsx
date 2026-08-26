import type { JSX } from "preact";
import "./calendar-canvas.css";

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
