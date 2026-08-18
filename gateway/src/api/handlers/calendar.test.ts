import { describe, expect, it } from "bun:test";
import { createAccessManager } from "../../access/access-manager.js";
import type { CalendarStore, Occurrence } from "../../calendar/types.js";
import { createCalendarHandler } from "./calendar.js";

const handler = createCalendarHandler({
  tokens: {} as never,
  users: { get: async () => ({ ok: true as const, value: null }) },
  accessManager: {} as never,
});

const occurrence: Occurrence = {
  id: "event-1" as Occurrence["id"],
  occurrenceId: "occurrence-1",
  baseEventId: "event-1" as Occurrence["baseEventId"],
  occurrenceStart: { kind: "all-day", date: "2026-01-01" },
  title: "New year",
  start: { kind: "all-day", date: "2026-01-01" },
  visibility: "everyone",
  importance: "normal",
  tags: new Set(["holiday"]),
  createdAt: "2026-01-01T00:00:00.000Z" as Occurrence["createdAt"],
  updatedAt: "2026-01-01T00:00:00.000Z" as Occurrence["updatedAt"],
};
function stubStore(list: CalendarStore["list"], close = () => {}): CalendarStore {
  return { list, close } as CalendarStore;
}
function authenticatedDeps(openStore: NonNullable<Parameters<typeof createCalendarHandler>[0]["openStore"]>) {
  return {
    tokens: { validate: async () => ({ ok: true as const, value: { userId: "u_12345678", issuedAt: 0, expiresAt: 9e9 } }) },
    users: {
      get: async () =>
        ({
          ok: true as const,
          value: { userId: "u_12345678", role: "adult" as const } as never,
        }),
    },
    accessManager: createAccessManager({ userDataRoot: "/tmp/calendar-test-users", sharedDataRoot: "/tmp/calendar-test-shared" }),
    openStore,
  };
}

describe("calendar REST handler", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await handler(new Request("http://localhost/api/v1/calendar/events"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing-token", message: "Bearer authentication is required" });
  });

  it("keeps occurrence-only fields out of list wire responses and forwards tags", async () => {
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
    expect(body.body.events[0]).not.toHaveProperty("occurrenceId");
    expect(body.body.events[0]).not.toHaveProperty("baseEventId");
    expect(body.body.events[0]).not.toHaveProperty("occurrenceStart");
    expect(body.body.events[0]).not.toHaveProperty("occurrenceEnd");
    expect(windows[0]).toMatchObject({ tags: ["holiday", "family"] });
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
    await expect(api(new Request("http://localhost/api/v1/calendar/events", { headers: { authorization: "Bearer token" } }))).rejects.toThrow(
      "household open failed",
    );
    expect(closed).toBe(true);
  });
});
