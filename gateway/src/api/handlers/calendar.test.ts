import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import { openCalendarStore } from "../../calendar/calendar-store.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import calendarWireFixture from "../../calendar/fixtures/calendar-wire.json";
import type { CalendarConfig, StoredCalendarEvent, CalendarStore, CalendarTime, Occurrence, UtcInstant } from "../../calendar/types.js";
import { createCalendarHandler } from "./calendar.js";

const handler = createCalendarHandler({
  tokens: {} as never,
  users: { get: async () => ({ ok: true as const, value: null }) },
  accessManager: {} as never,
});

const fixtureTimed = calendarWireFixture.timed as Extract<CalendarTime, { kind: "timed" }>;
const fixtureAllDay = calendarWireFixture.allDay as Extract<CalendarTime, { kind: "all-day" }>;
const occurrence: Occurrence = {
  id: "event-1" as Occurrence["id"],
  occurrenceId: "occurrence-1",
  baseEventId: "event-1" as Occurrence["baseEventId"],
  occurrenceStart: fixtureAllDay,
  title: "New year",
  start: fixtureAllDay,
  visibility: "everyone",
  importance: "normal",
  tags: new Set(["holiday"]),
  createdAt: "2026-01-01T00:00:00.000Z" as Occurrence["createdAt"],
  updatedAt: "2026-01-01T00:00:00.000Z" as Occurrence["updatedAt"],
};
function stubStore(list: CalendarStore["list"], close = () => {}): CalendarStore {
  return { list, close } as CalendarStore;
}
function authenticatedDeps(
  openStore: NonNullable<Parameters<typeof createCalendarHandler>[0]["openStore"]>,
  accessManager = createAccessManager({ userDataRoot: "/tmp/calendar-test-users", sharedDataRoot: "/tmp/calendar-test-shared" }),
) {
  return {
    tokens: { validate: async () => ({ ok: true as const, value: { userId: "u_12345678", issuedAt: 0, expiresAt: 9e9 } }) },
    users: {
      get: async () =>
        ({
          ok: true as const,
          value: { userId: "u_12345678", role: "adult" as const } as never,
        }),
    },
    accessManager,
    openStore,
  };
}

