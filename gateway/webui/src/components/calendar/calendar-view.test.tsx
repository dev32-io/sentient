import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarApi,
  CalendarOccurrence,
} from "../../services/calendar-api.ts";
import { browserTimeZone, formatCalendarInputValue, formatCalendarTime, parseCalendarInput, CalendarView } from "./calendar-view.tsx";
import { calendarCapabilityAllows, projectCalendarCapabilities } from "./calendar-access.ts";
import * as sharedCalendarTime from "./calendar-time.ts";

const authState: { status: "authenticated"; token: string; user: { userId: string; displayName: string; isAdmin: boolean; avatarTint: string; role?: "admin" | "adult" | "child" | "guest" } } = {
  status: "authenticated",
  token: "token",
  user: { userId: "u_test", displayName: "Test", isAdmin: false, avatarTint: "sage", role: "adult" },
};

vi.mock("../../hooks/use-auth.tsx", () => ({
  useAuth: () => authState,
}));

const baseOccurrence = (id: string, title: string, instant: string, overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({
  id,
  eventId: id,
  occurrenceId: `${id}@${instant}`,
  baseEventId: id,
  originalStart: { kind: "timed", instant, timeZoneId: "UTC" },
  scope: "private",
  title,
  start: { kind: "timed", instant, timeZoneId: "UTC" },
  occurrenceStart: { kind: "timed", instant, timeZoneId: "UTC" },
  visibility: "everyone",
  importance: "normal",
  tags: [],
  revision: 3,
  createdAt: instant,
  updatedAt: instant,
  ...overrides,
});

const fixtureEvents = [
  baseOccurrence("event-1", "Morning school", "2026-08-21T09:00:00.000Z", { group: "family", tags: ["school"] }),
  baseOccurrence("event-2", "Household dinner", "2026-08-22T18:00:00.000Z", { scope: "household", importance: "important" }),
  baseOccurrence("event-3", "Weekly planning", "2026-08-24T10:00:00.000Z", { recurring: true, recurrence: { frequency: "weekly", interval: 1, weekdays: ["monday"], count: 4 } }),
];

function apiFor(events: CalendarOccurrence[] = fixtureEvents): CalendarApi {
  return {
    list: vi.fn(async (_token, options) => options.cursor
      ? { ok: true as const, value: { events: events.slice(1), more: 0 } }
      : { ok: true as const, value: { events: events.slice(0, 1), nextCursor: "page-2" } }),
    get: vi.fn(async () => ({ ok: true as const, value: events[0]! })),
    create: vi.fn(async (_token, input) => ({
      ok: true as const,
      value: baseOccurrence("created", input.title, typeof input.start === "string" ? input.start : input.start.kind === "timed" ? input.start.instant : `${input.start.date}T00:00:00.000Z`),
    })),
    mutate: vi.fn(async (_token, eventId, command) => ({
      ok: true as const,
      value: { operation: command.operation, appliedTo: command.applyTo, eventId, resultingRevision: 4 },
    })),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as CalendarApi;
}

const routeOptions = {
  token: "token",
  initialAnchorDate: "2026-08-21",
  now: () => new Date("2026-08-21T12:00:00.000Z"),
  capabilities: {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    private: { create: true, update: true, delete: true },
    household: { create: true, update: true, delete: true },
  },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("CalendarView", () => {
  it("assembles the controller, complete paged data, and all four canvases", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);

    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy());
    expect(screen.getByRole("button", { name: /Morning school/i })).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith("token", expect.objectContaining({ scope: "all" }));
    expect(api.list).toHaveBeenCalledWith("token", expect.objectContaining({ cursor: "page-2", scope: "all" }));

    for (const view of ["Day", "Week", "Year"] as const) {
      fireEvent.click(screen.getByRole("button", { name: `${view} view` }));
      await waitFor(() => expect(container.querySelector(`[data-calendar-canvas-view="${view.toLowerCase()}"]`)).toBeTruthy());
    }
  });

  it("keeps filters and view navigation on one controller state", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Private" })[0]!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("events in Month view"));
    expect(screen.queryByRole("button", { name: /Household dinner/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("September");
  });

  it("opens Add event from the assembled workspace and sends a complete create input", async () => {
    const api = apiFor([]);
    render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add event" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Add event" })[0]!);
    const editor = screen.getByRole("dialog", { name: "Add to the family calendar" });
    fireEvent.input(within(editor).getByLabelText("Event title"), { target: { value: "New household event" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add event" }));
    await waitFor(() => expect(screen.getByText("Event added.")).toBeTruthy());
    expect(api.create).toHaveBeenCalledWith("token", expect.objectContaining({
      title: "New household event",
      scope: "private",
      visibility: "everyone",
      importance: "normal",
      tags: [],
    }));
    expect(screen.queryByRole("dialog", { name: "Add to the family calendar" })).toBeNull();
  });

  it("opens the anchored preview, edits with exact V2 identity, and refreshes without blanking", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Morning school/i })).toBeTruthy());

    const eventButton = screen.getByRole("button", { name: /Morning school/i });
    fireEvent.click(eventButton);
    const preview = screen.getByRole("dialog", { name: /Morning school/i });
    expect(preview.getAttribute("data-event-id")).toBe("event-1");
    expect(preview.getAttribute("data-occurrence-id")).toContain("event-1@");
    expect(preview.getAttribute("data-original-start")).toBe("2026-08-21T09:00:00.000Z");
    expect(document.activeElement).toBe(preview.querySelector("button"));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit calendar event" })).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Updated school" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Event saved.")).toBeTruthy());

    expect(api.mutate).toHaveBeenCalledWith(
      "token",
      "event-1",
      expect.objectContaining({
        operation: "update",
        applyTo: "entire_series",
        scope: "private",
        expectedRevision: 3,
        changes: expect.objectContaining({ title: "Updated school" }),
      }),
    );
    expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy();
  });

  it("restores overflow preview focus to the mounted overflow trigger", async () => {
    const denseEvents = [9, 10, 11, 12].map((hour, index) =>
      baseOccurrence(`dense-${index}`, `Dense ${index}`, `2026-08-21T${String(hour).padStart(2, "0")}:00:00.000Z`),
    );
    const api = apiFor(denseEvents);
    render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /more events on Friday, August 21, 2026/i })).toBeTruthy());
    const overflow = screen.getByRole("button", { name: /more events on Friday, August 21, 2026/i });
    fireEvent.click(overflow);
    const overflowDialog = screen.getByRole("dialog", { name: /Events on Friday, August 21, 2026/i });
    fireEvent.click(within(overflowDialog).getByRole("button", { name: /Dense 3/i }));
    const preview = await screen.findByRole("dialog", { name: /Dense 3/i });
    fireEvent.click(within(preview).getByRole("button", { name: "Close event details" }));
    expect(document.activeElement).toBe(overflow);
  });

  it("requires delete confirmation and carries recurring mutation scope", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Weekly planning/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Weekly planning/i }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete event?" })).toBeTruthy();
    const occurrenceScope = screen.getByRole("radio", { name: /This occurrence/i });
    fireEvent.click(occurrenceScope);
    fireEvent.change(occurrenceScope, { target: { checked: true, value: "this_occurrence" } });
    const confirmDelete = screen.getByRole("button", { name: "Delete event" }) as HTMLButtonElement;
    expect(confirmDelete.disabled).toBe(false);
    fireEvent.click(confirmDelete);
    await waitFor(() => expect(api.mutate).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Event deleted.")).toBeTruthy());
    expect(api.mutate).toHaveBeenCalledWith(
      "token",
      "event-3",
      expect.objectContaining({ operation: "delete", applyTo: "this_occurrence", originalStart: expect.any(String), expectedRevision: 3 }),
    );
    expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy();
  });

  it("changes a Year month selection into the Month controller view", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Year view" }));
    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="year"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Select August 2026" }));
    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("August");
  });

  it("clears cached events for expired authorization instead of showing a stale projection", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Morning school/i })).toBeTruthy());

    (api.list as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { status: 401, code: "expired" } });
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    await waitFor(() => expect(screen.getByText("Calendar access unavailable")).toBeTruthy());
    expect(screen.queryByText("Morning school")).toBeNull();
    expect(container.querySelector("[data-calendar-route]" )).toBeNull();
  });

  it("keeps a safe permission presentation and disables editor controls without capabilities", async () => {
    const api = apiFor();
    const { container } = render(<CalendarView api={api} {...routeOptions} capabilities={{ canCreate: false, canUpdate: false, canDelete: false }} />);
    await waitFor(() => expect(container.querySelector('[data-calendar-canvas-view="month"]')).toBeTruthy());
    expect(screen.getByText("Calendar editing is unavailable for this session.")).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Add event" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Morning school/i }));
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders empty and typed permission states without disclosing event data", async () => {
    const emptyApi = apiFor([]);
    render(<CalendarView api={emptyApi} {...routeOptions} />);
    await waitFor(() => expect(screen.getByText("No events this month.")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("0 events in Month view");

    document.body.innerHTML = "";
    const deniedApi: CalendarApi = {
      ...apiFor(),
      list: vi.fn(async () => ({ ok: false as const, error: { status: 403, code: "forbidden" } })),
    } as CalendarApi;
    render(<CalendarView api={deniedApi} {...routeOptions} />);
    await waitFor(() => expect(screen.getByText("Calendar access unavailable")).toBeTruthy());
    expect(screen.queryByText("Morning school")).toBeNull();
  });

  it("projects only explicit authenticated role/capability signals", () => {
    const adult = projectCalendarCapabilities({ role: "adult" });
    expect(calendarCapabilityAllows(adult, "create", "private")).toBe(true);
    expect(calendarCapabilityAllows(projectCalendarCapabilities({ role: "guest" }), "create", "private")).toBe(false);
    expect(projectCalendarCapabilities({})).toBeUndefined();
    expect(calendarCapabilityAllows(projectCalendarCapabilities({ calendarCapabilities: { canDelete: true } }), "delete", "private")).toBe(true);
  });

  it("continues to expose the shared temporal helpers", () => {
    expect(browserTimeZone).toBe(sharedCalendarTime.browserTimeZone);
    expect(formatCalendarInputValue).toBe(sharedCalendarTime.formatCalendarInputValue);
    expect(parseCalendarInput).toBe(sharedCalendarTime.parseCalendarInput);
    expect(formatCalendarTime).toBe(sharedCalendarTime.formatCalendarTime);
  });
});
