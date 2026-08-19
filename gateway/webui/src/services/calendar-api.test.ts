import { afterEach, describe, expect, it, vi } from "vitest";
import calendarWireFixture from "../../../src/calendar/fixtures/calendar-wire.json";
import { createCalendarApi, type CalendarEvent } from "./calendar-api.ts";

const timed = calendarWireFixture.timed as Extract<CalendarEvent["start"], { kind: "timed" }>;
const event: CalendarEvent = {
  id: "id/with space",
  scope: "private",
  title: "Dentist",
  start: timed,
  visibility: "everyone",
  importance: "normal",
  tags: [],
  createdAt: timed.instant,
  updatedAt: timed.instant,
};

afterEach(() => vi.unstubAllGlobals());

describe("calendar REST client", () => {
  it("matches the calendar envelope and bearer wire shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ version: 1, requestId: "r1", body: { events: [event], more: 0 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCalendarApi({ baseUrl: "https://gateway.test" }).list("secret", {
      from: timed,
      to: timed,
    });
    expect(result).toEqual({ ok: true, value: { events: [event], more: 0 } });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/calendar/events?"),
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer secret" } }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain(encodeURIComponent(JSON.stringify(timed)));
  });

  it("surfaces the nested calendar error code from the shared error envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, requestId: "r-error", error: { code: "invalid", message: "bad event" } }), {
        status: 422,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCalendarApi().get("token", "missing");
    expect(result).toMatchObject({ ok: false, error: { status: 422, code: "invalid", reason: "bad event" } });
  });

  it("URL-encodes ids and sends JSON for mutations", async () => {
    const response = JSON.stringify({ version: 1, requestId: "r1", body: event });
    const fetchMock = vi.fn().mockResolvedValue(new Response(response, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createCalendarApi().update("token", event.id, { title: "Updated" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/calendar/events/${encodeURIComponent(event.id)}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "Updated" }) }),
    );
  });
});
