import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { CalendarActiveFilterSummary, CalendarWorkspace } from "./index.ts";
import type { CalendarWorkspaceModel } from "./calendar-product-api.ts";
import { projectCalendar } from "./calendar-projections.ts";

const model: CalendarWorkspaceModel = {
  view: "week",
  selectedView: "week",
  anchorDate: "2026-08-10",
  selectedDate: "2026-08-12",
  filters: { scopes: ["all"], groups: [], tags: [], importance: null, search: "" },
  projection: projectCalendar({
    occurrences: [],
    view: "week",
    anchorDate: "2026-08-10",
    selectedDate: "2026-08-12",
    locale: "en-US",
    weekStartsOn: 1,
    today: "2026-08-10",
  }).view,
  resultCount: 0,
};

describe("Calendar product API", () => {
  it("keeps the public workspace seam to one model and canonical intent set", () => {
    const onPrevious = vi.fn();
    const onViewChange = vi.fn();
    let received: CalendarWorkspaceModel["projection"] = null;
    render(
      <CalendarWorkspace
        model={model}
        actions={{ onPrevious, onViewChange }}
        renderCanvas={(slot) => {
          received = slot.projection;
          return <div data-testid="calendar-product-slot">{slot.view}:{slot.anchorDate}:{slot.selectedDate}</div>;
        }}
      />,
    );

    expect(screen.getByTestId("calendar-product-slot").textContent).toBe("week:2026-08-10:2026-08-12");
    expect(received).toBe(model.projection);
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith("month");
  });

  it("exposes removable active-filter actions without owning filter state", () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(
      <CalendarActiveFilterSummary
        filters={{ scopes: ["private"], groups: ["family"], search: "school" }}
        onRemove={onRemove}
        onClearFilters={onClear}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Group: family filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onRemove).toHaveBeenCalledWith("group", "family");
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
