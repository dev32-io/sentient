import { describe, expect, it } from "vitest";
import type { CalendarOccurrenceV2 } from "../../services/calendar-api.ts";
import { projectCalendarDensity } from "./calendar-density.ts";
import { deriveCalendarProjection, filterCalendarOccurrences } from "./calendar-filters.ts";
import { projectCalendarOccurrence } from "./calendar-occurrence.ts";
import {
  createCalendarNavigationState,
  nextCalendarInterval,
  previousCalendarInterval,
  projectCalendar,
  projectDay,
  projectMonth,
  projectWeek,
  projectYear,
  selectCalendarDate,
  selectCalendarMonth,
  todayCalendar,
} from "./calendar-projections.ts";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarTimeFromInput,
  formatCalendarInputValue,
  formatCalendarTime,
  localeWeekStart,
  parseCalendarInput,
  parseCalendarInputWithOffset,
} from "./calendar-time.ts";

function occurrence(overrides: Partial<CalendarOccurrenceV2> = {}): CalendarOccurrenceV2 {
  return {
    eventId: "event-1",
    occurrenceId: "event-1@2024-02-29T09:00:00-05:00",
    originalStart: "2024-02-29T09:00:00-05:00",
    recurring: false,
    revision: 3,
    scope: "private",
    title: "Event",
    start: "2024-02-29T09:00:00-05:00",
    visibility: "everyone",
    importance: "normal",
    tags: [],
    ...overrides,
  };
}

describe("calendar-time", () => {
  it("shares editor/display formatting and parses DST wall-clock values", () => {
    const instant = "2026-08-05T13:00:00.000Z";
    const input = formatCalendarInputValue(instant, "America/Toronto");
    expect(input).toBe("2026-08-05T09:00");
    expect(parseCalendarInput(input, "America/Toronto")).toBe(instant);
    expect(parseCalendarInputWithOffset(input, "America/Toronto")).toBe("2026-08-05T09:00:00-04:00");
    expect(parseCalendarInputWithOffset("2026-11-01T09:00", "America/Toronto")).toBe("2026-11-01T09:00:00-05:00");
    expect(parseCalendarInput("2026-03-08T02:30", "America/Toronto")).toBeNull();
    expect(calendarTimeFromInput("2026-08-05", { allDay: true, inputTimeZoneId: "Pacific/Kiritimati" })).toEqual({
      kind: "all-day",
      date: "2026-08-05",
    });
    expect(
      formatCalendarTime({ kind: "timed", instant, timeZoneId: "UTC" }, { timeZone: "America/Toronto" }),
    ).toContain("9:00");
  });

  it("keeps date arithmetic and locale week starts date-only", () => {
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addCalendarMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(localeWeekStart("en-US")).toBe(0);
    expect(localeWeekStart("en-GB")).toBe(1);
  });
});

describe("calendar projections", () => {
  it("creates a focused chronological day agenda and preserves V2 action identity", () => {
    const later = occurrence({
      eventId: "event-2",
      occurrenceId: "event-2@2024-02-29T10:00:00-05:00",
      originalStart: "2024-02-29T10:00:00-05:00",
      start: "2024-02-29T10:00:00-05:00",
      title: "Later",
    });
    const first = occurrence({ title: "First" });
    const projection = projectDay([later, first], "2024-02-29", {
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      today: "2024-02-29",
    });
    expect(projection.events.map((event) => event.title)).toEqual(["First", "Later"]);
    expect(projection.events[0]).toMatchObject({
      eventId: "event-1",
      occurrenceId: "event-1@2024-02-29T09:00:00-05:00",
      originalStart: "2024-02-29T09:00:00-05:00",
      rawOriginalStart: "2024-02-29T09:00:00-05:00",
      revision: 3,
      scope: "private",
      action: {
        eventId: "event-1",
        occurrenceId: "event-1@2024-02-29T09:00:00-05:00",
        originalStart: "2024-02-29T09:00:00-05:00",
        revision: 3,
        scope: "private",
      },
    });
    expect(projection.events[0]?.start.localDate).toBe("2024-02-29");

    const allDay = projectCalendarOccurrence(
      occurrence({ start: "2024-02-29", originalStart: "2024-02-29", title: "All day" }),
      { timeZone: "Pacific/Honolulu" },
    );
    expect(allDay.start).toMatchObject({
      kind: "all-day",
      raw: "2024-02-29",
      date: "2024-02-29",
      localDate: "2024-02-29",
    });
  });

  it("generates locale-aware seven-date weeks and an exact 42-cell month", () => {
    const week = projectWeek([], "2024-02-29", { locale: "en-GB", today: "2024-02-29" });
    expect(week.dates).toHaveLength(7);
    expect(week.dates[0]).toBe("2024-02-26");
    expect(week.dates[6]).toBe("2024-03-03");

    const month = projectMonth([], "2024-02-29", { locale: "en-US", today: "2024-02-29" });
    expect(month.cells).toHaveLength(42);
    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.every((row) => row.length === 7)).toBe(true);
    expect(month.cells[0]?.date).toBe("2024-01-28");
    expect(month.cells[0]?.outsideMonth).toBe(true);
    expect(month.cells.find((cell) => cell.date === "2024-02-29")?.selected).toBe(true);
  });

  it("generates complete leap-year month summaries and retains day 29-31", () => {
    const year = projectYear([], "2024-06-15", { locale: "en-US", today: "2024-06-15" });
    expect(year.months).toHaveLength(12);
    expect(year.months[1]?.dates).toHaveLength(29);
    expect(year.months[0]?.dates.slice(-3)).toEqual(["2024-01-29", "2024-01-30", "2024-01-31"]);
    expect(year.months[2]?.dates.slice(-3)).toEqual(["2024-03-29", "2024-03-30", "2024-03-31"]);
    expect(year.months.every((month) => month.days.length === month.dates.length)).toBe(true);
  });

  it("steps the active interval without replacing the explicit selected date", () => {
    const state = createCalendarNavigationState({
      view: "month",
      anchorDate: "2024-01-31",
      selectedDate: "2024-01-15",
      today: "2024-01-15",
    });
    expect(nextCalendarInterval(state)).toEqual({
      view: "month",
      anchorDate: "2024-02-29",
      selectedDate: "2024-01-15",
    });
    expect(previousCalendarInterval(state)).toEqual({
      view: "month",
      anchorDate: "2023-12-31",
      selectedDate: "2024-01-15",
    });
    expect(selectCalendarDate({ ...state, view: "month" }, "2024-02-05")).toMatchObject({
      view: "day",
      anchorDate: "2024-02-05",
      selectedDate: "2024-02-05",
    });
    expect(selectCalendarDate({ ...state, view: "week" }, "2024-02-05")).toMatchObject({
      view: "week",
      anchorDate: "2024-02-05",
      selectedDate: "2024-02-05",
    });
    expect(selectCalendarMonth({ ...state, view: "year" }, "2024-05-20")).toMatchObject({
      view: "month",
      anchorDate: "2024-05-01",
      selectedDate: "2024-05-20",
    });
    expect(todayCalendar(state, "2025-01-01")).toEqual({
      view: "month",
      anchorDate: "2025-01-01",
      selectedDate: "2025-01-01",
    });
  });
});