const realStoreRoots: string[] = [];
afterEach(() => {
  for (const root of realStoreRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("calendar REST handler", () => {
  it("rejects requests without a bearer token using the calendar error envelope", async () => {
    const response = await handler(new Request("http://localhost/api/v1/calendar/events", { headers: { "x-request-id": "req-auth" } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      version: 1,
      requestId: "req-auth",
      error: { code: "missing-token", message: "Bearer authentication is required" },
    });
  });

  it("rejects impossible all-day query dates", async () => {
    const api = createCalendarHandler(authenticatedDeps(() => stubStore(() => ({ ok: true, value: [] }))));
    const response = await api(new Request("http://localhost/api/v1/calendar/events?from=2026-02-31&to=2026-03-01", {
      headers: { authorization: "Bearer token", "x-request-id": "req-date" },
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ version: 1, requestId: "req-date", error: { code: "invalid" } });
  });

  it("returns the declared invalid-body envelope", async () => {
    const api = createCalendarHandler(authenticatedDeps(() => stubStore(() => ({ ok: true, value: [] }))));
    const response = await api(new Request("http://localhost/api/v1/calendar/events", {
      method: "POST",
      headers: { authorization: "Bearer token", "x-request-id": "req-invalid", "content-type": "application/json" },
      body: "not-json",
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ version: 1, requestId: "req-invalid", error: { code: "invalid" } });
  });

  it("accepts a create envelope without server timestamps", async () => {
    let created: StoredCalendarEvent | undefined;
    const store = {
      ...stubStore(() => ({ ok: true as const, value: [] })),
      create: (event: StoredCalendarEvent) => { created = event; return { ok: true as const, value: event }; },
    } as CalendarStore;
    const api = createCalendarHandler(authenticatedDeps(() => store));
    const response = await api(new Request("http://localhost/api/v1/calendar/events", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({
        id: "created-without-timestamps",
        scope: "private",
        title: "Fixture event",
        start: fixtureTimed,
        visibility: "everyone",
        importance: "normal",
        tags: [],
      }),
    }));
    expect(response.status).toBe(200);
    expect(created?.createdAt).toEqual(expect.any(String));
    expect(created?.updatedAt).toEqual(expect.any(String));
  });

  it("preserves occurrence identity and expanded times in list wire responses", async () => {
    const windows: unknown[] = [];
    const store = stubStore((window) => {
      windows.push(window);
      return { ok: true as const, value: [occurrence] };
    });
    const api = createCalendarHandler(authenticatedDeps(() => store));
    const response = await api(
      new Request(
        "http://localhost/api/v1/calendar/events?from=2026-01-01&to=2026-01-31&tags=holiday, family",
        { headers: { authorization: "Bearer token" } },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { body: { events: Record<string, unknown>[] } };
    expect(body.body.events[0]).toMatchObject({
      id: "occurrence-1",
      baseEventId: "event-1",
      occurrenceId: "occurrence-1",
      occurrenceStart: occurrence.occurrenceStart,
      start: occurrence.start,
    });
    expect(windows[0]).toMatchObject({ tags: ["holiday", "family"] });
  });

  it("returns N expanded recurring occurrences with distinct wire identity through a real store", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-rest-"));
    realStoreRoots.push(root);
    const accessManager = createAccessManager({ userDataRoot: join(root, "users"), sharedDataRoot: join(root, "shared") });
    const principal = createUserPrincipal("u_12345678", "adult", "home");
    const capability = accessManager.grant(principal, "calendar-private");
    const config: CalendarConfig = { recurrence: { maxOccurrences: 1000, maxDays: 366 }, nudge: { maxPerDay: 10 }, defaultEventTimeZoneId: fixtureTimed.timeZoneId };
    const store = openCalendarStore(capability, config);
    const timed = (instant: string) => ({ kind: "timed" as const, instant: instant as UtcInstant, timeZoneId: fixtureTimed.timeZoneId as never });
    const baseStart = timed(fixtureTimed.instant);
    const created = store.create({
      id: "recurring-event" as never,
      title: "Recurring family event",
      start: baseStart,
      end: timed("2026-08-05T15:00:00.000Z"),
      recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10", rule: { freq: "WEEKLY", byDay: ["MO", "FR"], count: 10 } },
      visibility: "everyone",
      importance: "normal",
      tags: new Set(),
      createdAt: "2026-08-01T00:00:00.000Z" as UtcInstant,
      updatedAt: "2026-08-01T00:00:00.000Z" as UtcInstant,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const from = timed("2026-08-01T00:00:00.000Z");
    const to = timed("2026-10-31T23:59:59.000Z");
    const query = new URLSearchParams({ from: JSON.stringify(from), to: JSON.stringify(to), scope: "private" });
    const api = createCalendarHandler(authenticatedDeps(() => store, accessManager));
    const response = await api(new Request(`http://localhost/api/v1/calendar/events?${query}`, { headers: { authorization: "Bearer token" } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { body: { events: Array<Record<string, any>> } };
    const events = body.body.events;
    expect(events).toHaveLength(10);
    expect(new Set(events.map((event) => event.occurrenceId)).size).toBe(10);
    expect(new Set(events.map((event) => JSON.stringify(event.start))).size).toBe(10);
    expect(events.every((event) => event.baseEventId === created.value.id)).toBe(true);
    expect(events.every((event) => event.occurrenceId && event.baseEventId && event.occurrenceStart && event.occurrenceEnd)).toBe(true);
    expect(events.every((event) => event.start.instant !== baseStart.instant)).toBe(true);
    expect(events.every((event) => event.start === undefined || event.occurrenceStart.instant === event.start.instant)).toBe(true);
  });

  it("does not fall through to private scope for an explicit household PATCH", async () => {
    let privateUpdates = 0;
    let householdUpdates = 0;
    const privateEvent: StoredCalendarEvent = {
      id: "private-only" as never,
      title: "Private",
      start: fixtureAllDay,
      visibility: "everyone",
      importance: "normal",
      tags: new Set(),
      createdAt: "2026-01-01T00:00:00.000Z" as never,
      updatedAt: "2026-01-01T00:00:00.000Z" as never,
    };
    const privateStore = {
      ...stubStore(() => ({ ok: true as const, value: [] })),
      get: () => ({ ok: true as const, value: privateEvent }),
      update: () => { privateUpdates++; return { ok: true as const, value: privateEvent }; },
    } as CalendarStore;
    const householdStore = {
      ...stubStore(() => ({ ok: true as const, value: [] })),
      get: () => ({ ok: false as const, error: "not-found" as const }),
      update: () => { householdUpdates++; return { ok: true as const, value: privateEvent }; },
    } as CalendarStore;
    const api = createCalendarHandler(authenticatedDeps((capability) => capability.resource === "calendar-private" ? privateStore : householdStore));
    const response = await api(new Request("http://localhost/api/v1/calendar/events/private-only", {
      method: "PATCH",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ scope: "household", title: "should not move" }),
    }));
    expect(response.status).toBe(404);
    expect(privateUpdates).toBe(0);
    expect(householdUpdates).toBe(0);
  });

  it("returns the base event shape from GET, not occurrence fields", async () => {
    const base = { ...occurrence, id: occurrence.baseEventId };
    const store = { ...stubStore(() => ({ ok: true as const, value: [] })), get: () => ({ ok: true as const, value: base }) } as CalendarStore;
    const api = createCalendarHandler(authenticatedDeps(() => store));
    const response = await api(new Request("http://localhost/api/v1/calendar/events/event-1", { headers: { authorization: "Bearer token" } }));
    const body = (await response.json()) as { body: Record<string, unknown> };
    expect(body.body).toMatchObject({ id: "event-1", start: occurrence.start });
    expect(body.body).not.toHaveProperty("occurrenceId");
    expect(body.body).not.toHaveProperty("baseEventId");
    expect(body.body).not.toHaveProperty("occurrenceStart");
  });

  it("closes the private store when opening the household store fails", async () => {
    let closed = false;
    let opens = 0;
    const privateStore = stubStore(() => ({ ok: true as const, value: [] }), () => {
      closed = true;
    });
    const api = createCalendarHandler(
      authenticatedDeps(() => {
        opens += 1;
        if (opens === 2) throw new Error("household open failed");
        return privateStore;
      }),
    );
    const response = await api(new Request("http://localhost/api/v1/calendar/events", { headers: { authorization: "Bearer token" } }));
    expect(response.status).toBe(500);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "io-error" } });
    expect(closed).toBe(true);
  });
});
