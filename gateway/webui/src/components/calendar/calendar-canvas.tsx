import type { JSX } from "preact";
import {
  CalendarEmptyState,
  CalendarLoadingState,
} from "./calendar-canvas-primitives.tsx";
import type { CalendarCanvasProps } from "./calendar-canvas-types.ts";
import { DayView } from "./day-view.tsx";
import { MonthGrid } from "./month-grid.tsx";
import { WeekGrid } from "./week-grid.tsx";
import { YearGrid } from "./year-grid.tsx";

/**
 * Public canvas slot consumed by CalendarWorkspace. All state arrives through
 * the projection and callbacks; this component never starts an effect or
 * reaches a service boundary.
 */
export function CalendarCanvas({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel,
  class: className,
  className: classNameAlias,
  ...callbacks
}: CalendarCanvasProps): JSX.Element {
  const resolvedClassName = ["calendar-canvas", className ?? classNameAlias].filter(Boolean).join(" ");

  if (!projection) {
    return (
      <section
        class={resolvedClassName}
        data-calendar-canvas="true"
        data-calendar-loading={loading ? "true" : "false"}
        aria-busy={loading}
        aria-label="Calendar"
      >
        {loading ? <CalendarLoadingState refreshing={refreshing} /> : <CalendarEmptyState label={emptyLabel ?? "Calendar is unavailable."} />}
      </section>
    );
  }

  const emptyLabelProps = emptyLabel === undefined ? {} : { emptyLabel };
  const content =
    projection.kind === "day" ? (
      <DayView projection={projection} loading={loading} refreshing={refreshing} {...emptyLabelProps} {...callbacks} />
    ) : projection.kind === "week" ? (
      <WeekGrid projection={projection} loading={loading} refreshing={refreshing} {...emptyLabelProps} {...callbacks} />
    ) : projection.kind === "month" ? (
      <MonthGrid projection={projection} loading={loading} refreshing={refreshing} {...emptyLabelProps} {...callbacks} />
    ) : (
      <YearGrid projection={projection} loading={loading} refreshing={refreshing} {...emptyLabelProps} {...callbacks} />
    );

  return (
    <section
      class={resolvedClassName}
      data-calendar-canvas="true"
      data-calendar-canvas-view={projection.kind}
      data-calendar-loading={loading ? "true" : "false"}
      aria-busy={loading}
      aria-label={`${projection.kind[0]?.toUpperCase() ?? ""}${projection.kind.slice(1)} calendar canvas`}
    >
      {content}
    </section>
  );
}

export const CalendarCanvasRenderer = CalendarCanvas;

export type { CalendarCanvasProps, CalendarCanvasSlot, CalendarCanvasSlotProps } from "./calendar-canvas-types.ts";
export {
  AgendaRow,
  AgendaSection,
  DayCell,
  EventIndicator,
  OverflowControl,
} from "./calendar-canvas-primitives.tsx";
export { DayView } from "./day-view.tsx";
export { WeekGrid } from "./week-grid.tsx";
export { MonthGrid } from "./month-grid.tsx";
export { YearGrid } from "./year-grid.tsx";
export type * from "./calendar-canvas-types.ts";
