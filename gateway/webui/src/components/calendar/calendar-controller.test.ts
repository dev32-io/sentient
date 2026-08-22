import { describe, expect, it, vi } from "vitest";
import type { CalendarApi, CalendarOccurrence } from "../../services/calendar-api.ts";
import {
  CalendarController,
  type CalendarProjectionDelegates,
  createCalendarController,
  loadCompleteCalendarInterval,
} from "./calendar-controller.ts";
import { createMemoryCalendarPreferenceStore } from "./calendar-preferences.ts";

function occurrence(id: string, title = id, date = "2026-08-10"): CalendarOccurrence {
  return {
    id,
    eventId: `event-${id}`,
    occurrenceId: id,
    baseEventId: `event-${id}`,
    occurrenceStart: { kind: "all-day", date },
    scope: "private",
    title,
    start: { kind: "all-day", date },
    visibility: "everyone",
    importance: "normal",
    tags: [],
  };
}

function apiFor(list: CalendarApi["list"]): CalendarApi {
  return { list, get: vi.fn(), create: vi.fn(), mutate: vi.fn(), update: vi.fn(), delete: vi.fn() };
}

const options = {
  token: "token",
  accountId: "account-a",
  backendId: "gateway-a",
  now: () => new Date("2026-08-10T12:00:00.000Z"),
};

describe("loadCompleteCalendarInterval", () => {
  it("requests authorized all scope on every page and deduplicates occurrence identities", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = apiFor(
      vi.fn(async (_token, request) => {
        calls.push(request as Record<string, unknown>);
        if (request.cursor === undefined) {
          return { ok: true as const, value: { events: [occurrence("one")], nextCursor: "page-2" } };
        }
        return { ok: true as const, value: { events: [occurrence("one"), occurrence("two", "Two", "2026-08-11")] } };
      }),
    );

    const result = await loadCompleteCalendarInterval(api, "token", { from: "2026-08-01", to: "2026-08-31" });

    expect(result).toEqual({ ok: true, value: [occurrence("one"), occurrence("two", "Two", "2026-08-11")] });
    expect(calls).toEqual([
      { from: "2026-08-01", to: "2026-08-31", scope: "all" },
      { from: "2026-08-01", to: "2026-08-31", scope: "all", cursor: "page-2" },
    ]);
  });

  it("rejects a repeated continuation cursor without returning a partial aggregate", async () => {
    const api = apiFor(
      vi.fn(async (_token, request) => ({
        ok: true as const,
        value: { events: [occurrence(String(request.cursor ?? "first"))], nextCursor: "same" },
      })),
    );

    const result = await loadCompleteCalendarInterval(api, "token", { from: "2026-08-01", to: "2026-08-31" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cursor-loop");
  });

  it("does not expose an incomplete result when a later page fails", async () => {
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true as const, value: { events: [occurrence("one")], nextCursor: "page-2" } })
        .mockResolvedValueOnce({ ok: false as const, error: { status: 503, code: "io_error" } }),
    );

    const result = await loadCompleteCalendarInterval(api, "token", { from: "2026-08-01", to: "2026-08-31" });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "io_error", status: 503 }) });
  });

  it("stops aggregation when cancelled and never reports a complete partial page", async () => {
    const abort = new AbortController();
    let resolvePage!: (value: Awaited<ReturnType<CalendarApi["list"]>>) => void;
    const deferred = new Promise<Awaited<ReturnType<CalendarApi["list"]>>>((resolve) => {
      resolvePage = resolve;
    });
    const api = apiFor(vi.fn<CalendarApi["list"]>(() => deferred));
    const pending = loadCompleteCalendarInterval(
      api,
      "token",
      { from: "2026-08-01", to: "2026-08-31" },
      { signal: abort.signal },
    );
    abort.abort();
    resolvePage({ ok: true, value: { events: [occurrence("one")] } });

    await expect(pending).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: "cancelled" }) });
  });
});

