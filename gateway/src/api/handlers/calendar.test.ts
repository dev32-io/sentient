import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import { type CalendarPersistence, openCalendarPersistence } from "../../calendar/calendar-store.js";
import type {
  CalendarConfig,
  CalendarPersistenceEvent,
  CalendarRevision,
  CalendarTime,
  UtcInstant,
} from "../../calendar/types.js";
import { createCalendarHandler } from "./calendar.js";

const config: CalendarConfig = Object.freeze({
  query: Object.freeze({ maxDays: 366, maxOccurrences: 250, pageSize: 2 }),
  input: Object.freeze({
    maxTitleChars: 512,
    maxDescriptionChars: 8000,
    maxQueryChars: 512,
    maxGroupChars: 128,
    maxTagChars: 64,
    maxTags: 32,
  }),
  output: Object.freeze({ maxResultChars: 16000 }),
  recurrence: Object.freeze({ maxOccurrences: 1000, maxDays: 366 }),
  nudge: Object.freeze({ maxPerDay: 10 }),
  defaultEventTimeZoneId: "UTC",
});
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deps(
  openStore: NonNullable<Parameters<typeof createCalendarHandler>[0]["openStore"]>,
  role: "adult" | "child" | "guest" | "admin" = "adult",
  accessManager = createAccessManager({
    userDataRoot: "/tmp/calendar-handler-users",
    sharedDataRoot: "/tmp/calendar-handler-shared",
  }),
) {
  return {
    tokens: {
      validate: async () => ({ ok: true as const, value: { userId: "u_12345678", issuedAt: 0, expiresAt: 9e9 } }),
    },
    users: { get: async () => ({ ok: true as const, value: { userId: "u_12345678", role } as never }) },
    accessManager,
    calendarConfig: config,
    openStore,
  };
}

function day(date: string): CalendarTime {
  return { kind: "all-day", date: date as never };
}
function persisted(
  id: string,
  date: string,
  visibility: "everyone" | "adults" = "everyone",
  revision = 1,
): CalendarPersistenceEvent {
  return {
    id: id as never,
    revision: revision as CalendarRevision,
    title: id,
    start: day(date),
    visibility,
    importance: "normal",
    tags: [],
    exceptions: [],
    exclusions: [],
    createdAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
    updatedAt: "2026-01-01T00:00:00.000Z" as UtcInstant,
  };
}
function fakePersistence(
  events: CalendarPersistenceEvent[],
  scope: "private" | "household",
  onRead?: () => void,
  onClose?: () => void,
): CalendarPersistence {
  const byId = new Map(events.map((event) => [event.id, event]));
  const readRaw = (id: never) => {
    onRead?.();
    const value = byId.get(id);
    return value ? { ok: true as const, value } : { ok: false as const, error: "not-found" as const };
  };
  return {
    scope,
    role: "adult",
    read: readRaw,
    get: readRaw,
    readBaseCandidates: () => ({ ok: true as const, value: { ids: [...byId.keys()] as never[], overflow: false } }),
    readRaw,
    transaction: () => ({ ok: false as const, error: "not-implemented" as const }),
    withTransaction: () => ({ ok: false as const, error: "not-implemented" as const }),
    close: () => onClose?.(),
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: "Bearer token", ...(init.headers ?? {}) },
  });
}

function realApi(root: string, role: "adult" | "child" = "adult") {
  const access = createAccessManager({ userDataRoot: join(root, "users"), sharedDataRoot: join(root, "shared") });
  return createCalendarHandler({
    ...deps((cap, cfg) => openCalendarPersistence(cap, cfg), role, access),
    calendarConfig: config,
  });
}

