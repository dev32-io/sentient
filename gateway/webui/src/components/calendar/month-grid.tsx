import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { projectCalendarDensity } from "./calendar-density.ts";
import {
  CalendarEmptyState,
  CalendarLoadingState,
  DayCell,
  weekdayShortLabel,
} from "./calendar-canvas-primitives.tsx";
import type { MonthGridProps } from "./calendar-canvas-types.ts";
import { formatAccessibleCalendarDate } from "./calendar-time.ts";

function monthLabel(year: number, month: number, locale: string): string {
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` as `${number}-${number}-${number}`;
  try {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00.000Z`),
    );
  } catch {
    return formatAccessibleCalendarDate(date, { locale });
  }
}

export function MonthGrid({
  projection,
  loading = false,
  refreshing = false,
  emptyLabel = "No events this month.",
  ...callbacks
}: MonthGridProps): JSX.Element {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [dayAccessOnly, setDayAccessOnly] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver !== "function") return;
    const pointer = window.matchMedia("(pointer: coarse)");
    const update = (rect: Pick<DOMRectReadOnly, "width" | "height">) => {
      if (rect.height <= 0) return;
      const metrics = getComputedStyle(grid);
      const dateSpace = Number.parseFloat(metrics.getPropertyValue("--calendar-date-space"));
      const eventHeight = Number.parseFloat(metrics.getPropertyValue("--calendar-event-height"));
      const overflowHeight = Number.parseFloat(metrics.getPropertyValue("--calendar-overflow-height"));
      const coarse = pointer.matches;
      const target = coarse ? 46 : eventHeight;
      const dateTarget = coarse ? 48 : dateSpace;
      const overflowTarget = coarse ? 44 : overflowHeight;
      // A narrow column cannot carry readable independent event targets. A
      // single date/count target opens the existing complete Day agenda.
      const combined = rect.width / 7 < 100
        || rect.height / 6 < dateTarget + overflowTarget;
      setDayAccessOnly(combined);
      const limit = combined ? 0 : Math.max(0, Math.min(3,
        Math.floor((rect.height / 6 - dateTarget - overflowTarget) / target)));
      if (Number.isFinite(limit)) setVisibleLimit(limit);
    };
    const observer = new ResizeObserver(([entry]) => { if (entry) update(entry.contentRect); });
    const pointerChanged = () => update(grid.getBoundingClientRect());
    pointer.addEventListener?.("change", pointerChanged);
    observer.observe(grid);
    return () => {
      observer.disconnect();
      pointer.removeEventListener?.("change", pointerChanged);
    };
  }, []);
  const hasEvents = projection.cells.some((cell) => cell.eventCount > 0);
  const firstWeek = projection.weeks[0] ?? [];
  return (
    <section
      class="calendar-month-grid"
      data-calendar-view="month"
      data-calendar-canvas-view="month"
      aria-label={`Month view for ${monthLabel(projection.year, projection.month, projection.locale)}`}
      aria-busy={loading || refreshing}
    >
      {loading && <CalendarLoadingState refreshing={refreshing} />}
      <div class="calendar-month-grid__weekdays" role="row" aria-label="Weekdays">
        {firstWeek.map((cell) => (
          <div key={`weekday-${cell.date}`} class="calendar-month-grid__weekday" role="columnheader">
            <span aria-hidden="true">{weekdayShortLabel(cell.date, projection.locale)}</span>
            <span class="calendar-canvas__sr-only">{cell.accessibleLabel}</span>
          </div>
        ))}
      </div>
      <div ref={gridRef} class="calendar-month-grid__grid" role="grid" aria-label="Six week month calendar grid">
        {projection.weeks.map((week, weekIndex) => (
          <div key={`week-${weekIndex}`} class="calendar-month-grid__row" role="row">
            {week.map((cell) => {
              const density = visibleLimit === null ? cell.density : projectCalendarDensity(
                cell.density.events.map((presentation) => presentation.event),
                { mode: cell.density.mode, maxVisibleEvents: Math.min(visibleLimit, cell.density.visibleEvents.length), dateLabel: cell.accessibleLabel },
              );
              return <DayCell dayAccessOnly={dayAccessOnly} key={cell.date} cell={{ ...cell, density, overflowCount: density.overflowCount }} {...callbacks} />;
            })}
          </div>
        ))}
      </div>
      {!loading && !hasEvents && <CalendarEmptyState label={emptyLabel} />}
    </section>
  );
}