describe("CalendarController", () => {
  it("restores preferences only inside the account/backend namespace", async () => {
    const store = createMemoryCalendarPreferenceStore();
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const first = createCalendarController({
      ...options,
      api,
      preferenceStore: store,
      initialView: "month",
    });
    await first.ready;
    await first.setView("week");
    first.setFilters({
      scopes: ["private"],
      groups: ["family"],
      tags: ["dinner"],
      importance: "important",
      search: "dinner",
    });
    first.dispose();

    const restored = createCalendarController({ ...options, api, preferenceStore: store, initialView: "day" });
    await restored.ready;
    expect(restored.state.selectedView).toBe("week");
    expect(restored.state.selectedFilters).toMatchObject({
      scopes: ["private"],
      groups: ["family"],
      tags: ["dinner"],
      importance: "important",
      search: "dinner",
    });
    restored.dispose();

    const otherAccount = createCalendarController({ ...options, accountId: "account-b", api, preferenceStore: store });
    await otherAccount.ready;
    expect(otherAccount.state.selectedView).toBe("month");
    expect(otherAccount.state.selectedFilters.search).toBe("");
    otherAccount.dispose();
  });

  it("keeps selected-date state separate from the anchor interval", async () => {
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const controller = createCalendarController({ ...options, api });
    await controller.ready;
    const callsBeforeSelection = (api.list as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.setSelectedDate("2026-08-20");

    expect(controller.state.anchorDate).toBe("2026-08-10");
    expect(controller.state.selectedDate).toBe("2026-08-20");
    expect((api.list as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(callsBeforeSelection);
    controller.dispose();
  });

  it("enters focused Day when a Month date is selected", async () => {
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const controller = createCalendarController({ ...options, api });
    await controller.ready;

    await controller.actions.selectDate("2026-08-20");

    expect(controller.state.selectedView).toBe("day");
    expect(controller.state.anchorDate).toBe("2026-08-20");
    expect(controller.state.selectedDate).toBe("2026-08-20");
    expect(controller.state.visibleInterval).toEqual({ from: "2026-08-20", to: "2026-08-20" });
    expect((api.list as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({
      from: "2026-08-20",
      to: "2026-08-20",
      scope: "all",
    });
    controller.dispose();
  });

  it("preserves alias-shaped scope, group, and text filters for local intersection", async () => {
    const privateEvent = {
      ...occurrence("private", "Dentist appointment"),
      group: "health",
      description: "Annual dentist visit",
    };
    const householdEvent = {
      ...occurrence("household", "Dentist school meeting"),
      scope: "household" as const,
      group: "school",
    };
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [privateEvent, householdEvent] } })));
    const controller = createCalendarController({ ...options, api });
    await controller.ready;

    controller.setFilters({ scope: "private", group: "health", text: "dentist" });

    expect(controller.state.selectedFilters).toMatchObject({
      scopes: ["private"],
      groups: ["health"],
      search: "dentist",
    });
    expect(controller.state.filteredOccurrences.map((event) => event.occurrenceId)).toEqual(["private"]);
    controller.dispose();
  });

  it("does not persist preferences without a normalized backend identity", async () => {
    const store = createMemoryCalendarPreferenceStore();
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const { backendId: _backendId, ...withoutBackend } = options;
    const controller = createCalendarController({
      ...withoutBackend,
      api,
      preferenceStore: store,
    });
    await controller.ready;
    await controller.setView("week");

    expect(controller.preferenceNamespace).toBeNull();
    expect(store.values.size).toBe(0);
    controller.dispose();
  });

  it("keeps preferences isolated across explicit backend identities", async () => {
    const store = createMemoryCalendarPreferenceStore();
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const first = createCalendarController({ ...options, api, backendId: "backend-a", preferenceStore: store });
    await first.ready;
    await first.setView("week");
    first.dispose();

    const second = createCalendarController({ ...options, api, backendId: "backend-b", preferenceStore: store });
    await second.ready;
    expect(second.state.selectedView).toBe("month");
    second.dispose();
  });

  it("retains the previous complete content and exposes typed stale status after refresh failure", async () => {
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true as const, value: { events: [occurrence("one")] } })
        .mockResolvedValueOnce({
          ok: false as const,
          error: { status: 503, code: "io_error", reason: "must not be surfaced" },
        }),
    );
    const controller = createCalendarController({ ...options, api });
    await controller.ready;
    expect(controller.state.completeOccurrences.map((event) => event.occurrenceId)).toEqual(["one"]);

    await controller.refresh();

    expect(controller.state.completeOccurrences.map((event) => event.occurrenceId)).toEqual(["one"]);
    expect(controller.state.stale).toBe(true);
    expect(controller.state.error).toMatchObject({ code: "io_error", status: 503 });
    expect(controller.state.error?.message).not.toContain("must not be surfaced");
    controller.dispose();
  });

  it("delegates filtering, facet derivation, and projection to the pure projection owner", async () => {
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [occurrence("one")] } })));
    const filter = vi.fn(() => [occurrence("filtered")]);
    const facets = vi.fn(() => ({ scopes: ["all"] as const, groups: [], tags: [], importance: [] as const }));
    const project = vi.fn((_view, interval, all, filtered) => ({
      view: "month" as const,
      interval,
      occurrences: all,
      filteredOccurrences: filtered,
      count: filtered.length,
    }));
    const projections: CalendarProjectionDelegates = {
      filterCalendarOccurrences: filter,
      deriveCalendarFacets: facets,
      projectCalendarInterval: project,
    };
    const controller = new CalendarController({ ...options, api, projections });
    await controller.ready;

    expect(filter).toHaveBeenCalled();
    expect(facets).toHaveBeenCalled();
    expect(project).toHaveBeenCalled();
    expect(controller.state.filteredOccurrences[0]?.occurrenceId).toBe("filtered");
    controller.dispose();
  });

  it("keeps selected facets available when the current interval has no matching event", async () => {
    const api = apiFor(vi.fn(async () => ({ ok: true as const, value: { events: [] } })));
    const controller = createCalendarController({ ...options, api });
    await controller.ready;
    controller.setFilters({ groups: ["no-longer-present"], tags: ["old-tag"], scopes: ["private"] });

    expect(controller.state.facets.groups).toContain("no-longer-present");
    expect(controller.state.facets.tags).toContain("old-tag");
    expect(controller.state.facets.scopes).toContain("private");
    controller.dispose();
  });
});
