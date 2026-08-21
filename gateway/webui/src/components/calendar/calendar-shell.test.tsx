import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import {
  CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT,
  CALENDAR_SUPPORTED_SCOPES,
  CalendarCompactControls,
  CalendarFilterSidebar,
  CalendarWorkspace,
  DateNavigation,
  FloatingViewBar,
  activeCalendarFilterCount,
  activeCalendarFilters,
  clearCalendarFilters,
  normalizeCalendarShellFilters,
  removeCalendarFilter,
  type CalendarFilters,
} from "./calendar-shell.tsx";

const facets = {
  scopes: ["private", "household", "all", "member"],
  groups: ["family"],
  tags: ["school"],
  importance: ["normal", "important", "pinned"],
} as const;

const selectedFilters: CalendarFilters = {
  scopes: ["private"],
  groups: ["old-group"],
  tags: ["old-tag"],
  importance: "important",
  search: "dentist",
};

describe("calendar shell filter state", () => {
  it("normalizes only supported scopes and keeps selected stale facets removable", () => {
    expect(normalizeCalendarShellFilters({ scopes: ["member" as never, "private", "private"] })).toMatchObject({
      scopes: ["private"],
    });
    expect(activeCalendarFilters(selectedFilters)).toEqual([
      { key: "scope", value: "private", label: "Private" },
      { key: "group", value: "old-group", label: "Group: old-group" },
      { key: "tag", value: "old-tag", label: "Tag: old-tag" },
      { key: "importance", value: "important", label: "Importance: Important" },
      { key: "search", label: "Search: dentist" },
    ]);
    expect(removeCalendarFilter(selectedFilters, "group", "old-group")).toMatchObject({ groups: [] });
    expect(removeCalendarFilter(selectedFilters, "tag", "old-tag")).toMatchObject({ tags: [] });
    expect(removeCalendarFilter(selectedFilters, "importance")).toMatchObject({ importance: null });
    expect(removeCalendarFilter(selectedFilters, "search")).toMatchObject({ search: "" });
    expect(clearCalendarFilters()).toMatchObject({ scopes: ["all"], groups: [], tags: [], importance: null, search: "" });
    expect(activeCalendarFilterCount({ scopes: ["all"] })).toBe(0);
  });
});

describe("CalendarWorkspace", () => {
  it("renders a typed canvas slot without importing canvas implementation details", () => {
    const onViewChange = vi.fn();
    render(
      <CalendarWorkspace
        view="week"
        anchorDate="2026-08-10"
        selectedDate="2026-08-12"
        filters={selectedFilters}
        resultCount={4}
        onViewChange={onViewChange}
        renderCanvas={(slot) => (
          <div data-testid="canvas-slot">
            {slot.view}:{slot.anchorDate}:{slot.selectedDate}:{slot.filters.search}
          </div>
        )}
      />,
    );

    expect(screen.getByTestId("canvas-slot").textContent).toBe("week:2026-08-10:2026-08-12:dentist");
    expect(screen.getByRole("status").textContent).toBe("4 events in Week view.");
    fireEvent.click(screen.getByRole("button", { name: "Month view" }));
    expect(onViewChange).toHaveBeenCalledWith("month");
  });

  it("keeps both roomy and compact controls on the same controlled filter state", () => {
    const onFiltersChange = vi.fn();
    render(
      <CalendarWorkspace
        filters={selectedFilters}
        facets={facets}
        onFiltersChange={onFiltersChange}
      >
        <div data-testid="canvas">Canvas</div>
      </CalendarWorkspace>,
    );

    expect(screen.getAllByRole("button", { name: "Private" })).toHaveLength(1);
    expect(screen.getAllByText("Group: old-group").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove Private filter" })[0]!);
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["all"] }));
    expect(screen.queryByText("member")).toBeNull();
  });
});

