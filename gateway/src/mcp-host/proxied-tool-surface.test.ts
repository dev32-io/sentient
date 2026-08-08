import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "../security/policy-engine.js";
import { loadMcpPolicy } from "../security/policy-loader.js";
import type { McpToolRef } from "../tools/mcp-client.js";
import { createProxiedToolSurface } from "./proxied-tool-surface.js";

function ref(name: string, serverName = "home_assistant"): McpToolRef {
  return {
    serverName,
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    tier: "read",
  };
}

/** Runs against the SHIPPED mcp-policy.yaml on purpose: a rule edit that
 *  promotes a write tool into the delegated surface must fail here, not in
 *  production. */
const policy = createPolicyEngine(loadMcpPolicy());

const CONFIRM_TIER = ["ha_call_service", "ha_bulk_control", "ha_set_todo_item", "ma_queue", "update_user_settings"];

function surfaceFor(refs: McpToolRef[], hostedNames: string[] = []) {
  return createProxiedToolSurface({
    listCatalogTools: async () => refs,
    policy,
    brokerFor: () => null,
    hostedNames: new Set(hostedNames),
  });
}

describe("createProxiedToolSurface", () => {
  // WIRE CONTRACT at the delegated agent's socket: what `tools/list` advertises.
  it("advertises the allow-tier catalog tools", async () => {
    const surface = surfaceFor([
      ref("search_web", "searxng"),
      ref("ha_get_state"),
      ref("ma_search", "music_assistant"),
    ]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web", "ha_get_state", "ma_search"]);
  });

  // THE NEGATIVE, asserted explicitly. A proxy that quietly forwarded a write
  // tool would pass a "did it get tools?" check while defeating the only
  // control this tier has.
  it("advertises nothing from the confirm or deny tier", async () => {
    const surface = surfaceFor([ref("search_web", "searxng"), ...CONFIRM_TIER.map((n) => ref(n))]);

    await surface.refresh();

    const names = surface.definitions().map((d) => d.name);
    expect(names).toEqual(["search_web"]);
    expect(names.some((n) => CONFIRM_TIER.includes(n))).toBe(false);
    for (const denied of CONFIRM_TIER) expect(surface.handler(denied)).toBeNull();
  });

  // An unmatched tool inherits policy-engine's fail-closed `confirm` default.
  it("drops a tool no policy rule classifies", async () => {
    const surface = surfaceFor([ref("search_images", "searxng")]);

    await surface.refresh();

    expect(surface.definitions()).toEqual([]);
  });

  // NAME COLLISION, resolved one way and only one way: a proxied tool keeps its
  // upstream name verbatim (that is the name mcp-policy.yaml tiers and the
  // broker's PDP evaluates), so a catalog tool that collides with a
  // gateway-hosted name is DROPPED rather than shadowing the in-process tool.
  it("drops a catalog tool whose name collides with a gateway-hosted tool", async () => {
    const surface = surfaceFor([ref("pause_audio"), ref("search_web", "searxng")], ["pause_audio"]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web"]);
  });

  it("drops a duplicate name advertised by two catalog servers", async () => {
    const surface = surfaceFor([ref("search_web", "searxng"), ref("search_web", "other")]);

    await surface.refresh();

    expect(surface.definitions().map((d) => d.name)).toEqual(["search_web"]);
  });

  // Degraded, not broken: a catalog that cannot be listed leaves an empty
  // proxied surface and the gateway's own hosted tools still serve.
  it("empties the surface rather than throwing when the catalog cannot be listed", async () => {
    const surface = createProxiedToolSurface({
      listCatalogTools: () => Promise.reject(new Error("all servers down")),
      policy,
      brokerFor: () => null,
      hostedNames: new Set(),
    });

    await surface.refresh();

    expect(surface.definitions()).toEqual([]);
  });
});
