import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarMutationCommandSchema } from "../../../../src/calendar/types.ts";
import { createCalendarApi, type CalendarOccurrence } from "../../services/calendar-api.ts";
import { EventEditor } from "./event-editor.tsx";

afterEach(cleanup);

function occurrence(recurring = false): CalendarOccurrence {
  return {
    eventId: "synthetic-event", baseEventId: "synthetic-event", occurrenceId: "synthetic-occurrence",
    revision: 1, scope: "private", title: "Synthetic event",
    start: { kind: "all-day", date: "2026-11-02" },
    originalStart: { kind: "all-day", date: "2026-11-02" },
    occurrenceStart: { kind: "all-day", date: "2026-11-02" },
    visibility: "everyone", importance: "normal", tags: [], recurring,
    ...(recurring ? { recurrence: { frequency: "weekly" as const, weekdays: ["monday" as const], count: 4 } } : {}),
  };
}

function mount(event: CalendarOccurrence) {
  const bodies: Record<string, unknown>[] = [];
  const accepted: boolean[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    // Match the route's path-authoritative candidate, using the real gateway schema.
    const result = calendarMutationCommandSchema.safeParse({ ...body, eventId: event.eventId });
    accepted.push(result.success);
    return Response.json(result.success ? { body: {
      operation: "update", appliedTo: body.applyTo, eventId: event.eventId, resultingRevision: 2,
    } } : { error: { code: "malformed" } }, { status: result.success ? 200 : 422 });
  });
  const onClose = vi.fn();
  render(<EventEditor mode="edit" event={event} api={createCalendarApi({ fetch })}
    token="synthetic-token" inputTimeZoneId="UTC" capabilities={{ canUpdate: true }} onClose={onClose} />);
  return { bodies, accepted, fetch, onClose };
}

async function save(state: ReturnType<typeof mount>) {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
  expect(state.accepted).toEqual([true]);
  await waitFor(() => expect(state.onClose).toHaveBeenCalledTimes(1));
  return state.bodies[0]!;
}

describe("editor serialized mutation contract", () => {
  it("edits a private all-day event with absent optional fields", async () => {
    const state = mount(occurrence());
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Edited title" } });
    const body = await save(state);
    expect(body).toMatchObject({ operation: "update", applyTo: "entire_series", scope: "private", expectedRevision: 1,
      changes: { title: "Edited title", start: "2026-11-02" } });
    expect(body.changes).not.toHaveProperty("description", "");
  });

  it.each([
    ["This occurrence", "this_occurrence"],
    ["This and following", "this_and_following"],
    ["Entire series", "entire_series"],
  ])("preserves an unchanged recurrence for %s title edits", async (label, applyTo) => {
    const state = mount(occurrence(true));
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Edited series title" } });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
    const body = await save(state);
    expect(body.applyTo).toBe(applyTo);
    expect(body.changes).not.toHaveProperty("recurrence");
    if (applyTo !== "entire_series") expect(body.originalStart).toBe("2026-11-02");
  });

  it("retains a repeat-change draft until a valid series scope is selected", async () => {
    const state = mount(occurrence(true));
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("radio", { name: /This occurrence/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("series scope"));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Repeat") as HTMLSelectElement).value).toBe("none");
    fireEvent.click(screen.getByRole("radio", { name: /This and following/ }));
    const body = await save(state);
    expect(body).toMatchObject({ applyTo: "this_and_following", originalStart: "2026-11-02", changes: { recurrence: null } });
  });

  it("preserves untouched timed values and metadata in a title-only edit", async () => {
    const event: CalendarOccurrence = { ...occurrence(),
      start: { kind: "timed", instant: "2026-11-02T09:00:12-05:00" },
      end: { kind: "timed", instant: "2026-11-02T10:00:34-05:00" },
      description: "Synthetic description", group: "synthetic", tags: ["one", "two"],
      visibility: "adults", importance: "pinned",
    };
    const state = mount(event);
    fireEvent.input(screen.getByLabelText("Event title"), { target: { value: "Edited timed title" } });
    const body = await save(state);
    expect(body.changes).toEqual({ title: "Edited timed title", start: "2026-11-02T09:00:12-05:00",
      end: "2026-11-02T10:00:34-05:00", description: event.description, group: event.group,
      tags: event.tags, visibility: event.visibility, importance: event.importance });
  });

  it("serializes intentional optional-field and recurrence clears as null", async () => {
    const state = mount({ ...occurrence(true), description: "Synthetic description", group: "Synthetic group",
      end: { kind: "all-day", date: "2026-11-03" }, tags: ["synthetic"] });
    for (const label of ["Description", "Group", "End date", "Tags"]) {
      fireEvent.input(screen.getByLabelText(label), { target: { value: "" } });
    }
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("radio", { name: /Entire series/ }));
    const body = await save(state);
    expect(body.changes).toMatchObject({ description: null, group: null, end: null, recurrence: null, tags: [] });
  });
});
