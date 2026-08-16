import { describe, expect, it } from "bun:test";
import type { HomeAdapter, HomeEntity, HomeOperationResult } from "./home-adapter.js";
import { buildHomeTools } from "./home-tools.js";

const entity = (entityId: string, name: string, areaId: string | null = null): HomeEntity => ({
  entityId,
  name,
  areaId,
  aliases: [],
  state: "off",
  lastChanged: "2026-01-01T00:00:00Z",
});

function fakeAdapter(overrides: Partial<HomeAdapter> = {}): HomeAdapter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    overview: async () => ({ outcome: "succeeded", entities: [] }),
    entities: async () => ({
      outcome: "succeeded",
      entities: [
        entity("light.kitchen", "Kitchen", "kitchen"),
        entity("scene.evening", "Evening"),
        entity("script.bedtime", "Bedtime"),
        entity("automation.sunset", "Sunset"),
      ],
    }),
    state: async (entityId) => ({ outcome: "succeeded", entity: entity(entityId, "Kitchen", "kitchen") }),
    history: async () => ({ outcome: "succeeded", points: [{ state: "on", changedAt: "2026-01-01T00:00:00Z" }] }),
    locations: async () => ({ outcome: "succeeded", locations: [] }),
    camera: async () => ({ outcome: "succeeded", contentType: "image/jpeg", bytes: 42 }),
    control: async (targetId): Promise<HomeOperationResult> => {
      writes.push(targetId);
      return { outcome: "succeeded", operationId: "00000000-0000-4000-8000-000000000001" };
    },
    activate: async (targetId): Promise<HomeOperationResult> => {
      writes.push(targetId);
      return { outcome: "succeeded", operationId: "00000000-0000-4000-8000-000000000002" };
    },
    operation: () => ({ outcome: "not_found" }),
    ...overrides,
  };
}

function runner(adapter: HomeAdapter, name: string) {
  const found = buildHomeTools(adapter).find((value) => value.definition.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

const signal = new AbortController().signal;

describe("native Home tools", () => {
  it("exposes compact standard product-group definitions without ha-mcp", () => {
    const definitions = buildHomeTools(fakeAdapter()).map((value) => value.definition);
    expect(definitions.map((value) => value.name)).toEqual([
      "home_overview",
      "home_search",
      "home_state",
      "home_history",
      "home_locations",
      "home_camera",
      "home_operation",
      "home_control",
      "home_activate_scene",
      "home_activate_script",
      "home_activate_automation",
    ]);
    expect(definitions.every((value) => value.productGroup === "home" && value.defaultExposure === "standard")).toBe(
      true,
    );
    expect(definitions.find((value) => value.name === "home_state")?.tier).toBe("read");
    expect(definitions.find((value) => value.name === "home_control")?.tier).toBe("write");
  });

  it("searches scenes, scripts, and automations with bounded identifiers", async () => {
    const output = await runner(fakeAdapter(), "home_search").run({ query: "even", kinds: ["scene"] }, { signal });
    expect(JSON.parse(output.content)).toEqual({
      outcome: "succeeded",
      matches: [
        {
          entity_id: "scene.evening",
          name: "Evening",
          state: "off",
          area_id: null,
          last_changed: "2026-01-01T00:00:00Z",
        },
      ],
    });
  });

  it("does not dispatch a write when natural-name resolution is ambiguous", async () => {
    const adapter = fakeAdapter({
      entities: async () => ({
        outcome: "succeeded",
        entities: [entity("light.den", "Lamp"), entity("light.hall", "Lamp")],
      }),
    });
    const output = await runner(adapter, "home_control").run({ target: "Lamp", action: "on" }, { signal });
    expect(JSON.parse(output.content).outcome).toBe("ambiguous");
    expect(adapter.writes).toEqual([]);
  });

  it("uses dedicated scene/script/automation activation contracts", async () => {
    const adapter = fakeAdapter();
    for (const kind of ["scene", "script", "automation"] as const) {
      const output = await runner(adapter, `home_activate_${kind}`).run(
        { target: kind === "scene" ? "Evening" : kind === "script" ? "Bedtime" : "Sunset" },
        { signal },
      );
      expect(JSON.parse(output.content).outcome).toBe("succeeded");
    }
    expect(adapter.writes).toEqual(["scene.evening", "script.bedtime", "automation.sunset"]);
  });

  it("rejects sensitive domains before the adapter side-effect boundary", async () => {
    const adapter = fakeAdapter({
      entities: async () => ({ outcome: "succeeded", entities: [entity("lock.front_door", "Front Door")] }),
    });
    const output = await runner(adapter, "home_control").run({ target: "Front Door", action: "on" }, { signal });
    expect(JSON.parse(output.content)).toEqual({ outcome: "not_found" });
    expect(adapter.writes).toEqual([]);
  });

  it("degrades adapter failure per call and rejects malformed model arguments", async () => {
    const adapter = fakeAdapter({ entities: async () => ({ outcome: "unavailable" }) });
    const stateRunner = runner(adapter, "home_state");
    expect(JSON.parse((await stateRunner.run({ target: "Kitchen" }, { signal })).content)).toEqual({
      outcome: "unavailable",
    });
    expect(stateRunner.validate?.({ target: "Kitchen", url: "https://evil.example" })).toEqual({
      content: JSON.stringify({ outcome: "rejected", reason: "invalid_arguments" }),
      isError: true,
    });
  });
});
