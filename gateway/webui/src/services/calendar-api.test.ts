import { afterEach, describe, expect, it, vi } from "vitest";
import calendarWireFixture from "../../../src/calendar/fixtures/calendar-wire.json";
import { type CalendarCreateInput, type CalendarMutationCommand, createCalendarApi } from "./calendar-api.ts";

const timed = calendarWireFixture.timed as { kind: "timed"; instant: string; timeZoneId: string };
const v2Event = {
  eventId: "event-example",
  revision: 3,
  scope: "private",
  title: "Example event",
  start: "2026-08-05T13:00:00.000Z",
  visibility: "everyone",
  importance: "normal",
  tags: [],
};
const v2Occurrence = {
  ...v2Event,
  occurrenceId: "event-example@2026-08-10T09:00-04:00",
  originalStart: "2026-08-10T09:00-04:00",
  recurring: true,
};

function envelope(body: unknown) {
  return JSON.stringify({ version: 2, requestId: "request-1", body });
}

afterEach(() => vi.unstubAllGlobals());

describe("calendar REST V2 client", () => {
  it("emits the exact raw query, supports all filters/cursors, and decodes a V2 page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(envelope({ events: [v2Occurrence], nextCursor: "opaque-cursor" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCalendarApi({ baseUrl: "https://gateway.test" }).list("secret", {
      from: "2026-08-01",
      to: "2026-08-31",
      scope: "all",
      query: "dentist",
      cursor: "cursor/1",
      group: "health",
      tags: ["one", "two"],
      importance: "important",
    });
    expect(result).toMatchObject({ ok: true, value: { nextCursor: "opaque-cursor" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.test/api/v1/calendar/events?from=2026-08-01&to=2026-08-31&scope=all&group=health&tags=one%2Ctwo&importance=important&query=dentist&cursor=cursor%2F1",
      { method: "GET", headers: { Authorization: "Bearer secret" } },
    );
  });

  it("omits scope when it is not supplied and never serializes CalendarTime as JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(envelope({ events: [], nextCursor: undefined }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createCalendarApi().list("token", { from: timed, to: { kind: "all-day", date: "2026-08-31" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/calendar/events?from=2026-08-05T13%3A00%3A00.000Z&to=2026-08-31",
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("%7B%22kind%22");
  });

  it("gets an occurrence with V2 identity and raw originalStart", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(envelope(v2Occurrence), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCalendarApi().get("token", "event/1", { scope: "all", originalStart: "2026-08-10" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        eventId: "event-example",
        occurrenceId: v2Occurrence.occurrenceId,
        originalStart: { kind: "timed", instant: v2Occurrence.originalStart },
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/calendar/events/event%2F1?scope=all&originalStart=2026-08-10");
  });

  it("strips server-owned fields and converts source times for create", async () => {
    const response = { ...v2Event, revision: 1 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(envelope(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const event: CalendarCreateInput = {
      id: "client-id",
      eventId: "client-event-id",
      revision: 99,
      occurrenceId: "client-occurrence-id",
      originalStart: "2026-08-05",
      recurring: true,
      baseEventId: "client-base-id",
      scope: "household",
      title: "Draft",
      start: timed,
      visibility: "everyone",
      importance: "normal",
      tags: ["tag"],
      createdAt: "client-created",
      updatedAt: "client-updated",
    };
    await createCalendarApi().create("token", event);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/calendar/events");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      scope: "household",
      title: "Draft",
      start: timed.instant,
      visibility: "everyone",
      importance: "normal",
      tags: ["tag"],
    });
  });

  it("posts every mutation scope through the one V2 command route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          envelope({ operation: "update", appliedTo: "entire_series", eventId: "event-1", resultingRevision: 4 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = createCalendarApi();
    const commands: CalendarMutationCommand[] = [
      { operation: "update", applyTo: "entire_series", changes: { title: "all" } },
      { operation: "update", applyTo: "this_occurrence", originalStart: "2026-08-10", changes: { title: "one" } },
      {
        operation: "update",
        applyTo: "this_and_following",
        originalStart: "2026-08-10",
        changes: { title: "following" },
      },
      { operation: "delete", applyTo: "entire_series" },
      { operation: "delete", applyTo: "this_occurrence", originalStart: "2026-08-10" },
      { operation: "delete", applyTo: "this_and_following", originalStart: "2026-08-10" },
    ];
    for (const command of commands) await api.mutate("token", "event/1", command);
    expect(fetchMock).toHaveBeenCalledTimes(commands.length);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[0]).toBe("/api/v1/calendar/events/event%2F1/mutations");
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      });
      expect(JSON.parse(call[1]?.body as string)).toMatchObject({
        operation: commands[index]?.operation,
        applyTo: commands[index]?.applyTo,
      });
    }
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== "PATCH" && call[1]?.method !== "DELETE")).toBe(
      true,
    );
  });

  it("maps unchanged whole-series update/delete calls to commands and carries revisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          envelope({ operation: "update", appliedTo: "entire_series", eventId: "event-1", resultingRevision: 4 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = createCalendarApi();
    await api.update("token", "event-1", { title: "Updated", start: timed, expectedRevision: 3 });
    await api.delete("token", "event-1", 4);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operation: "update",
      applyTo: "entire_series",
      expectedRevision: 3,
      changes: { title: "Updated", start: timed.instant },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      operation: "delete",
      applyTo: "entire_series",
      expectedRevision: 4,
    });
  });

  it("decodes a typed stale-revision error without retaining payload data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 2,
          requestId: "request-conflict",
          error: { code: "conflict", message: "calendar event revision is stale" },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCalendarApi().mutate("token", "event-1", {
      operation: "delete",
      applyTo: "entire_series",
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: "conflict", reason: "calendar event revision is stale" },
    });
    expect(JSON.stringify(result)).not.toContain("token");
  });
});