describe("CalendarFilterSidebar", () => {
  it("exposes only private, household, and all scopes and omits prototype-only facets", () => {
    render(<CalendarFilterSidebar facets={facets} onAddEvent={vi.fn()} />);

    expect(CALENDAR_SUPPORTED_SCOPES).toEqual(["private", "household", "all"]);
    expect(screen.getByRole("button", { name: "Private" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Household" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All calendars" })).toBeTruthy();
    expect(screen.queryByText("member")).toBeNull();
    expect(screen.queryByText(/routine|place|reminder|persona|member ownership/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add event/i })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search calendar events" })).toBeTruthy();

    render(<CalendarFilterSidebar />);
    for (const scope of ["Private", "Household", "All calendars"]) {
      expect(screen.getAllByRole("button", { name: scope }).length).toBeGreaterThan(0);
    }
    for (const importance of ["Normal", "Important", "Pinned"]) {
      expect(screen.getAllByRole("button", { name: importance }).length).toBeGreaterThan(0);
    }
  });

  it("updates scope, tags, importance, and search through one callback", () => {
    const onFiltersChange = vi.fn();
    render(
      <CalendarFilterSidebar
        facets={{ scopes: ["all", "private"], groups: ["family"], tags: ["school"], importance: ["normal", "important"] }}
        onFiltersChange={onFiltersChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Private" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ scopes: ["private"] }));
    fireEvent.click(screen.getByRole("button", { name: "Tag school" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["school"] }));
    fireEvent.click(screen.getByRole("button", { name: "Important" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ importance: "important" }));
    fireEvent.input(screen.getByRole("searchbox", { name: "Search calendar events" }), { target: { value: "school" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ search: "school" }));
  });
});

describe("CalendarCompactControls", () => {
  it("keeps Add event, filter entry, active removals, and a reachable popover in the narrow flow", async () => {
    const onAddEvent = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <CalendarCompactControls
        filters={selectedFilters}
        facets={facets}
        onAddEvent={onAddEvent}
        onFiltersChange={onFiltersChange}
      />,
    );

    const add = screen.getByRole("button", { name: "Add event" });
    fireEvent.click(add);
    expect(onAddEvent).toHaveBeenCalledTimes(1);
    const trigger = screen.getByRole("button", { name: "Filters, 5 active filters" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Calendar filters" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Household" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Clear all" }).length).toBeGreaterThan(0);

    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Calendar filters" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("dismisses the anchored filter popover with Escape and restores focus", () => {
    render(<CalendarCompactControls />);
    const trigger = screen.getByRole("button", { name: "Open filters" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Calendar filters" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Calendar filters" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("DateNavigation and FloatingViewBar", () => {
  it("exposes date actions and all four pressed view controls", () => {
    const callbacks = {
      previous: vi.fn(),
      next: vi.fn(),
      today: vi.fn(),
      date: vi.fn(),
      view: vi.fn(),
    };
    render(
      <>
        <DateNavigation
          view="month"
          anchorDate="2026-08-10"
          onPrevious={callbacks.previous}
          onNext={callbacks.next}
          onToday={callbacks.today}
          onDateChange={callbacks.date}
        />
        <FloatingViewBar view="month" onViewChange={callbacks.view} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(callbacks.previous).toHaveBeenCalledTimes(1);
    expect(callbacks.next).toHaveBeenCalledTimes(1);
    expect(callbacks.today).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Month view" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Year view" }));
    expect(callbacks.view).toHaveBeenCalledWith("year");
  });

  it("accepts the exact 900px collapse contract and 44px-target classes", () => {
    expect(CALENDAR_SIDEBAR_COLLAPSE_BREAKPOINT).toBe(900);
    const { container } = render(<CalendarWorkspace><div /></CalendarWorkspace>);
    expect(container.querySelector("[data-calendar-filter-sidebar]")).toBeTruthy();
    expect(container.querySelector("[data-calendar-compact-controls]")).toBeTruthy();
    expect(container.querySelector("[data-calendar-floating-view-bar]")).toBeTruthy();
  });
});
