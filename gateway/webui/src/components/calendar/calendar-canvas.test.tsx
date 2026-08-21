import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { CalendarOccurrenceV2 } from "../../services/calendar-api.ts";
import {
  projectCalendar,
  projectDay,
  projectYear,
} from "./calendar-projections.ts";
import { CalendarCanvas, DayView, MonthGrid, WeekGrid, YearGrid } from "./calendar-canvas.tsx";

function occurrence(overrides: Partial<CalendarOccurrenceV2> = {}): CalendarOccurrenceV2 {
  const start = overrides.start ?? "2024-02-29T09:00:00Z";
  return {
    eventId: "event-1",
    occurrenceId: "event-1@2024-02-29T09:00:00Z",
    originalStart: start,
    recurring: false,
    revision: 1,
    scope: "private",
    title: "Event",
    start,
    visibility: "everyone",
    importance: "normal",
    tags: [],
    ...overrides,
  };
}

function projection(view: "day" | "week" | "month" | "year", rows: readonly CalendarOccurrenceV2[] = []) {
  return projectCalendar({
    occurrences: rows,
    view,
    anchorDate: "2024-02-29",
    selectedDate: "2024-02-29",
    today: "2024-02-29",
    locale: "en-US",
    timeZone: "UTC",
    density: { maxVisibleEvents: 2, maxIndicators: 3 },
  }).view;
}

describe("CalendarCanvas", () => {
  it("satisfies the public projection-and-callback slot for all four views", () => {
    for (const view of ["day", "week", "month", "year"] as const) {
      const result = render(<CalendarCanvas projection={projection(view)} />);
      expect(result.container.querySelector(`[data-calendar-canvas-view="${view}"]`)).toBeTruthy();
      result.unmount();
    }
  });

  it("renders loading without requiring a private shell or network boundary", () => {
    render(<CalendarCanvas projection={null} loading />);
    expect(screen.getByRole("status").textContent).toContain("Loading calendar");
    expect(screen.getByRole("region", { name: "Calendar" }).getAttribute("aria-busy")).toBe("true");
  });

  it("renders a focused chronological Day agenda and keeps empty semantics", () => {
    const rows = [
      occurrence({ eventId: "later", occurrenceId: "later@1", title: "Later", start: "2024-02-29T11:00:00Z" }),
      occurrence({ eventId: "first", occurrenceId: "first@1", title: "First", start: "2024-02-29T08:00:00Z" }),
    ];
    render(<DayView projection={projection("day", rows) as Extract<ReturnType<typeof projection>, { kind: "day" }>} />);
    const events = [...document.querySelectorAll("[data-calendar-event]")].map((node) => node.getAttribute("aria-label"));
    expect(events[0]).toContain("First");
    expect(events[1]).toContain("Later");

    const empty = render(<DayView projection={projectDay([], "2024-02-29", { locale: "en-US", today: "2024-02-29" })} />);
    expect(within(empty.container as HTMLElement).getByText("No events on this day.")).toBeTruthy();
  });

  it("keeps Month at six rows by seven cells and announces today, selected, and outside dates", () => {
    const result = render(<MonthGrid projection={projection("month") as Extract<ReturnType<typeof projection>, { kind: "month" }>} />);
    expect(result.container.querySelectorAll(".calendar-month-grid__row")).toHaveLength(6);
    expect(result.container.querySelectorAll(".calendar-month-grid__row:first-child > [role=gridcell]")).toHaveLength(7);
    expect(result.container.querySelectorAll("[data-calendar-date]")).toHaveLength(42);
    expect(result.container.querySelector('[data-calendar-date="2024-02-29"]')?.getAttribute("data-today")).toBe("true");
    expect(result.container.querySelector('[data-calendar-date="2024-02-29"]')?.getAttribute("data-selected")).toBe("true");
    expect(result.container.querySelector('[data-calendar-date="2024-01-28"]')?.getAttribute("data-outside-month")).toBe("true");
    expect(screen.getByRole("button", { name: /Thursday, February 29, 2024, today, selected/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps Week at seven equal date cells and routes date selection through callbacks", () => {
    const onSelectDate = vi.fn();
    const result = render(
      <WeekGrid
        projection={projection("week") as Extract<ReturnType<typeof projection>, { kind: "week" }>}
        onSelectDate={onSelectDate}
      />,
    );
    expect(result.container.querySelectorAll(".calendar-week-grid__grid > [role=gridcell]")).toHaveLength(7);
    fireEvent.click(result.container.querySelector(".calendar-week-grid__grid [role=gridcell] button") as HTMLButtonElement);
    expect(onSelectDate).toHaveBeenCalledWith("2024-02-25");
  });

  it("exposes dense overflow as a reachable action while retaining full event names", () => {
    const rows = [1, 2, 3, 4].map((index) =>
      occurrence({
        eventId: `dense-${index}`,
        occurrenceId: `dense-${index}@1`,
        title: `Dense event ${index} with a complete title`,
        start: `2024-02-29T${String(8 + index).padStart(2, "0")}:00:00Z`,
      }),
    );
    const onOpenOverflow = vi.fn();
    render(
      <CalendarCanvas
        projection={projection("month", rows)}
        onOpenOverflow={onOpenOverflow}
      />,
    );
    const overflow = screen.getByRole("button", { name: /more events on Thursday, February 29, 2024/i });
    expect(overflow.getAttribute("data-overflow-date")).toBe("2024-02-29");
    expect(screen.getByRole("button", { name: /Dense event 3 with a complete title/i })).toBeTruthy();
    fireEvent.click(overflow);
    expect(onOpenOverflow).toHaveBeenCalledWith("2024-02-29", expect.arrayContaining([expect.objectContaining({ title: "Dense event 4 with a complete title" })]));
  });

  it("renders every valid Year date, including 29, 30, and 31", () => {
    const result = render(<YearGrid projection={projectYear([], "2024-06-15", { locale: "en-US", today: "2024-06-15" })} />);
    expect(result.container.querySelectorAll("[data-calendar-year-date]")).toHaveLength(366);
    expect(result.container.querySelector('[data-calendar-year-date="2024-02-29"]')).toBeTruthy();
    expect(result.container.querySelector('[data-calendar-year-date="2024-03-30"]')).toBeTruthy();
    expect(result.container.querySelector('[data-calendar-year-date="2024-12-31"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: /Select February 2024/i })).toBeTruthy();
  });

  it("keeps selected date buttons natively focusable and announces event names in dot mode", () => {
    const rows = [occurrence({ title: "Accessible dot event" })];
    render(<CalendarCanvas projection={projection("month", rows)} />);
    const dateButton = document.querySelector('[data-calendar-date="2024-02-29"] .calendar-day-cell__date') as HTMLButtonElement;
    dateButton.focus();
    expect(document.activeElement).toBe(dateButton);
    expect(dateButton.getAttribute("aria-current")).toBe("date");
    const eventButton = screen.getByRole("button", { name: /Accessible dot event/i });
    expect(eventButton.getAttribute("aria-label")).toContain("Accessible dot event");
  });
});
