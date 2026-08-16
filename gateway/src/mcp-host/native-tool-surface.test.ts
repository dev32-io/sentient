import { describe, expect, it, vi } from "vitest";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition } from "../tools/tool-types.js";
import { createNativeToolSurface } from "./native-tool-surface.js";

const def = (name: string, productGroup: string, tier: ToolDefinition["tier"]): ToolDefinition => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  category: "foreground",
  tier,
  productGroup,
  defaultExposure: "standard",
});

function broker(definitions: Array<ToolDefinition & { permission?: "allow" | "ask" | "deny" | "off" }>): ToolBroker {
  return {
    ownerUserId: "u_test",
    ready: vi.fn(async () => {}),
    definitions: (options) =>
      definitions.filter((definition) =>
        options?.permissions ? options.permissions.includes(definition.permission ?? "allow") : true,
      ),
    dispatch: vi.fn(async () => ({ content: "ok", isError: false })),
    foregroundInFlight: 0,
    background: {} as never,
    setBackgroundCompletionSink: vi.fn(),
  };
}

describe("delegated native product projection", () => {
  it("derives prompt-free product reads from broker metadata and excludes side effects", async () => {
    const delegated = broker([
      def("web_search", "web", "read"),
      { ...def("home_state", "home", "read"), permission: "ask" },
      { ...def("music_status", "music", "read"), permission: "deny" },
      def("music_queue", "music", "read"),
      def("music_play", "music", "write"),
      def("home_remove_scene", "home", "confirm"),
      def("memory_read", "memory", "read"),
    ]);
    const surface = createNativeToolSurface("u_test", async () => delegated, new Set());
    await surface.refresh();
    expect(surface.definitions().map((definition) => definition.name)).toEqual(["web_search", "music_queue"]);
    expect(surface.handler("home_state")).toBeNull();
    expect(surface.handler("music_status")).toBeNull();
    expect(surface.handler("music_play")).toBeNull();
    expect(surface.handler("home_remove_scene")).toBeNull();
  });

  it("refreshes through the user's broker so profile Off visibility remains authoritative", async () => {
    let visible = [def("web_search", "web", "read")];
    const delegated = broker(visible);
    delegated.definitions = () => visible;
    const surface = createNativeToolSurface("u_test", async () => delegated, new Set());
    await surface.refresh();
    expect(surface.handler("web_search")).not.toBeNull();
    visible = [];
    await surface.refresh();
    expect(surface.handler("web_search")).toBeNull();
  });
});
