import { describe, expect, it } from "vitest";
import calendarWireFixture from "../../calendar/fixtures/calendar-wire.json";
import type { Capability } from "../../access/capability.js";
import type { CalendarEvent, CalendarStore, CalendarTime, Occurrence } from "../../calendar/types.js";
import { calendarProductToolProvider } from "./calendar-provider.js";

const fixtureTimed = calendarWireFixture.timed as Extract<CalendarTime, { kind: "timed" }>;

function cap(resource: Capability["resource"], role: Capability["role"]): Capability {
  return { ownerUserId: "user" as Capability["ownerUserId"], resource, role, rootPath: "/tmp/calendar" };
}

function notFoundStore(overrides: Partial<CalendarStore> = {}): CalendarStore {
  return {
    get: () => ({ ok: false, error: "not-found" }),
    list: () => ({ ok: false, error: "not-found" }),
    create: () => ({ ok: false, error: "not-found" }),
    update: () => ({ ok: false, error: "not-found" }),
    delete: () => ({ ok: false, error: "not-found" }),
    close: () => {},
    ...overrides,
  } as CalendarStore;
}

function runners(role: Capability["role"], householdStore: CalendarStore) {
  const tools = calendarProductToolProvider.create({
    privateStore: notFoundStore(),
    privateCap: cap("calendar-private", role),
    householdStore,
    householdCap: cap("calendar-household", role),
  });
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

const context = { signal: new AbortController().signal };

async function run(name: string, args: Record<string, unknown>, role: Capability["role"], householdStore: CalendarStore, signal = context.signal) {
  const tool = runners(role, householdStore).get(name);
  if (!tool) throw new Error(`missing ${name}`);
  const validation = tool.validate?.(args);
  if (validation) return validation;
  return tool.run(args, { signal });
}

describe("calendar product tool definitions", () => {
  it("publishes field schemas and forwards adults visibility to the store", async () => {
    let created: CalendarEvent | undefined;
    const householdStore = notFoundStore({
      create: (event) => {
        created = event;
        return { ok: true, value: event };
      },
    });
    const tools = runners("adult", householdStore);
    const create = tools.get("calendar_create");
    const update = tools.get("calendar_update");
    const list = tools.get("calendar_list");
    const search = tools.get("calendar_search");
    const get = tools.get("calendar_get");
    const remove = tools.get("calendar_delete");
    expect(create?.definition.parameters).toMatchObject({
      properties: {
        title: { type: "string" },
        start: { oneOf: expect.any(Array) },
        visibility: { type: "string", enum: ["everyone", "adults"] },
        importance: { type: "string", enum: ["normal", "important", "pinned"] },
        tags: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["private", "household"] },
      },
    });
    expect(update?.definition.parameters).toMatchObject({
      properties: { id: { type: "string" }, patch: { properties: { visibility: { enum: ["everyone", "adults"] } } } },
    });
    const listProperties = (list?.definition.parameters as { properties: Record<string, unknown> }).properties;
    expect(listProperties.from).toHaveProperty("oneOf");
    expect(listProperties.to).toHaveProperty("oneOf");
    expect(listProperties.group).toEqual({ type: "string" });
    expect(listProperties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(listProperties.importance).toEqual({ type: "string", enum: ["normal", "important", "pinned"] });
    const searchProperties = (search?.definition.parameters as { properties: Record<string, unknown> }).properties;
    expect(searchProperties.query).toEqual({ type: "string" });
    expect(searchProperties.from).toHaveProperty("oneOf");
    expect(searchProperties.to).toHaveProperty("oneOf");
    expect(get?.definition.parameters).toMatchObject({ properties: { id: { type: "string" } } });
    expect(remove?.definition.parameters).toMatchObject({ properties: { id: { type: "string" } } });

    const result = await run(
      "calendar_create",
      {
        title: "Adults event",
        start: fixtureTimed,
        visibility: "adults",
        scope: "household",
      },
      "adult",
      householdStore,
    );
    expect(result.isError).toBe(false);
    expect(created?.visibility).toBe("adults");
  });
});

describe("calendar product tool search and cancellation", () => {
  it("searches timed and all-day defaults and forwards importance", async () => {
    const windows: CalendarEvent["start"][] = [];
    const forwardedImportance: Array<string | undefined> = [];
    const event: CalendarEvent = {
      id: "fixture-event" as never,
      title: "Fixture dinner",
      start: fixtureTimed,
      visibility: "everyone",
      importance: "important",
      tags: new Set(),
      createdAt: fixtureTimed.instant as never,
      updatedAt: fixtureTimed.instant as never,
    };
    const occurrence: Occurrence = {
      ...event,
      occurrenceId: "fixture-event:occurrence",
      baseEventId: event.id,
      occurrenceStart: fixtureTimed,
    };
    const normalOccurrence: Occurrence = {
      ...occurrence,
      id: "normal-event" as never,
      baseEventId: "normal-event" as never,
      occurrenceId: "normal-event:occurrence",
      importance: "normal",
    };
    const householdStore = notFoundStore({
      list: (window) => {
        windows.push(window.from);
        forwardedImportance.push(window.importance);
        return { ok: true as const, value: window.importance === "important" ? [occurrence] : [occurrence, normalOccurrence] };
      },
    });
    const result = await run("calendar_search", { query: "dinner", scope: "household", importance: "important" }, "adult", householdStore);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toHaveLength(1);
    expect(windows).toHaveLength(2);
    expect(windows.some((window) => window.kind === "timed")).toBe(true);
    expect(forwardedImportance.every((value) => value === "important")).toBe(true);
  });

  it("does not call update or delete after cancellation", async () => {
    let updateCalls = 0;
    let deleteCalls = 0;
    const householdStore = notFoundStore({
      update: () => { updateCalls++; return { ok: false as const, error: "not-found" as const }; },
      delete: () => { deleteCalls++; return { ok: false as const, error: "not-found" as const }; },
    });
    const controller = new AbortController();
    controller.abort();
    await run("calendar_update", { id: "event", scope: "household", patch: { title: "changed" } }, "adult", householdStore, controller.signal);
    await run("calendar_delete", { id: "event", scope: "household" }, "adult", householdStore, controller.signal);
    expect(updateCalls).toBe(0);
    expect(deleteCalls).toBe(0);
  });
});

describe("calendar product tool write routing", () => {
  for (const role of ["child", "guest"] as const) {
    it(`${role} omitted-scope update and delete never call the household store`, async () => {
      let updateCalls = 0;
      let deleteCalls = 0;
      const householdStore = notFoundStore({
        update: () => { updateCalls++; throw new Error("household update must not be called"); },
        delete: () => { deleteCalls++; throw new Error("household delete must not be called"); },
      });

      const update = await run("calendar_update", { id: "household-only", patch: { title: "changed" } }, role, householdStore);
      const remove = await run("calendar_delete", { id: "household-only" }, role, householdStore);
      expect(JSON.parse(update.content).code).toBe("not-found");
      expect(JSON.parse(remove.content).code).toBe("not-found");
      expect(updateCalls).toBe(0);
      expect(deleteCalls).toBe(0);
    });

    it(`${role} explicit household writes fail before any store call`, async () => {
      let calls = 0;
      const householdStore = notFoundStore({
        update: () => { calls++; throw new Error("unexpected update"); },
        delete: () => { calls++; throw new Error("unexpected delete"); },
      });
      const update = await run("calendar_update", { id: "id", scope: "household", patch: { title: "changed" } }, role, householdStore);
      const remove = await run("calendar_delete", { id: "id", scope: "household" }, role, householdStore);
      expect(JSON.parse(update.content).code).toBe("household-write-forbidden");
      expect(JSON.parse(remove.content).code).toBe("household-write-forbidden");
      expect(calls).toBe(0);
    });
  }
});
