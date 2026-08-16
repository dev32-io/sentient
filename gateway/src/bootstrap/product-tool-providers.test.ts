import { describe, expect, it } from "vitest";
import type { NativeToolRunner } from "../tools/tool-broker.js";
import type {
  FoundationProductGroup,
  ProductToolProvider,
  ProductToolProviderSlots,
} from "./product-tool-providers.js";
import { EMPTY_PRODUCT_TOOL_PROVIDERS, composeProductToolProviders } from "./product-tool-providers.js";

function provider<G extends FoundationProductGroup>(group: G, toolName: string): ProductToolProvider<G> {
  return {
    group,
    create: () => [
      {
        definition: {
          name: toolName,
          description: toolName,
          parameters: {},
          category: "foreground",
          tier: "read",
          productGroup: group,
          defaultExposure: "standard",
        },
        run: async () => ({ content: "ok", isError: false }),
      } satisfies NativeToolRunner,
    ],
  };
}

describe("product tool provider composition", () => {
  it("composes native Home definitions even when HA is unavailable", () => {
    expect([...composeProductToolProviders().keys()]).toContain("home_overview");
    expect([...composeProductToolProviders().keys()]).toContain("home_activate_scene");
  });

  it("composes the native Music standard surface from its pre-wired slot", () => {
    expect([...composeProductToolProviders().keys()].filter((name) => name.startsWith("music_"))).toEqual([
      "music_search",
      "music_browse",
      "music_players",
      "music_status",
      "music_queue",
      "music_play",
      "music_transport",
      "music_volume",
      "music_transfer",
      "music_group",
    ]);
  });

  it("lets web, Home, and Music be independently replaced while producing one registry", () => {
    const slots: ProductToolProviderSlots = {
      ...EMPTY_PRODUCT_TOOL_PROVIDERS,
      web: provider("web", "web_search"),
      home: provider("home", "home_state"),
      music: provider("music", "music_play"),
    };
    expect([...composeProductToolProviders(slots).keys()]).toEqual(["web_search", "home_state", "music_play"]);
  });

  it("rejects a contribution whose authoritative metadata claims another group", () => {
    const bad = provider("web", "bad") as ProductToolProvider<"web">;
    const original = bad.create;
    const slots: ProductToolProviderSlots = {
      ...EMPTY_PRODUCT_TOOL_PROVIDERS,
      web: {
        group: "web",
        create: (config) =>
          original(config).map((runner) => ({
            ...runner,
            definition: { ...runner.definition, productGroup: "home" },
          })),
      },
    };
    expect(() => composeProductToolProviders(slots)).toThrow("provider web contributed bad for group home");
  });
});
