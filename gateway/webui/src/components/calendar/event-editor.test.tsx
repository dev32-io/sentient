import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type {
  CalendarApi,
  CalendarEvent,
  CalendarMutationResult,
  CalendarOccurrence,
} from "../../services/calendar-api.ts";
import { EventEditor } from "./event-editor.tsx";

function apiFixture(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    mutate: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as CalendarApi;
}

function createdEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: "created-event",
    revision: 1,
    scope: "household",
    title: "Created event",
    description: "",
    start: { kind: "all-day", date: "2026-11-02" },
    end: { kind: "all-day", date: "2026-11-03" },
    visibility: "everyone",
    importance: "normal",
    tags: [],
    ...overrides,
  };
}

function recurringOccurrence(): CalendarOccurrence {
  return {
    eventId: "series-event",
    id: "series-event",
    revision: 7,
    scope: "household",
    title: "Original title",
    description: "Keep this description",
    start: { kind: "timed", instant: "2026-11-01T09:00:00-04:00" },
    end: { kind: "timed", instant: "2026-11-01T10:00:00-04:00" },
    visibility: "everyone",
    importance: "important",
    tags: ["family", "school"],
    group: "home",
    recurrence: { frequency: "weekly", interval: 1, weekdays: ["sunday"], count: 5 },
    occurrenceId: "series-event@2026-11-01T09:00:00-04:00",
    originalStart: { kind: "timed", instant: "2026-11-01T09:00:00-04:00" },
    recurring: true,
    baseEventId: "series-event",
    occurrenceStart: { kind: "timed", instant: "2026-11-01T09:00:00-04:00" },
    occurrenceEnd: { kind: "timed", instant: "2026-11-01T10:00:00-04:00" },
  };
}

