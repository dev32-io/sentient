import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { createCalendarEvent, mutateCalendarEvent } from "./calendar-mutations.js";
import { openCalendarPersistence } from "./calendar-store.js";
import type {
  CalendarConfig,
  CalendarCreateInput,
  CalendarEventId,
  CalendarMutationCommand,
  CalendarTime,
} from "./types.js";

const config: CalendarConfig = {
  query: { maxDays: 366, maxOccurrences: 100, pageSize: 100 },
  input: {
    maxTitleChars: 100,
    maxDescriptionChars: 1000,
    maxQueryChars: 100,
    maxGroupChars: 40,
    maxTagChars: 20,
    maxTags: 8,
  },
  output: { maxResultChars: 5000 },
  recurrence: { maxOccurrences: 100, maxDays: 366 },
  nudge: { maxPerDay: 10 },
  defaultEventTimeZoneId: "America/Toronto",
};
const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "calendar-mutation-test-"));
  roots.push(value);
  return value;
}
function cap(
  rootPath: string,
  resource: Capability["resource"] = "calendar-private",
  role: Capability["role"] = "adult",
): Capability {
  return { ownerUserId: "u1" as Capability["ownerUserId"], resource, rootPath, role };
}
function createInput(overrides: Partial<CalendarCreateInput> = {}): CalendarCreateInput {
  return {
    title: "synthetic event",
    start: "2026-01-05T09:00:00-05:00" as CalendarCreateInput["start"],
    tags: [],
    visibility: "everyone",
    importance: "normal",
    ...overrides,
  };
}
function mutation(value: unknown): CalendarMutationCommand {
  return value as CalendarMutationCommand;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("calendar mutation boundary", () => {
  it("creates a normalized finite recurring event and updates the whole segment once", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(
      createInput({
        recurrence: { frequency: "weekly", weekdays: ["monday"], count: 3 },
      }),
      { persistence, config },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Number(created.value.revision)).toBe(1);
    expect(String(created.value.start)).toBe("2026-01-05T14:00:00.000Z");
    expect(created.value.recurrence).toEqual({ frequency: "weekly", weekdays: ["monday"], count: 3 });
    const stored = persistence.read(created.value.eventId as CalendarEventId);
    expect(stored.ok && stored.value.recurrence?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=3");

    const updated = mutateCalendarEvent(
      mutation({
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        scope: "private",
        changes: { title: "synthetic updated", tags: ["one"] },
      }),
      { persistence, config },
    );
    expect(updated).toEqual({
      ok: true,
      value: expect.objectContaining({ operation: "update", resultingRevision: 2 }),
    });
    expect(persistence.read(created.value.eventId as CalendarEventId)).toMatchObject({
      ok: true,
      value: { title: "synthetic updated", revision: 2 },
    });
    persistence.close();
  });

  it("rejects stale revisions and deletes only the selected persisted segment", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput(), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const stale = mutateCalendarEvent(
      mutation({
        operation: "delete",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        expectedRevision: 99,
        scope: "private",
      }),
      persistence,
      config,
    );
    expect(stale).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });
    expect(persistence.read(created.value.eventId as CalendarEventId).ok).toBe(true);
    const deleted = mutateCalendarEvent(
      mutation({
        operation: "delete",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        expectedRevision: 1,
        scope: "private",
      }),
      persistence,
      config,
    );
    expect(deleted).toEqual({
      ok: true,
      value: expect.objectContaining({ operation: "delete", eventId: created.value.eventId }),
    });
    expect(persistence.read(created.value.eventId as CalendarEventId)).toEqual({ ok: false, error: "not-found" });
    persistence.close();
  });

  it("preserves child state on recurrence conflicts and enforces household authority", () => {
    const base = root();
    const persistence = openCalendarPersistence(cap(base), config);
    const created = createCalendarEvent(
      createInput({ recurrence: { frequency: "weekly", weekdays: ["monday"], count: 3 } }),
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const child = {
      kind: "timed",
      instant: "2026-01-12T14:00:00.000Z",
      timeZoneId: "America/Toronto",
    } as unknown as CalendarTime;
    persistence.transaction((tx) =>
      tx.replaceExceptions(created.value.eventId as CalendarEventId, [{ occurrence: child, title: "synthetic child" }]),
    );
    const conflict = mutateCalendarEvent(
      mutation({
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        scope: "private",
        changes: { recurrence: { frequency: "daily", count: 2 } },
      }),
      persistence,
      config,
    );
    expect(conflict).toEqual({ ok: false, error: expect.objectContaining({ code: "recurrence_conflict" }) });
    expect(persistence.read(created.value.eventId as CalendarEventId)).toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
    persistence.close();

    const household = openCalendarPersistence(cap(base, "calendar-household", "child"), config);
    const denied = mutateCalendarEvent(
      mutation({ operation: "delete", eventId: created.value.eventId, applyTo: "entire_series", scope: "household" }),
      household,
      config,
    );
    expect(denied).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden" }) });
    household.close();
  });

  it("rolls back a multi-step update when SQLite reports a failure", () => {
    const base = root();
    const writer = openCalendarPersistence(cap(base), config);
    const created = createCalendarEvent(createInput(), writer, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writer.close();
    const failing = openCalendarPersistence(cap(base), config, {
      fault: (operation) => {
        if (operation === "replace-tags") throw new Error("synthetic fault");
      },
    });
    const result = mutateCalendarEvent(
      mutation({
        operation: "update",
        eventId: created.value.eventId,
        applyTo: "entire_series",
        scope: "private",
        changes: { title: "synthetic replacement", tags: ["changed"] },
      }),
      failing,
      config,
    );
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "io_error" }) });
    expect(failing.read(created.value.eventId as CalendarEventId)).toMatchObject({
      ok: true,
      value: { title: "synthetic event", revision: 1 },
    });
    failing.close();
  });

  it("rejects invalid scopes and aborts before writing without logging content", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const controller = new AbortController();
    controller.abort();
    const result = createCalendarEvent(createInput({ title: "secret synthetic payload" }), {
      persistence,
      config,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "aborted" }) });
    expect(persistence.readBaseCandidates(1, {
      allDayFrom: "2026-01-01",
      allDayTo: "2026-01-02",
    })).toEqual({ ok: true, value: { ids: [], overflow: false } });
    const invalid = mutateCalendarEvent(
      mutation({ operation: "delete", eventId: "x", scope: "all" }),
      persistence,
      config,
    );
    expect(invalid).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid_mutation_scope" }) });
    expect(JSON.stringify(result)).not.toContain("secret synthetic payload");
    persistence.close();
  });
});
