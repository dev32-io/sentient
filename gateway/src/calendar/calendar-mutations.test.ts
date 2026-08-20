import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { createCalendarEvent, mutateCalendarEvent } from "./calendar-mutations.js";
import { openCalendarPersistence } from "./calendar-store.js";
import { createCalendarQueryService } from "./calendar-query.js";
import { enumerateGeneratedSlots } from "./expand-recurrence.js";
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

  it("re-anchors every successor slot and preserves the selected duration", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({
      end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 4 },
    }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const oldFutureExclusion = { kind: "timed", instant: "2026-01-08T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceExclusions(eventId, [oldFutureExclusion]))).toEqual({ ok: true, value: undefined });
    const result = mutateCalendarEvent(mutation({
      operation: "update",
      eventId,
      applyTo: "this_and_following",
      originalStart: "2026-01-06T14:00:00.000Z",
      changes: {
        start: "2026-01-06T11:00:00-05:00",
        end: "2026-01-06T12:00:00-05:00",
      },
    }), persistence, config);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ successorEventId: expect.any(String) }) });
    if (!result.ok) return;
    const successor = persistence.read((result.value as unknown as { successorEventId: CalendarEventId }).successorEventId);
    expect(successor).toMatchObject({ ok: true, value: {
      start: { instant: "2026-01-06T16:00:00.000Z" }, end: { instant: "2026-01-06T17:00:00.000Z" },
      exclusions: [{ instant: "2026-01-08T16:00:00.000Z" }],
    } });
    if (successor.ok && successor.value.recurrence) {
      const slots = enumerateGeneratedSlots({ start: successor.value.start, recurrence: successor.value.recurrence });
      expect(slots.ok && slots.value.map((slot) => slot.originalStart)).toEqual([
        { kind: "timed", instant: "2026-01-06T16:00:00.000Z", timeZoneId: "America/Toronto" },
        { kind: "timed", instant: "2026-01-07T16:00:00.000Z", timeZoneId: "America/Toronto" },
        { kind: "timed", instant: "2026-01-08T16:00:00.000Z", timeZoneId: "America/Toronto" },
      ] as never);
    }
    persistence.close();

    const endOnly = openCalendarPersistence(cap(root()), config);
    const second = createCalendarEvent(createInput({
      end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 3 },
    }), endOnly, config);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const endResult = mutateCalendarEvent(mutation({
      operation: "update", eventId: second.value.eventId, applyTo: "this_and_following",
      originalStart: "2026-01-06T14:00:00.000Z", changes: { end: "2026-01-06T13:00:00-05:00" },
    }), endOnly, config);
    expect(endResult.ok).toBe(true);
    if (endResult.ok) {
      const endSuccessor = endOnly.read((endResult.value as unknown as { successorEventId: CalendarEventId }).successorEventId);
      expect(endSuccessor).toMatchObject({ ok: true, value: { start: { instant: "2026-01-06T14:00:00.000Z" }, end: { instant: "2026-01-06T18:00:00.000Z" } } });
    }
    endOnly.close();

    const allDay = openCalendarPersistence(cap(root()), config);
    const allDayCreated = createCalendarEvent(createInput({
      start: "2026-01-05" as CalendarCreateInput["start"],
      end: "2026-01-06" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 3 },
    }), allDay, config);
    expect(allDayCreated.ok).toBe(true);
    if (!allDayCreated.ok) return;
    const allDayResult = mutateCalendarEvent(mutation({
      operation: "update", eventId: allDayCreated.value.eventId, applyTo: "this_and_following",
      originalStart: "2026-01-06", changes: { start: "2026-01-07", end: "2026-01-09" },
    }), allDay, config);
    expect(allDayResult.ok).toBe(true);
    if (allDayResult.ok) {
      const allDaySuccessor = allDay.read((allDayResult.value as unknown as { successorEventId: CalendarEventId }).successorEventId);
      expect(allDaySuccessor).toMatchObject({ ok: true, value: { start: { date: "2026-01-07" }, end: { date: "2026-01-09" } } });
    }
    allDay.close();
  });

  it("rejects timed anchor overlap atomically and preserves prefix ownership for a later anchor", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({
      end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 4 },
    }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const past = { kind: "timed", instant: "2026-01-05T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const future = { kind: "timed", instant: "2026-01-08T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceChildren(eventId, {
      exceptions: [{ occurrence: past, title: "past" }], exclusions: [future], tags: ["keep"],
    }))).toEqual({ ok: true, value: undefined });
    const before = persistence.read(eventId);
    for (const start of ["2026-01-06T09:00:00-05:00", "2026-01-05T09:00:00-05:00"]) {
      const result = mutateCalendarEvent(mutation({
        operation: "update", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z",
        changes: { start },
      }), persistence, config);
      expect(result).toMatchObject({ ok: false, error: { code: "recurrence_conflict" } });
      expect(persistence.read(eventId)).toEqual(before);
      expect(persistence.readBaseCandidates(10, { timedFrom: "2026-01-01T00:00:00.000Z" as never, timedTo: "2026-01-31T00:00:00.000Z" as never })).toMatchObject({ ok: true, value: { ids: [eventId] } });
    }
    const later = mutateCalendarEvent(mutation({
      operation: "update", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z",
      changes: { start: "2026-01-08T09:00:00-05:00" },
    }), persistence, config);
    expect(later).toEqual({ ok: true, value: expect.objectContaining({ eventId, successorEventId: expect.any(String) }) });
    if (later.ok) {
      expect(persistence.read(eventId)).toMatchObject({ ok: true, value: { revision: 2, exceptions: [{ title: "past" }], exclusions: [] } });
      const successor = persistence.read((later.value as unknown as { successorEventId: CalendarEventId }).successorEventId);
      expect(successor).toMatchObject({ ok: true, value: { start: { instant: "2026-01-08T14:00:00.000Z" }, exclusions: [{ instant: "2026-01-09T14:00:00.000Z" }] } });
    }
    persistence.close();
  });

  it("rejects all-day anchor overlap atomically and accepts a later date anchor", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({
      start: "2026-01-05" as CalendarCreateInput["start"],
      end: "2026-01-06" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 4 },
    }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const past = { kind: "all-day", date: "2026-01-05" } as CalendarTime;
    const future = { kind: "all-day", date: "2026-01-08" } as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceChildren(eventId, {
      exceptions: [{ occurrence: past, title: "past" }], exclusions: [future], tags: ["keep"],
    }))).toEqual({ ok: true, value: undefined });
    const before = persistence.read(eventId);
    for (const start of ["2026-01-06", "2026-01-05"]) {
      const result = mutateCalendarEvent(mutation({
        operation: "update", eventId, applyTo: "this_and_following", originalStart: "2026-01-07",
        changes: { start },
      }), persistence, config);
      expect(result).toMatchObject({ ok: false, error: { code: "recurrence_conflict" } });
      expect(persistence.read(eventId)).toEqual(before);
    }
    const later = mutateCalendarEvent(mutation({
      operation: "update", eventId, applyTo: "this_and_following", originalStart: "2026-01-07",
      changes: { start: "2026-01-08" },
    }), persistence, config);
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(persistence.read(eventId)).toMatchObject({ ok: true, value: { revision: 2, exceptions: [{ title: "past" }], exclusions: [] } });
      expect(persistence.read((later.value as unknown as { successorEventId: CalendarEventId }).successorEventId)).toMatchObject({ ok: true, value: { start: { date: "2026-01-08" }, exclusions: [{ date: "2026-01-09" }] } });
    }
    persistence.close();
  });

  it("rejects child access to hidden effective targets and unavailable split slots before mutation", () => {
    const base = root();
    const writer = openCalendarPersistence(cap(base), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "daily", count: 4 } }), writer, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const hidden = { kind: "timed", instant: "2026-01-06T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const cancelled = { kind: "timed", instant: "2026-01-07T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const excluded = { kind: "timed", instant: "2026-01-08T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    expect(writer.transaction((tx) => tx.replaceChildren(eventId, {
      exceptions: [{ occurrence: hidden, visibility: "adults" }, { occurrence: cancelled, cancelled: true }],
      exclusions: [excluded], tags: [],
    }))).toEqual({ ok: true, value: undefined });
    writer.close();

    const child = openCalendarPersistence(cap(base, "calendar-private", "child"), config);
    for (const originalStart of ["2026-01-06T14:00:00.000Z", "2026-01-07T14:00:00.000Z", "2026-01-08T14:00:00.000Z"]) {
      const result = mutateCalendarEvent(mutation({
        operation: "update", eventId, applyTo: "this_and_following", originalStart, changes: { title: "must not apply" },
      }), child, config);
      expect(result).toMatchObject({ ok: false, error: { code: "occurrence_not_found" } });
    }
    expect(child.read(eventId)).toMatchObject({ ok: true, value: { revision: 1 } });
    child.close();
  });

  it("splits COUNT recurrence state at the selected original slot", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({
      end: "2026-01-05T10:00:00-05:00" as CalendarCreateInput["end"],
      recurrence: { frequency: "daily", count: 5 },
    }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const cancelled = { kind: "timed", instant: "2026-01-06T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const excluded = { kind: "timed", instant: "2026-01-08T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const moved = { kind: "timed", instant: "2026-01-07T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceChildren(eventId, {
      exceptions: [{ occurrence: cancelled, cancelled: true }, { occurrence: moved, start: { kind: "timed", instant: "2026-01-10T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime }],
      exclusions: [excluded],
      tags: ["old"],
    }))).toEqual({ ok: true, value: undefined });
    const updated = mutateCalendarEvent(mutation({
      operation: "update",
      eventId,
      applyTo: "this_and_following",
      originalStart: "2026-01-07T14:00:00.000Z",
      expectedRevision: 1,
      changes: { title: "future", tags: ["new"] },
    }), persistence, config);
    expect(updated).toEqual({ ok: true, value: expect.objectContaining({ appliedTo: "this_and_following", eventId, successorEventId: expect.any(String), resultingRevision: 2 }) });
    if (!updated.ok) return;
    const successorId = (updated.value as { successorEventId: string }).successorEventId as CalendarEventId;
    const prefix = persistence.read(eventId);
    const successor = persistence.read(successorId);
    expect(prefix).toMatchObject({ ok: true, value: { revision: 2, title: "synthetic event", recurrence: { rule: { count: 2 } }, exceptions: [{ cancelled: true }], exclusions: [] } });
    expect(successor).toMatchObject({ ok: true, value: { revision: 1, title: "future", recurrence: { rule: { count: 3 } }, exclusions: [excluded], tags: ["new"] } });
    if (successor.ok) expect(successor.value.exceptions).toHaveLength(1);
    if (prefix.ok && successor.ok && prefix.value.recurrence && successor.value.recurrence) {
      const prefixSlots = enumerateGeneratedSlots({ start: prefix.value.start, recurrence: prefix.value.recurrence });
      const successorSlots = enumerateGeneratedSlots({ start: successor.value.start, recurrence: successor.value.recurrence });
      expect(prefixSlots.ok && prefixSlots.value).toHaveLength(2);
      expect(successorSlots.ok && successorSlots.value).toHaveLength(3);
    }
    persistence.close();
  });

  it("replaces the whole segment at the first slot without an empty prefix", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "weekly", weekdays: ["monday"], count: 2 } }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = mutateCalendarEvent(mutation({
      operation: "update", eventId: created.value.eventId, applyTo: "this_and_following", originalStart: "2026-01-05T14:00:00.000Z", changes: { title: "replacement" },
    }), persistence, config);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ eventId: expect.any(String), resultingRevision: 1 }) });
    if (!result.ok) return;
    expect(result.value.eventId).not.toBe(created.value.eventId);
    expect(persistence.read(created.value.eventId as CalendarEventId)).toEqual({ ok: false, error: "not-found" });
    expect(persistence.read(result.value.eventId as CalendarEventId)).toMatchObject({ ok: true, value: { title: "replacement", revision: 1 } });
    persistence.close();
  });

  it("rolls back the prefix and generated successor on a split failure", () => {
    const base = root();
    const writer = openCalendarPersistence(cap(base), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "daily", count: 3 } }), writer, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writer.close();
    const failing = openCalendarPersistence(cap(base), config, { fault: (operation) => { if (operation === "insert-successor") throw new Error("synthetic fault"); } });
    const result = mutateCalendarEvent(mutation({
      operation: "update", eventId: created.value.eventId, applyTo: "this_and_following", originalStart: "2026-01-06T14:00:00.000Z", changes: { title: "should rollback" },
    }), failing, config);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "io_error" }) });
    expect(failing.read(created.value.eventId as CalendarEventId)).toMatchObject({ ok: true, value: { title: "synthetic event", revision: 1, recurrence: { rule: { count: 3 } } } });
    failing.close();
  });

  it("truncates a COUNT series by generated identity and retains only past child state", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "daily", count: 5 }, tags: ["keep"] }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const cancelled = { kind: "timed", instant: "2026-01-06T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const selected = { kind: "timed", instant: "2026-01-07T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    const excludedFuture = { kind: "timed", instant: "2026-01-08T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime;
    expect(persistence.transaction((tx) => tx.replaceChildren(eventId, {
      exceptions: [{ occurrence: cancelled, cancelled: true }, { occurrence: selected, start: { kind: "timed", instant: "2026-01-10T14:00:00.000Z", timeZoneId: "America/Toronto" } as unknown as CalendarTime }],
      exclusions: [excludedFuture],
      tags: ["keep"],
    }))).toEqual({ ok: true, value: undefined });

    const result = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z", expectedRevision: 1,
    }), persistence, config);
    expect(result).toEqual({ ok: true, value: { operation: "delete", appliedTo: "this_and_following", eventId, resultingRevision: 2 } } as never);
    expect(persistence.read(eventId)).toMatchObject({
      ok: true,
      value: { revision: 2, recurrence: { rule: { count: 2 } }, exceptions: [{ cancelled: true }], exclusions: [], tags: ["keep"] },
    });
    const query = createCalendarQueryService({ private: persistence, role: "adult", config });
    const listed = query.listComplete({ from: "2026-01-01", to: "2026-01-31" });
    expect(listed.ok && listed.value.map((value) => value.originalStart)).toEqual(["2026-01-05T14:00:00.000Z"] as never);
    persistence.close();
  });

  it("truncates UNTIL recurrence at the previous generated slot", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "weekly", weekdays: ["monday"], until: "2026-01-19" as never } }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const result = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-12T14:00:00.000Z",
    }), persistence, config);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ appliedTo: "this_and_following", resultingRevision: 2 }) });
    const retained = persistence.read(eventId);
    expect(retained).toMatchObject({ ok: true, value: { revision: 2 } });
    if (retained.ok && retained.value.recurrence) {
      expect(retained.value.recurrence.rule.until).toBeDefined();
      const slots = enumerateGeneratedSlots({ start: retained.value.start, recurrence: retained.value.recurrence });
      expect(slots.ok && slots.value.map((slot) => slot.originalStart)).toEqual([
        { kind: "timed", instant: "2026-01-05T14:00:00.000Z", timeZoneId: "America/Toronto" },
      ] as never);
    }
    persistence.close();
  });

  it("deletes the complete segment at the first slot and leaves no successor", () => {
    const persistence = openCalendarPersistence(cap(root()), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "weekly", weekdays: ["monday"], count: 3 } }), persistence, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const result = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-05T14:00:00.000Z", expectedRevision: 1,
    }), persistence, config);
    expect(result).toEqual({ ok: true, value: { operation: "delete", appliedTo: "this_and_following", eventId } });
    expect(persistence.read(eventId)).toEqual({ ok: false, error: "not-found" });
    expect(persistence.readBaseCandidates(10, { allDayFrom: "2026-01-01", allDayTo: "2026-01-31" })).toEqual({ ok: true, value: { ids: [], overflow: false } });
    persistence.close();
  });

  it("rejects unavailable or unauthorized targets and rolls back failed truncation", () => {
    const base = root();
    const writer = openCalendarPersistence(cap(base), config);
    const created = createCalendarEvent(createInput({ recurrence: { frequency: "daily", count: 3 } }), writer, config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const eventId = created.value.eventId as CalendarEventId;
    const cancelled = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_occurrence", originalStart: "2026-01-06T14:00:00.000Z",
    }), writer, config);
    expect(cancelled.ok).toBe(true);
    const unavailable = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-06T14:00:00.000Z",
    }), writer, config);
    expect(unavailable).toMatchObject({ ok: false, error: { code: "occurrence_not_found" } });
    const stale = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z", expectedRevision: 1,
    }), writer, config);
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(writer.read(eventId)).toMatchObject({ ok: true, value: { revision: 2, recurrence: { rule: { count: 3 } } } });
    writer.close();

    const failing = openCalendarPersistence(cap(base), config, { fault: (operation) => { if (operation === "replace-tags") throw new Error("synthetic fault"); } });
    const rolledBack = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z", expectedRevision: 2,
    }), failing, config);
    expect(rolledBack).toMatchObject({ ok: false, error: { code: "io_error" } });
    expect(failing.read(eventId)).toMatchObject({ ok: true, value: { revision: 2, recurrence: { rule: { count: 3 } } } });
    failing.close();

    const household = openCalendarPersistence(cap(base, "calendar-household", "child"), config);
    const denied = mutateCalendarEvent(mutation({
      operation: "delete", eventId, applyTo: "this_and_following", originalStart: "2026-01-07T14:00:00.000Z", scope: "household",
    }), household, config);
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    household.close();
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
