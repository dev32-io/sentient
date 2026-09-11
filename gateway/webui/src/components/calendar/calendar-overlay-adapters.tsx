import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { ActionButton } from "../common/index.ts";
import { Dialog } from "../common/dialog.tsx";
import { formatAccessibleCalendarDate, type CalendarDate } from "./calendar-time.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";

export interface CalendarOverflowDialogState {
  readonly date: CalendarDate;
  readonly events: readonly ProjectedCalendarOccurrence[];
}

export interface CalendarOverflowDialogProps {
  readonly state: CalendarOverflowDialogState;
  readonly onClose: () => void;
  readonly onOpen: (event: ProjectedCalendarOccurrence, anchor: HTMLElement) => void;
}

/** Adapter for dense-day overflow; it does not own event or preview state. */
export function CalendarOverflowDialog({ state, onClose, onOpen }: CalendarOverflowDialogProps): JSX.Element {
  return (
    <Dialog
      title={`Events on ${formatAccessibleCalendarDate(state.date)}`}
      description="Every event in this dense day remains available to open."
      width={460}
      inertBackground
      onClose={onClose}
      footer={<ActionButton className="app-dialog__btn app-dialog__btn--ghost" onClick={onClose}>Close</ActionButton>}
    >
      <div class="calendar-overflow-dialog__list" role="list" aria-label="Events in this day">
        {state.events.map((event) => (
          <div role="listitem" key={event.occurrenceId}>
            <SurfaceAction type="button"
              class="calendar-overflow-dialog__event"
              onClick={(clickEvent) => onOpen(event, clickEvent.currentTarget as HTMLElement)}
            >
              <strong>{event.title}</strong>
              <span>{event.start.label}</span>
            </SurfaceAction>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
