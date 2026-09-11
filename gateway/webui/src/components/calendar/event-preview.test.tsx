import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useRef, useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarOccurrence } from "../../services/calendar-api.ts";
import { projectCalendarOccurrence } from "./calendar-occurrence.ts";
import type { ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import { createEventPreviewModel } from "./event-preview-details.ts";
import { EventPreview } from "./event-preview.tsx";

const source: CalendarOccurrence = {
  id: "event-1",
  eventId: "event-1",
  occurrenceId: "event-1@2026-08-10T09:00-04:00",
  baseEventId: "event-1",
  originalStart: { kind: "timed", instant: "2026-08-10T13:00:00.000Z", timeZoneId: "America/Toronto" },
  occurrenceStart: { kind: "timed", instant: "2026-08-10T13:00:00.000Z", timeZoneId: "America/Toronto" },
  scope: "household",
  title: "Family planning",
  description: "Review the school and travel plans.",
  start: { kind: "timed", instant: "2026-08-10T13:00:00.000Z", timeZoneId: "America/Toronto" },
  end: { kind: "timed", instant: "2026-08-10T14:30:00.000Z", timeZoneId: "America/Toronto" },
  recurrence: { frequency: "weekly", weekdays: ["monday", "wednesday"], count: 6 },
  recurring: true,
  visibility: "everyone",
  importance: "important",
  group: "School",
  tags: ["family", "school"],
};

const projected = projectCalendarOccurrence(source, { locale: "en-US", timeZone: "UTC" });

function PreviewHarness({
  onEdit = vi.fn(),
  onDelete = vi.fn(),
}: {
  onEdit?: (event: ProjectedCalendarOccurrence) => void;
  onDelete?: (event: ProjectedCalendarOccurrence) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>Open event</button>
      <EventPreview
        occurrence={projected}
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        onEdit={onEdit}
        onDelete={onDelete}
        viewport={{ width: 390, height: 844 }}
      />
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("createEventPreviewModel", () => {
  it("maps supported effective fields and excludes prototype-only semantics", () => {
    const model = createEventPreviewModel(projected, { locale: "en-US", timeZone: "UTC" });
    const byKey = new Map(model.details.map((item) => [item.key, item.value]));
    expect(model.occurrence.action).toEqual({
      eventId: "event-1",
      occurrenceId: "event-1@2026-08-10T09:00-04:00",
      originalStart: "2026-08-10T13:00:00.000Z",
      scope: "household",
    });
    expect(model.description).toBe("Review the school and travel plans.");
    expect(byKey.get("timezone")).toBe("America/Toronto");
    expect(byKey.get("scope")).toBe("Household");
    expect(byKey.get("visibility")).toBe("Everyone");
    expect(byKey.get("importance")).toBe("Important");
    expect(byKey.get("group")).toBe("School");
    expect(byKey.get("tags")).toBe("family, school");
    expect(byKey.get("recurrence")).toContain("Weekly");
    expect(byKey.get("recurrence")).toContain("Monday, Wednesday");
    expect(byKey.get("recurrence")).toContain("6 occurrences");
    expect([...byKey.values()].join(" ")).not.toMatch(/place|reminder|color|member/i);
  });

  it("keeps all-day identity date-only and does not invent a timezone", () => {
    const allDaySource: CalendarOccurrence = {
      ...source,
      title: "School holiday",
      start: { kind: "all-day", date: "2026-08-11" },
      occurrenceStart: { kind: "all-day", date: "2026-08-11" },
      originalStart: { kind: "all-day", date: "2026-08-11" },
      recurring: false,
      tags: [],
    };
    delete allDaySource.end;
    delete allDaySource.recurrence;
    const allDay = projectCalendarOccurrence(allDaySource, { locale: "en-US", timeZone: "UTC" });
    const model = createEventPreviewModel(allDay, { locale: "en-US", timeZone: "UTC" });
    expect(model.details.find((item) => item.key === "when")?.value).toContain("All day");
    expect(model.details.some((item) => item.key === "timezone")).toBe(false);
  });
});

describe("EventPreview", () => {
  it("keeps hidden content absent from the accessibility tree", () => {
    render(<EventPreview occurrence={projected} open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-event-preview]")).toBeNull();
  });

  it("opens a named dialog, exposes action identity, and restores the originating control on edit", async () => {
    const onEdit = vi.fn();
    render(<PreviewHarness onEdit={onEdit} />);
    const trigger = screen.getByRole("button", { name: "Open event" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Family planning" });
    expect(dialog.getAttribute("data-event-id")).toBe("event-1");
    expect(dialog.getAttribute("data-occurrence-id")).toBe(projected.action.occurrenceId);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close event details" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(projected);
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("emits delete with the same occurrence identity and bounds the scroll surface", async () => {
    const onDelete = vi.fn();
    render(<PreviewHarness onDelete={onDelete} />);
    const trigger = screen.getByRole("button", { name: "Open event" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(projected);
    expect(dialog.style.maxHeight).toBe("820px");
    expect(dialog.querySelector("[data-scrollable='true']")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes through the close button and Escape and restores focus", async () => {
    render(<PreviewHarness />);
    const trigger = screen.getByRole("button", { name: "Open event" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close event details" }));
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("dismisses a safe outside click but keeps focus inside the dialog while open", async () => {
    render(<PreviewHarness />);
    const trigger = screen.getByRole("button", { name: "Open event" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Close event details" });
    const edit = screen.getByRole("button", { name: "Edit" });
    const deleteButton = screen.getByRole("button", { name: "Delete" });

    edit.focus();
    deleteButton.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(deleteButton);
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    fireEvent.mouseDown(document.body);
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the complete supported title and time in the scroll body, separate from persistent controls", async () => {
    const title = "Synthetic calendar planning title ".repeat(16).slice(0, 512);
    const description = "Synthetic description. ".repeat(200);
    render(<EventPreview occurrence={{ ...projected, title, description }} open onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} viewport={{ width: 640, height: 450 }} />);
    const dialog = await screen.findByRole("dialog", { name: title });
    const body = dialog.querySelector("[data-scrollable='true']")!;
    const heading = screen.getByRole("heading", { name: title });
    expect(heading.textContent).toBe(title);
    expect(heading.id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(body.contains(heading)).toBe(true);
    expect(body.querySelector("[aria-label^='When:']")).toBeTruthy();
    expect(body.querySelector("#" + dialog.getAttribute("aria-describedby"))?.textContent).toBe(description);
    for (const name of ["Close event details", "Edit", "Delete"]) {
      expect(body.contains(screen.getByRole("button", { name }))).toBe(false);
    }
    expect(dialog.style.maxHeight).toBe("426px");
  });

  it("marks reduced motion without suppressing the open state", async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    render(<EventPreview occurrence={projected} open onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-reduced-motion")).toBe("true");
    expect(dialog.getAttribute("data-open")).toBe("true");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });
});