describe("EventEditor", () => {
  it("creates a complete all-day V2 payload with local draft ownership", async () => {
    const create = vi.fn(async () => ({ ok: true as const, value: createdEvent() }));
    const onClose = vi.fn();
    const api = apiFixture({ create });
    render(
      <EventEditor
        mode="create"
        api={api}
        token="token"
        capabilities={{ canCreate: true }}
        initialDraft={{
          title: "Family dinner",
          description: "Bring the dessert",
          allDay: true,
          start: "2026-11-02",
          end: "2026-11-03",
          scope: "household",
          visibility: "everyone",
          importance: "pinned",
          group: "family",
          tagsText: "home, family",
          recurrenceEnabled: true,
          recurrenceFrequency: "weekly",
          recurrenceInterval: "2",
          recurrenceWeekdays: ["monday", "wednesday"],
          recurrenceEnd: "count",
          recurrenceCount: "4",
        }}
        onClose={onClose}
      />,
    );

    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith("token", {
      title: "Family dinner",
      description: "Bring the dessert",
      start: "2026-11-02",
      end: "2026-11-03",
      scope: "household",
      visibility: "everyone",
      importance: "pinned",
      group: "family",
      tags: ["home", "family"],
      recurrence: {
        frequency: "weekly",
        interval: 2,
        weekdays: ["monday", "wednesday"],
        count: 4,
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates a timed recurrence with offset-bearing start end anchor and write scope", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      value: createdEvent({
        start: { kind: "timed", instant: "2026-11-02T09:00:00-05:00" },
        end: { kind: "timed", instant: "2026-11-02T10:00:00-05:00" },
      }),
    }));
    render(
      <EventEditor
        mode="create"
        api={apiFixture({ create })}
        token="token"
        capabilities={{ canCreate: true }}
        inputTimeZoneId="America/Toronto"
        initialDraft={{
          title: "Recurring household event",
          allDay: false,
          start: "2026-11-02T09:00",
          end: "2026-11-02T10:00",
          scope: "household",
          recurrenceEnabled: true,
          recurrenceFrequency: "weekly",
          recurrenceInterval: "1",
          recurrenceWeekdays: ["monday"],
          recurrenceEnd: "count",
          recurrenceCount: "4",
        }}
      />,
    );

    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith("token", expect.objectContaining({
      start: "2026-11-02T09:00:00-05:00",
      end: "2026-11-02T10:00:00-05:00",
      scope: "household",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: ["monday"],
        count: 4,
      },
    }));
  });

  it("protects invalid timed recurrence drafts without issuing a request", async () => {
    const create = vi.fn();
    render(
      <EventEditor
        mode="create"
        api={apiFixture({ create })}
        token="token"
        capabilities={{ canCreate: true }}
        inputTimeZoneId="America/Toronto"
        initialDraft={{
          title: "Invalid recurrence",
          allDay: false,
          start: "2026-03-08T02:30",
          end: "2026-03-08T03:30",
          recurrenceEnabled: true,
          recurrenceFrequency: "weekly",
          recurrenceWeekdays: ["sunday"],
          recurrenceEnd: "count",
          recurrenceCount: "2",
        }}
      />,
    );

    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check the date and time values"));
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps an edit calendar scope read-only and looks up mutations by original scope", async () => {
    const mutate = vi.fn(async (_token: string, _eventId: string, _command: unknown) => ({
      ok: true as const,
      value: { operation: "update", appliedTo: "entire_series", eventId: "series-event", resultingRevision: 8 } satisfies CalendarMutationResult,
    }));
    const api = apiFixture({ mutate });
    const event = { ...recurringOccurrence(), scope: "private" as const };
    render(
      <EventEditor
        mode="edit"
        event={event}
        api={api}
        token="token"
        capabilities={{ canUpdate: true }}
        initialDraft={{ scope: "household" }}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Calendar" })).toBeNull();
    expect(screen.getByText("Private")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Entire series/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ scope: "private" }));
  });

  it("sends every occurrence scope with the raw original start and revision", async () => {
    const mutate = vi.fn(async () => ({
      ok: true as const,
      value: { operation: "update", appliedTo: "this_occurrence", eventId: "series-event", resultingRevision: 8 } satisfies CalendarMutationResult,
    }));
    const api = apiFixture({ mutate });
    const event = recurringOccurrence();
    render(
      <EventEditor
        mode="edit"
        event={event}
        api={api}
        token="token"
        capabilities={{ canUpdate: true }}
      />,
    );

    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Moved title" } });
    fireEvent.click(screen.getByRole("radio", { name: /This occurrence/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]).toEqual([
      "token",
      "series-event",
      expect.objectContaining({
        operation: "update",
        applyTo: "this_occurrence",
        scope: "household",
        originalStart: "2026-11-01T09:00:00-04:00",
        expectedRevision: 7,
        changes: expect.objectContaining({ title: "Moved title" }),
      }),
    ]);
  });

  it("requires delete confirmation and sends a typed delete command only after confirmation", async () => {
    const mutate = vi.fn(async (_token: string, _id: string, command: unknown) => ({
      ok: true as const,
      value: { operation: (command as { operation: "delete" }).operation, appliedTo: "entire_series", eventId: "series-event", resultingRevision: 8 } satisfies CalendarMutationResult,
    }));
    const api = apiFixture({ mutate });
    render(
      <EventEditor
        mode="edit"
        event={recurringOccurrence()}
        api={api}
        token="token"
        capabilities={{ canUpdate: true, canDelete: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /Entire series/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]?.[2]).toEqual({
      operation: "delete",
      applyTo: "entire_series",
      scope: "household",
      expectedRevision: 7,
    });
  });

  it("keeps a dirty draft on Escape until discard is explicitly confirmed", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.textContent = "Open calendar editor";
    document.body.append(opener);
    opener.focus();
    render(
      <EventEditor
        mode="create"
        capabilities={{ canCreate: true }}
        onClose={onClose}
        initialDraft={{ title: "Draft title" }}
      />,
    );
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Changed title" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Discard changes?" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers reread/review after a stale revision without replacing the local draft", async () => {
    const mutate = vi.fn(async () => ({
      ok: false as const,
      error: { status: 409, code: "conflict", reason: "server detail stays typed" },
    }));
    const get = vi.fn(async () => ({ ok: true as const, value: recurringOccurrence() }));
    const api = apiFixture({ mutate, get });
    render(
      <EventEditor
        mode="edit"
        event={recurringOccurrence()}
        api={api}
        token="token"
        capabilities={{ canUpdate: true }}
      />,
    );
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Local review draft" } });
    fireEvent.click(screen.getByRole("radio", { name: /Entire series/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Review latest" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Review latest" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("token", "series-event", {
      scope: "household",
      originalStart: "2026-11-01T09:00:00-04:00",
    }));
    expect((screen.getByLabelText("Event title") as HTMLInputElement).value).toBe("Local review draft");
    expect(screen.getByText("Latest saved version")).toBeTruthy();
  });

  it("keeps the draft and does not expose server reason text for forbidden results", async () => {
    const mutate = vi.fn(async () => ({
      ok: false as const,
      error: { status: 403, code: "forbidden", reason: "private event title must never be shown" },
    }));
    const api = apiFixture({ mutate });
    render(
      <EventEditor
        mode="edit"
        event={recurringOccurrence()}
        api={api}
        token="token"
        capabilities={{ canUpdate: true }}
      />,
    );
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Draft stays" } });
    fireEvent.click(screen.getByRole("radio", { name: /Entire series/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect((screen.getByLabelText("Event title") as HTMLInputElement).value).toBe("Draft stays");
    expect(screen.getByRole("alert").textContent).toContain("not permitted");
    expect(screen.getByRole("alert").textContent).not.toContain("private event title must never be shown");
  });
});
