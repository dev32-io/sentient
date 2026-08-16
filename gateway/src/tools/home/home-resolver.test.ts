import { describe, expect, it } from "bun:test";
import type { HomeEntity } from "./home-adapter.js";
import { resolveHomeEntity } from "./home-resolver.js";

const entities: HomeEntity[] = [
  {
    entityId: "light.kitchen_ceiling",
    name: "Ceiling",
    aliases: ["Main light"],
    areaId: "kitchen",
    state: "on",
    lastChanged: "2026-01-01T00:00:00Z",
  },
  {
    entityId: "light.den_ceiling",
    name: "Ceiling",
    aliases: ["Main light"],
    areaId: "den",
    state: "off",
    lastChanged: "2026-01-01T00:00:00Z",
  },
  {
    entityId: "scene.movie_time",
    name: "Movie Time",
    aliases: ["Cinema"],
    areaId: "den",
    state: "scening",
    lastChanged: "2026-01-01T00:00:00Z",
  },
];

describe("resolveHomeEntity", () => {
  it("prefers a stable exact entity id", () => {
    expect(resolveHomeEntity(entities, "light.kitchen_ceiling")).toMatchObject({
      outcome: "succeeded",
      entity: { entityId: "light.kitchen_ceiling" },
    });
  });
  it("resolves exact aliases and domain constraints", () => {
    expect(resolveHomeEntity(entities, "Cinema", { domains: ["scene"] })).toMatchObject({
      outcome: "succeeded",
      entity: { entityId: "scene.movie_time" },
    });
  });
  it("uses area constraints before choosing a natural name", () => {
    expect(resolveHomeEntity(entities, "Ceiling", { areaId: "den" })).toMatchObject({
      outcome: "succeeded",
      entity: { entityId: "light.den_ceiling" },
    });
  });
  it("returns explicit not_found", () => {
    expect(resolveHomeEntity(entities, "porch")).toEqual({ outcome: "not_found" });
  });
  it("returns sorted bounded candidates instead of guessing", () => {
    expect(resolveHomeEntity(entities, "Main light", { maxCandidates: 1 })).toEqual({
      outcome: "ambiguous",
      candidates: [{ entityId: "light.den_ceiling", name: "Ceiling", areaId: "den" }],
    });
  });
});
