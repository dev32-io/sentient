// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccessManager } from "../../../src/access/access-manager.ts";
import { createCalendarHandler } from "../../../src/api/handlers/calendar.ts";
import type { CalendarPersistence, CalendarPersistenceTransaction } from "../../../src/calendar/calendar-store.ts";
import type {
  CalendarConfig,
  CalendarEventId,
  CalendarPersistenceEvent,
  CalendarRevision,
} from "../../../src/calendar/types.ts";

// The web package cannot load Bun's native sqlite module under Vitest. The
// handler remains real; only its disposable persistence opener is replaced by
// this in-memory, capability-selected store.
vi.mock("../../../src/calendar/calendar-store.ts", () => ({
  openCalendarPersistence: () => {
    throw new Error("test opener must be injected");
  },
}));
import { createCalendarApi } from "./calendar-api.ts";

const config: CalendarConfig = Object.freeze({
  query: Object.freeze({ maxDays: 366, maxOccurrences: 250, pageSize: 10 }),
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

function memoryPersistence(scope: "private" | "household", role: "adult" = "adult"): CalendarPersistence {
  const events = new Map<string, CalendarPersistenceEvent>();
  const result = (id: CalendarEventId) => {
    const event = events.get(id);
    return event ? { ok: true as const, value: event } : { ok: false as const, error: "not-found" as const };
  };
  const compareAndSwapRevision = (id: CalendarEventId, expected: CalendarRevision) => {
    const current = events.get(String(id));
    if (!current || current.revision !== expected) return { ok: false as const, error: "conflict" as const };
    const revision = (Number(current.revision) + 1) as CalendarRevision;
    events.set(String(id), { ...current, revision });
    return { ok: true as const, value: revision };
  };
  const transaction = ((work: (tx: CalendarPersistenceTransaction) => unknown) => {
    const tx = {
      readBaseEvent: result,
      getBaseEvent: result,
      readEvent: result,
      readChildState: (id: CalendarEventId) => {
        const event = events.get(id);
        return event
          ? {
              ok: true as const,
              value: { exceptions: event.exceptions, exclusions: event.exclusions, tags: event.tags },
            }
          : { ok: false as const, error: "not-found" as const };
      },
      getChildState: (id: CalendarEventId) => {
        const event = events.get(id);
        return event
          ? {
              ok: true as const,
              value: { exceptions: event.exceptions, exclusions: event.exclusions, tags: event.tags },
            }
          : { ok: false as const, error: "not-found" as const };
      },
      insertBaseEvent: (event: CalendarPersistenceEvent) => {
        events.set(String(event.id), { ...event, exceptions: [], exclusions: [], tags: [] });
        return { ok: true as const, value: undefined };
      },
      insertSuccessor: (event: CalendarPersistenceEvent) => {
        events.set(String(event.id), { ...event, exceptions: [], exclusions: [], tags: [] });
        return { ok: true as const, value: undefined };
      },
      replaceBaseEvent: (event: CalendarPersistenceEvent) => {
        const current = events.get(String(event.id));
        events.set(String(event.id), {
          ...event,
          revision: current?.revision ?? event.revision,
          exceptions: current?.exceptions ?? [],
          exclusions: current?.exclusions ?? [],
          tags: current?.tags ?? [],
        });
        return { ok: true as const, value: undefined };
      },
      compareAndSwapRevision,
      compareAndSwapBaseRevision: compareAndSwapRevision,
      replaceExceptions: (id: CalendarEventId, exceptions: readonly never[]) => {
        const current = events.get(String(id));
        if (!current) return { ok: false as const, error: "not-found" as const };
        events.set(String(id), { ...current, exceptions });
        return { ok: true as const, value: undefined };
      },
      replaceExclusions: (id: CalendarEventId, exclusions: readonly never[]) => {
        const current = events.get(String(id));
        if (!current) return { ok: false as const, error: "not-found" as const };
        events.set(String(id), { ...current, exclusions });
        return { ok: true as const, value: undefined };
      },
      replaceTags: (id: CalendarEventId, tags: readonly string[]) => {
        const current = events.get(String(id));
        if (!current) return { ok: false as const, error: "not-found" as const };
        events.set(String(id), { ...current, tags });
        return { ok: true as const, value: undefined };
      },
      replaceChildren: (
        id: CalendarEventId,
        children: { exceptions: readonly never[]; exclusions: readonly never[]; tags: readonly string[] },
      ) => {
        const current = events.get(String(id));
        if (!current) return { ok: false as const, error: "not-found" as const };
        events.set(String(id), { ...current, ...children });
        return { ok: true as const, value: undefined };
      },
      deleteSegment: (id: CalendarEventId) => {
        events.delete(String(id));
        return { ok: true as const, value: undefined };
      },
    } as unknown as CalendarPersistenceTransaction;
    return work(tx);
  }) as CalendarPersistence["transaction"];
  return {
    scope,
    role,
    read: result,
    get: result,
    readRaw: result,
    readBaseCandidates: () => ({
      ok: true as const,
      value: { ids: [...events.keys()] as CalendarEventId[], overflow: false },
    }),
    transaction,
    withTransaction: transaction,
    close: () => undefined,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("calendar V2 web/handler contract", () => {
  it("runs create, paged read, and whole-series mutation through the real handler seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-calendar-v2-"));
    roots.push(root);
    const accessManager = createAccessManager({
      userDataRoot: join(root, "users"),
      sharedDataRoot: join(root, "shared"),
    });
    const stores = {
      private: memoryPersistence("private"),
      household: memoryPersistence("household"),
    };
    const handler = createCalendarHandler({
      tokens: {
        validate: async () => ({ ok: true as const, value: { userId: "u_12345678", issuedAt: 0, expiresAt: 9e9 } }),
      },
      users: { get: async () => ({ ok: true as const, value: { userId: "u_12345678", role: "adult" } as never }) },
      accessManager,
      calendarConfig: config,
      openStore: (cap) => (cap.resource === "calendar-private" ? stores.private : stores.household),
    });
    const api = createCalendarApi({
      baseUrl: "http://calendar-handler.test",
      fetch: async (input, init) => handler(new Request(new URL(String(input), "http://calendar-handler.test"), init)),
    });

    const created = await api.create("integration-token", {
      title: "web contract event",
      start: "2026-08-05",
      tags: [],
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    expect(created).toMatchObject({ ok: true, value: { revision: 1, scope: "private" } });
    if (!created.value.eventId) throw new Error("create did not return an event id");

    const page = await api.list("integration-token", { from: "2026-08-01", to: "2026-08-31" });
    expect(page).toMatchObject({ ok: true, value: { events: [{ eventId: created.value.eventId }] } });

    const mutation = await api.mutate("integration-token", created.value.eventId, {
      operation: "update",
      applyTo: "entire_series",
      expectedRevision: created.value.revision ?? 1,
      changes: { title: "web contract updated" },
    });
    expect(mutation).toMatchObject({
      ok: true,
      value: { operation: "update", appliedTo: "entire_series", resultingRevision: 2 },
    });
  });
});
