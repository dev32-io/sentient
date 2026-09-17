import { describe, expect, it } from "vitest";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import type { ScheduleCommands } from "../scheduling/contracts.js";
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
      "music_play_media",
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

  it("mounts scheduled-message tools when the authenticated session supplies its commands and capability", () => {
    const schedules: ScheduleCommands = {
      create: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
      patch: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
      delete: async () => ({ ok: true, value: undefined }),
      list: async () => ({ ok: true, value: { schedules: [] } }),
      cards: async () => ({ ok: true, value: { cards: [] } }),
    };
    const resource = new PrivateScheduleResource({
      ownerUserId: "u_aaaaaaaa" as never,
      resource: "schedule-private",
      rootPath: "/tmp/u_aaaaaaaa",
      role: "adult",
    });
    const tools = composeProductToolProviders(undefined, { scheduled: { schedules, resource } });
    expect([...tools.keys()].filter((name) => name.startsWith("scheduled_message_"))).toEqual([
      "scheduled_message_list",
      "scheduled_message_create",
      "scheduled_message_edit",
      "scheduled_message_pause",
      "scheduled_message_resume",
      "scheduled_message_delete",
    ]);
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
