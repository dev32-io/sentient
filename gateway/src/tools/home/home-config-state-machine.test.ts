import { describe, expect, it } from "bun:test";
import type { HomeAdapter, HomeEntity } from "./home-adapter.js";
import { createHomeAdapter } from "./home-adapter.js";
import { buildHomeTools } from "./home-tools.js";

const signal = new AbortController().signal;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function entity(entityId: string): HomeEntity {
  return { entityId, name: entityId, aliases: [], areaId: null, state: "on", lastChanged: "2026-01-01T00:00:00Z" };
}

describe("Home configuration state machine", () => {
  it("returns conflict and preserves a newer upstream configuration", async () => {
    const oldConfig = { alias: "Bedtime", sequence: [{ delay: "00:00:01" }] };
    const newerConfig = { alias: "Bedtime changed elsewhere", sequence: [{ delay: "00:00:02" }] };
    let reads = 0;
    let writes = 0;
    const adapter = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      writeToken: "write",
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          writes += 1;
          return response({});
        }
        reads += 1;
        return response(reads === 1 ? oldConfig : newerConfig);
      },
    });
    const first = await adapter.getConfig("script", "bedtime", signal);
    if (first.outcome !== "succeeded") throw new Error("fixture read failed");
    const result = await adapter.updateConfig(
      "script",
      "bedtime",
      first.resource.version,
      { alias: "My edit", sequence: [{ delay: "00:00:03" }] },
      signal,
    );
    expect(result.outcome).toBe("conflict");
    expect(writes).toBe(0);
  });

  it("does not retry an ambiguous write and reports accepted_unverified", async () => {
    let calls = 0;
    const adapter = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      writeToken: "write",
      fetch: async () => {
        calls += 1;
        throw new Error("connection lost after dispatch");
      },
    });
    expect(await adapter.mutateTodo("todo.groceries", "add", { item: "Milk" }, signal)).toEqual({
      outcome: "accepted_unverified",
      listId: "todo.groceries",
    });
    expect(calls).toBe(1);
  });

  it("returns semantic deleted and upstream conflict outcomes for calendar removal", async () => {
    const deleted = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      writeToken: "write",
      fetch: async () => response({}),
    });
    expect(await deleted.mutateCalendar("calendar.family", "remove", { uid: "event-1" }, signal)).toEqual({
      outcome: "deleted",
      calendarId: "calendar.family",
      eventId: "event-1",
    });
    const conflicted = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      writeToken: "write",
      fetch: async () => response({}, 409),
    });
    expect((await conflicted.mutateCalendar("calendar.family", "remove", { uid: "event-1" }, signal)).outcome).toBe(
      "conflict",
    );
  });

  it("validates references before adapter dispatch", async () => {
    let creates = 0;
    const base: HomeAdapter = {
      overview: async () => ({ outcome: "succeeded", entities: [] }),
      entities: async () => ({ outcome: "succeeded", entities: [entity("light.kitchen")] }),
      state: async () => ({ outcome: "not_found" }),
      history: async () => ({ outcome: "not_found" }),
      locations: async () => ({ outcome: "succeeded", locations: [] }),
      camera: async () => ({ outcome: "not_found" }),
      control: async () => ({ outcome: "failed", operationId: crypto.randomUUID() }),
      activate: async () => ({ outcome: "failed", operationId: crypto.randomUUID() }),
      operation: () => ({ outcome: "not_found" }),
      getConfig: async () => ({ outcome: "not_found" }),
      createConfig: async (kind, id) => {
        creates += 1;
        return { outcome: "succeeded", id, entityId: `${kind}.${id}` };
      },
      updateConfig: async (kind, id) => ({ outcome: "succeeded", id, entityId: `${kind}.${id}` }),
      removeConfig: async (kind, id) => ({ outcome: "deleted", id, entityId: `${kind}.${id}` }),
      todos: async () => ({ outcome: "succeeded", items: [] }),
      mutateTodo: async (listId) => ({ outcome: "succeeded", listId }),
      calendarEvents: async () => ({ outcome: "succeeded", events: [] }),
      mutateCalendar: async (calendarId) => ({ outcome: "succeeded", calendarId }),
    };
    const tool = buildHomeTools(base).find((runner) => runner.definition.name === "home_create_scene");
    if (!tool) throw new Error("missing tool");
    const result = await tool.run({ config: { name: "Bad", entities: { "light.unknown": "on" } } }, { signal });
    expect(JSON.parse(result.content)).toEqual({ outcome: "rejected", reason: "invalid_arguments" });
    expect(creates).toBe(0);
  });

  it("keeps removals visible as confirm-tier dedicated tools", () => {
    const definitions = buildHomeTools({} as HomeAdapter).map((runner) => runner.definition);
    const removals = definitions.filter((definition) => definition.name.startsWith("home_remove_"));
    expect(removals.map((definition) => definition.name)).toEqual([
      "home_remove_scene",
      "home_remove_automation",
      "home_remove_script",
      "home_remove_todo",
    ]);
    expect(
      removals.every((definition) => definition.tier === "confirm" && definition.defaultExposure === "standard"),
    ).toBe(true);
    expect(definitions.some((definition) => /yaml|python|admin|file/i.test(definition.name))).toBe(false);
  });
});
