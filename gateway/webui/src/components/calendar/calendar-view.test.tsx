import calendarWireFixture from "../../../../src/calendar/fixtures/calendar-wire.json";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarApi, CalendarOccurrence } from "../../services/calendar-api.ts";
import { browserTimeZone, formatCalendarInputValue, formatCalendarTime, parseCalendarInput, CalendarView } from "./calendar-view.tsx";
import * as sharedCalendarTime from "./calendar-time.ts";

vi.mock("../../hooks/use-auth.tsx", () => ({
  useAuth: () => ({ status: "authenticated", token: "token", user: { userId: "u_test" } }),
}));

const fixtureTimed = calendarWireFixture.timed as { kind: "timed"; instant: string; timeZoneId: string };
const occurrence = (id: string, title: string, instant: string): CalendarOccurrence => ({
  id,
  occurrenceId: id,
  baseEventId: "weekly-event",
  scope: "private",
  title,
  start: { kind: "timed", instant, timeZoneId: fixtureTimed.timeZoneId },
  occurrenceStart: { kind: "timed", instant, timeZoneId: fixtureTimed.timeZoneId },
  visibility: "everyone",
  importance: "normal",
  tags: [],
  createdAt: instant,
  updatedAt: instant,
});

afterEach(() => vi.unstubAllGlobals());

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

  it("keeps the default API stable across state rerenders", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, requestId: "r1", body: { events: [], more: 0 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CalendarView token="token" />);
    await waitFor(() => expect(screen.getByText("No events this week.")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the extracted temporal helpers for both editor and display paths", () => {
    expect(browserTimeZone).toBe(sharedCalendarTime.browserTimeZone);
    expect(formatCalendarInputValue).toBe(sharedCalendarTime.formatCalendarInputValue);
    expect(parseCalendarInput).toBe(sharedCalendarTime.parseCalendarInput);
    expect(formatCalendarTime).toBe(sharedCalendarTime.formatCalendarTime);
  });

  it("formats timed occurrences in the browser device timezone and round-trips editor values", () => {
    const value = fixtureTimed;
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value.instant));
    expect(formatCalendarTime(value)).toBe(expected);
    expect(formatCalendarTime(value)).not.toBe(value.instant);
    const input = formatCalendarInputValue(value.instant, browserTimeZone());
    expect(parseCalendarInput(input, browserTimeZone())).toBe(value.instant);
    expect(browserTimeZone()).not.toBe("browser");
  });

  it("reflects create, update, and delete through the client flow", async () => {
    let events: CalendarOccurrence[] = [];
    const api = apiFor(events);
    (api.list as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, value: { events, more: 0 } }));
    (api.create as ReturnType<typeof vi.fn>).mockImplementation(async (_token: string, event: CalendarOccurrence) => {
      expect(event.start.kind === "all-day" || event.start.timeZoneId).not.toBe("browser");
      const created = occurrence("created", event.title, event.start.kind === "timed" ? event.start.instant : fixtureTimed.instant);
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