describe("calendar filtering, facets, and density", () => {
  const rows = [
    occurrence({
      eventId: "private-health",
      occurrenceId: "private-health@1",
      title: "Dentist appointment",
      scope: "private",
      group: "health",
      tags: ["family", "urgent"],
      importance: "important",
    }),
    occurrence({
      eventId: "household-school",
      occurrenceId: "household-school@1",
      title: "School meeting",
      scope: "household",
      group: "school",
      tags: ["family"],
      importance: "normal",
    }),
    occurrence({
      eventId: "private-home",
      occurrenceId: "private-home@1",
      title: "Dentist notes",
      scope: "private",
      group: "health",
      tags: ["home"],
      importance: "important",
    }),
  ];

  it("intersects supported filters and derives facets from complete authorized data", () => {
    const filters = {
      scope: "all" as const,
      groups: ["health"],
      tags: ["urgent"],
      importance: "important" as const,
      text: "dentist",
    };
    expect(filterCalendarOccurrences(rows, filters).map((row) => row.eventId)).toEqual(["private-health"]);
    const result = deriveCalendarProjection(rows, {
      ...filters,
      groups: ["health", "missing"],
      tags: ["urgent", "missing"],
    });
    expect(result.filtered).toHaveLength(0);
    expect(result.facets.groupOptions).toEqual(["health", "missing", "school"]);
    expect(result.facets.groups.find((option) => option.value === "missing")).toMatchObject({
      count: 0,
      selected: true,
    });
    expect(result.facets.tags.find((option) => option.value === "missing")).toMatchObject({ count: 0, selected: true });
    expect(result.facets.scopeOptions).toEqual(["all", "household", "private"]);
  });

  it("retains full access names while choosing compact density representations", () => {
    const projected = rows.map((row) =>
      projectCalendarOccurrence(row, { timeZone: "America/Toronto", locale: "en-US" }),
    );
    const density = projectCalendarDensity(projected, {
      mode: "dot",
      maxVisibleEvents: 1,
      dateLabel: "Thursday, February 29, 2024",
    });
    expect(density.events).toHaveLength(3);
    expect(density.visibleEvents).toHaveLength(1);
    expect(density.overflowEvents).toHaveLength(2);
    expect(density.overflowCount).toBe(2);
    expect(density.overflowLabel).toBe("+2 more events on Thursday, February 29, 2024");
    expect(density.events[0]?.visualLabel).toBe("");
    expect(density.events[0]?.accessibleName).toContain("Dentist appointment");
  });

  it("projects a complete filtered view through one pure derivation seam", () => {
    const result = projectCalendar({
      occurrences: rows,
      view: "month",
      anchorDate: "2024-02-29",
      selectedDate: "2024-02-29",
      today: "2024-02-29",
      locale: "en-US",
      timeZone: "America/Toronto",
      filters: { scope: "private", text: "dentist" },
    });
    expect(result.view.kind).toBe("month");
    if (result.view.kind !== "month") throw new Error("expected month projection");
    expect(result.view.cells).toHaveLength(42);
    expect(result.projectedOccurrences.map((event) => event.eventId)).toEqual(["private-health", "private-home"]);
    expect(result.events).toBe(result.projectedOccurrences);
  });
});
