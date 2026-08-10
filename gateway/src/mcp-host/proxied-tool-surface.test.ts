import type { ImpactTier } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { McpToolRef } from "../tools/mcp-client.js";
import { createProxiedToolSurface } from "./proxied-tool-surface.js";

function ref(name: string, tier: ImpactTier = "read", serverName = "home_assistant"): McpToolRef {
  return {
    serverName,
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    tier,
  };
}

/** The tiers the shipped catalog gives these, restated so a re-tiering in
 *  `config.yaml` shows up as a disagreement between this file and
 *  `tool-tier.test.ts` rather than as a silently widened delegated surface. */
const ABOVE_READ: Array<[string, ImpactTier]> = [
  ["ha_call_service", "confirm"],
  ["ha_bulk_control", "confirm"],
  ["ha_set_todo_item", "write"],
  ["ma_queue", "write"],
];

function surfaceFor(refs: McpToolRef[], hostedNames: string[] = []) {
  return createProxiedToolSurface({
    listCatalogTools: async () => refs,
    brokerFor: async () => null,
    hostedNames: new Set(hostedNames),
  });
}

describe("createProxiedToolSurface", () => {
  // WIRE CONTRACT at the delegated agent's socket: what `tools/list` advertises.
  it("advertises the read-tier catalog tools", async () => {
    const surface = surfaceFor([
      ref("search_web", "read", "searxng"),
      ref("ha_get_state"),
      ref("ma_search", "read", "music_assistant"),
    ]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web", "ha_get_state", "ma_search"]);
  });

  // THE NEGATIVE, asserted explicitly. A proxy that quietly forwarded a write
  // tool would pass a "did it get tools?" check while defeating the only
  // control this tier has.
  it("SECURITY: advertises nothing above the read tier, and serves no handler for it either", async () => {
    const surface = surfaceFor([ref("search_web", "read", "searxng"), ...ABOVE_READ.map(([n, t]) => ref(n, t))]);

    await surface.refresh();

    const names = surface.definitions().map((d) => d.name);
    expect(names).toEqual(["search_web"]);
    for (const [withheld] of ABOVE_READ) expect(surface.handler(withheld)).toBeNull();
  });

  // NAME COLLISION, resolved one way and only one way: a proxied tool keeps its
  // upstream name verbatim (that is the name the catalog tiers and the broker's
  // PDP resolves), so a catalog tool that collides with a gateway-hosted name is
  // DROPPED rather than shadowing the in-process tool.
  it("drops a catalog tool whose name collides with a gateway-hosted tool", async () => {
    const surface = surfaceFor([ref("pause_audio"), ref("search_web", "read", "searxng")], ["pause_audio"]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web"]);
  });

  it("drops a duplicate name advertised by two catalog servers", async () => {
    const surface = surfaceFor([ref("search_web", "read", "searxng"), ref("search_web", "read", "other")]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web"]);
  });

  // Degraded, not broken: a catalog that cannot be listed leaves an empty
  // proxied surface and the gateway's own hosted tools still serve.
  it("empties the surface rather than throwing when the catalog cannot be listed", async () => {
    const surface = createProxiedToolSurface({
      listCatalogTools: () => Promise.reject(new Error("all servers down")),
      brokerFor: async () => null,
      hostedNames: new Set(),
    });

    await surface.refresh();

    expect(surface.definitions()).toEqual([]);
  });
});