describe("calendar V2 REST handler", () => {
  it("returns V2 authentication errors and removes legacy mutation methods", async () => {
    const unauthenticated = createCalendarHandler({
      tokens: {} as never,
      users: { get: async () => ({ ok: true as const, value: null }) },
      accessManager: {} as never,
    });
    const missing = await unauthenticated(
      new Request("http://localhost/api/v1/calendar/events", { headers: { "x-request-id": "auth" } }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      version: 2,
      requestId: "auth",
      error: { code: "missing_token", message: "Bearer authentication is required" },
    });

    const api = createCalendarHandler(
      deps(() => {
        throw new Error("must not open");
      }),
    );
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await api(request("/api/v1/calendar/events/event-1", { method }));
      expect(response.status).toBe(405);
      expect((await response.json()) as { version: number }).toMatchObject({ version: 2 });
    }
  });

  it("validates raw temporal ranges before reading either store and defaults scope to private", async () => {
    let reads = 0;
    const privateStore = fakePersistence([persisted("private", "2026-08-01")], "private", () => reads++);
    const householdStore = fakePersistence([persisted("household", "2026-08-02")], "household", () => reads++);
    const api = createCalendarHandler(
      deps((cap) => (cap.resource === "calendar-private" ? privateStore : householdStore)),
    );
    const invalid = await api(
      request("/api/v1/calendar/events?from=2026-02-31&to=2026-03-01", { headers: { "x-request-id": "range" } }),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()) as { error: { code: string } }).toMatchObject({
      version: 2,
      error: { code: "invalid_time" },
    });
    expect(reads).toBe(0);

    const privateOnly = await api(request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-31"));
    expect(privateOnly.status).toBe(200);
    expect((await privateOnly.json()) as { body: { events: Array<{ eventId: string }> } }).toMatchObject({
      body: { events: [{ eventId: "private" }] },
    });
  });

  it("threads the REST query parameter into effective occurrence filtering", async () => {
    const privateStore = fakePersistence([persisted("private-match", "2026-08-01"), persisted("private-other", "2026-08-02")], "private");
    const householdStore = fakePersistence([persisted("household-match", "2026-08-03")], "household");
    const api = createCalendarHandler(
      deps((cap) => (cap.resource === "calendar-private" ? privateStore : householdStore)),
    );

    const response = await api(
      request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-31&scope=all&query=match"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { body: { events: Array<{ eventId: string }> } }).toMatchObject({
      body: { events: [{ eventId: "private-match" }, { eventId: "household-match" }] },
    });
  });

  it("returns deterministic continuation pages and authorized all-scope visibility", async () => {
    const privateStore = fakePersistence([persisted("p1", "2026-08-01"), persisted("p2", "2026-08-03")], "private");
    const householdStore = fakePersistence(
      [persisted("h1", "2026-08-02"), persisted("hidden", "2026-08-04", "adults")],
      "household",
    );
    const api = createCalendarHandler({
      ...deps((cap) => (cap.resource === "calendar-private" ? privateStore : householdStore), "child"),
      calendarConfig: { ...config, query: { ...config.query, pageSize: 1 } },
    });
    const first = await api(request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-31&scope=all"));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { body: { events: Array<{ eventId: string }>; nextCursor?: string } };
    expect(firstBody.body.events.map((event) => event.eventId)).toEqual(["p1"]);
    expect(firstBody.body.nextCursor).toBeString();
    const cursor = firstBody.body.nextCursor;
    if (!cursor) throw new Error("expected continuation cursor");

    const second = await api(
      request(`/api/v1/calendar/events?from=2026-08-01&to=2026-08-31&scope=all&cursor=${encodeURIComponent(cursor)}`),
    );
    expect((await second.json()) as { body: { events: Array<{ eventId: string }> } }).toMatchObject({
      body: { events: [{ eventId: "h1" }] },
    });
  });

  it("keeps REST paging traversable when the complete aggregate exceeds the model result budget", async () => {
    const privateStore = fakePersistence(
      [
        { ...persisted("a", "2026-08-01"), title: "a".repeat(100) },
        { ...persisted("b", "2026-08-02"), title: "b".repeat(100) },
        { ...persisted("c", "2026-08-03"), title: "c".repeat(100) },
      ],
      "private",
    );
    const householdStore = fakePersistence([], "household");
    const api = createCalendarHandler({
      ...deps((cap) => (cap.resource === "calendar-private" ? privateStore : householdStore)),
      calendarConfig: { ...config, query: { ...config.query, pageSize: 2 }, output: { maxResultChars: 1 } },
    });
    const first = await api(request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-31"));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { body: { events: Array<{ eventId: string }>; nextCursor?: string } };
    expect(firstBody.body.events.map((event) => event.eventId)).toEqual(["a", "b"]);
    expect(firstBody.body.nextCursor).toBeString();
    if (!firstBody.body.nextCursor) throw new Error("expected continuation cursor");

    const second = await api(
      request(`/api/v1/calendar/events?from=2026-08-01&to=2026-08-31&cursor=${encodeURIComponent(firstBody.body.nextCursor)}`),
    );
    expect(second.status).toBe(200);
    expect((await second.json()) as { body: { events: Array<{ eventId: string }>; nextCursor?: string } }).toMatchObject({
      body: { events: [{ eventId: "c" }] },
    });
  });

  it("creates privately by default, gets an occurrence with raw originalStart, and mutates through the command route", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-handler-"));
    roots.push(root);
    const api = realApi(root);
    const created = await api(
      request("/api/v1/calendar/events", {
        method: "POST",
        body: JSON.stringify({
          title: "REST event",
          start: "2026-08-05",
          visibility: "everyone",
          importance: "normal",
          tags: [],
        }),
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { body: { eventId: string; revision: number; scope: string } };
    expect(createdBody.body).toMatchObject({ revision: 1, scope: "private" });

    const get = await api(request(`/api/v1/calendar/events/${createdBody.body.eventId}?originalStart=2026-08-05`));
    expect(get.status).toBe(200);
    expect((await get.json()) as { body: { eventId: string } }).toMatchObject({
      body: { eventId: createdBody.body.eventId },
    });

    const mutation = await api(
      request(`/api/v1/calendar/events/${createdBody.body.eventId}/mutations`, {
        method: "POST",
        body: JSON.stringify({
          operation: "update",
          applyTo: "entire_series",
          expectedRevision: 1,
          changes: { title: "updated" },
        }),
      }),
    );
    expect(mutation.status).toBe(200);
    expect((await mutation.json()) as { body: Record<string, unknown> }).toMatchObject({
      body: { operation: "update", resultingRevision: 2 },
    });
  });

  it("maps stale revisions, invalid all-scope writes, role-gated household writes, and overflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-handler-"));
    roots.push(root);
    const adult = realApi(root);
    const created = await adult(
      request("/api/v1/calendar/events", {
        method: "POST",
        body: JSON.stringify({ title: "event", start: "2026-08-05", tags: [] }),
      }),
    );
    const id = ((await created.json()) as { body: { eventId: string } }).body.eventId;
    const stale = await adult(
      request(`/api/v1/calendar/events/${id}/mutations`, {
        method: "POST",
        body: JSON.stringify({ operation: "delete", applyTo: "entire_series", expectedRevision: 99 }),
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { error: { code: string } }).toMatchObject({ error: { code: "conflict" } });

    const allWrite = await adult(
      request(`/api/v1/calendar/events/${id}/mutations`, {
        method: "POST",
        body: JSON.stringify({ operation: "delete", applyTo: "entire_series", scope: "all" }),
      }),
    );
    expect(allWrite.status).toBe(422);
    expect((await allWrite.json()) as { error: { code: string } }).toMatchObject({ error: { code: "invalid_scope" } });

    const householdCreated = await adult(
      request("/api/v1/calendar/events", {
        method: "POST",
        body: JSON.stringify({ title: "household event", start: "2026-08-06", scope: "household", tags: [] }),
      }),
    );
    const householdId = ((await householdCreated.json()) as { body: { eventId: string } }).body.eventId;
    const child = realApi(root, "child");
    const householdWrite = await child(
      request(`/api/v1/calendar/events/${householdId}/mutations`, {
        method: "POST",
        body: JSON.stringify({ operation: "delete", applyTo: "entire_series", scope: "household" }),
      }),
    );
    expect(householdWrite.status).toBe(403);
  });

  it("closes every opened handle on success and when the second opener fails", async () => {
    let privateClosed = 0;
    let householdClosed = 0;
    const privateStore = fakePersistence([], "private", undefined, () => privateClosed++);
    const householdStore = fakePersistence([], "household", undefined, () => householdClosed++);
    const api = createCalendarHandler(
      deps((cap) => (cap.resource === "calendar-private" ? privateStore : householdStore)),
    );
    const response = await api(request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-02"));
    expect(response.status).toBe(200);
    expect(privateClosed).toBe(1);
    expect(householdClosed).toBe(1);

    privateClosed = 0;
    householdClosed = 0;
    let opens = 0;
    const failing = createCalendarHandler(
      deps(() => {
        opens++;
        if (opens === 2) throw new Error("open failure");
        return privateStore;
      }),
    );
    expect((await failing(request("/api/v1/calendar/events?from=2026-08-01&to=2026-08-02"))).status).toBe(503);
    expect(privateClosed).toBe(1);
  });
});
