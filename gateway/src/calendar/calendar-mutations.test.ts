import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { createCalendarEvent, mutateCalendarEvent } from "./calendar-mutations.js";
import { openCalendarPersistence } from "./calendar-store.js";
import { createCalendarQueryService } from "./calendar-query.js";
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

  it("updates one occurrence sparsely, preserves identity, and cancels only that slot", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(
      createInput({
        description: "base description",
        end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
        recurrence: { frequency: "weekly", weekdays: ["monday"], count: 3 },
        group: "base",
        tags: ["base"],
      }),
      persistence,
      config,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const original = "2026-01-12T14:00:00.000Z";
    const updated = mutateCalendarEvent(mutation({
      operation: "update",
      eventId: created.value.eventId,
      applyTo: "this_occurrence",
      originalStart: original,
      expectedRevision: 1,
      changes: {
        title: "moved occurrence",
        description: "override description",
        start: "2026-01-12T16:00:00.000Z",
        visibility: "adults",
        importance: "pinned",
        group: "override",
        tags: ["override"],
      },
    }), persistence, config);
    expect(updated).toEqual({ ok: true, value: expect.objectContaining({ appliedTo: "this_occurrence", resultingRevision: 2 }) });
    const raw = persistence.read(created.value.eventId as CalendarEventId);
    expect(raw).toMatchObject({ ok: true, value: { revision: 2 } });
    if (!raw.ok) return;
    const exception = raw.value.exceptions.find((value) => String(value.occurrence.kind === "timed" && value.occurrence.instant) === original);
    expect(exception).toMatchObject({ title: "moved occurrence", start: { kind: "timed", instant: "2026-01-12T16:00:00.000Z" } });

    const query = createCalendarQueryService({ private: persistence, role: "adult", config });
    const listed = query.listComplete({ from: "2026-01-01", to: "2026-01-31" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const moved = listed.value.find((value) => value.originalStart === original);
    expect(moved).toMatchObject({
      eventId: created.value.eventId,
      originalStart: original,
      start: "2026-01-12T16:00:00.000Z",
      title: "moved occurrence",
      visibility: "adults",
    });
    expect(moved?.occurrenceId).toBe(`${created.value.eventId}:${original}`);
    const cleared = mutateCalendarEvent(mutation({
      operation: "update",
      eventId: created.value.eventId,
      applyTo: "this_occurrence",
      originalStart: original,
      expectedRevision: 2,
      changes: { description: null, end: null, group: null, tags: [] },
    }), persistence, config);
    expect(cleared).toEqual({ ok: true, value: expect.objectContaining({ resultingRevision: 3 }) });
    const clearedState = persistence.read(created.value.eventId as CalendarEventId);
    expect(clearedState).toMatchObject({ ok: true, value: { exceptions: [{ description: null, end: null, group: null, tags: [] }] } });

    const cancelled = mutateCalendarEvent(mutation({
      operation: "delete",
      eventId: created.value.eventId,
      applyTo: "this_occurrence",
      originalStart: "2026-01-19T14:00:00.000Z",
      expectedRevision: 3,
    }), persistence, config);
    expect(cancelled).toEqual({ ok: true, value: expect.objectContaining({ appliedTo: "this_occurrence" }) });
    const repeated = mutateCalendarEvent(mutation({
      operation: "delete",
      eventId: created.value.eventId,
      applyTo: "this_occurrence",
      originalStart: "2026-01-19T14:00:00.000Z",
    }), persistence, config);
    expect(repeated).toMatchObject({ ok: false, error: { code: "occurrence_not_found" } });
    const after = query.listComplete({ from: "2026-01-01", to: "2026-01-31" });
    expect(after.ok && after.value.map((value) => String(value.originalStart))).toEqual(["2026-01-05T14:00:00.000Z", original]);
    persistence.close();
  });

  it("clears optional occurrence fields and removes a conflicting exdate atomically", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({
      description: "description",
      end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 2 },
      group: "group",
      tags: ["tag"],
    }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const second = {
      kind: "timed",
      instant: "2026-01-06T14:00:00.000Z",
      timeZoneId: "America/Toronto",
    } as unknown as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceExclusions(created.value.eventId as CalendarEventId, [second]))).toEqual({ ok: true, value: undefined });
    const cancelled = mutateCalendarEvent(mutation({
      operation: "delete",
      eventId: created.value.eventId,
      applyTo: "this_occurrence",
      originalStart: "2026-01-06T14:00:00.000Z",
    }), persistence, config);
    expect(cancelled.ok).toBe(true);
    const state = persistence.read(created.value.eventId as CalendarEventId);
    expect(state).toMatchObject({ ok: true, value: { revision: 2, exceptions: [{ cancelled: true }] , exclusions: [] } });
    persistence.close();
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
