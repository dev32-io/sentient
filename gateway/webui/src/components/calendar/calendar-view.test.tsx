import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { CalendarApi, CalendarOccurrence } from "../../services/calendar-api.ts";
import { formatCalendarTime, CalendarView } from "./calendar-view.tsx";

vi.mock("../../hooks/use-auth.tsx", () => ({
  useAuth: () => ({ status: "authenticated", token: "token", user: { userId: "u_test" } }),
}));

const occurrence = (id: string, title: string, instant: string): CalendarOccurrence => ({
  id,
  occurrenceId: id,
  baseEventId: "weekly-event",
  scope: "private",
  title,
  start: { kind: "timed", instant, timeZoneId: "America/Toronto" },
  occurrenceStart: { kind: "timed", instant, timeZoneId: "America/Toronto" },
  visibility: "everyone",
  importance: "normal",
  tags: [],
  createdAt: instant,
  updatedAt: instant,
});

function apiFor(events: CalendarOccurrence[]): CalendarApi {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { events, more: 0 } })),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as CalendarApi;
}

describe("CalendarView", () => {
  it("renders every recurring occurrence as a distinct row", async () => {
    const api = apiFor([
      occurrence("occ-1", "Weekly", "2026-08-03T13:00:00.000Z"),
      occurrence("occ-2", "Weekly", "2026-08-10T13:00:00.000Z"),
      occurrence("occ-3", "Weekly", "2026-08-17T13:00:00.000Z"),
    ]);
    render(<CalendarView api={api} token="token" />);
    await waitFor(() => expect(screen.getAllByText("Weekly")).toHaveLength(3));
    expect(document.querySelectorAll(".calendar-event")).toHaveLength(3);
  });

  it("formats timed occurrences in the browser device timezone", () => {
    const value = { kind: "timed" as const, instant: "2026-08-05T13:00:00.000Z", timeZoneId: "America/Toronto" };
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value.instant));
    expect(formatCalendarTime(value)).toBe(expected);
    expect(formatCalendarTime(value)).not.toBe(value.instant);
  });

  it("reflects create, update, and delete through the client flow", async () => {
    let events: CalendarOccurrence[] = [];
    const api = apiFor(events);
    (api.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, value: { events, more: 0 } }));
    (api.create as ReturnType<typeof vi.fn>).mockImplementation(async (_token: string, event: CalendarOccurrence) => {
      const created = occurrence("created", event.title, event.start.kind === "timed" ? event.start.instant : "2026-08-05T13:00:00.000Z");
      events = [created];
      return { ok: true, value: created };
    });
    (api.update as ReturnType<typeof vi.fn>).mockImplementation(async (_token: string, id: string, patch: { title?: string }) => {
      events = events.map((event) => event.baseEventId === id ? { ...event, title: patch.title ?? event.title } : event);
      return { ok: true, value: events[0] };
    });
    (api.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      events = [];
      return { ok: true, value: { ok: true } };
    });

    render(<CalendarView api={api} token="token" />);
    await waitFor(() => expect(screen.getByText("No events this week.")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Created" } });
    fireEvent.submit(screen.getByRole("button", { name: "Add event" }));
    await waitFor(() => expect(screen.getByText("Created")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Updated" } });
    fireEvent.submit(screen.getByRole("button", { name: "Update event" }));
    await waitFor(() => expect(screen.getByText("Updated")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText("No events this week.")).toBeTruthy());
  });
});
