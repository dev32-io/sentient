import { describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { UserStore } from "../user-auth/user-store.js";
import { migrateLegacyToolPermissions, migrateWebToolsEnabled } from "./web-tools-migrator.js";

describe("legacy product-tool permission migration", () => {
  it("preserves absent versus explicitly empty maps", () => {
    expect(migrateLegacyToolPermissions(undefined)).toEqual({ permissions: undefined, changed: false, unmappable: 0 });
    expect(migrateLegacyToolPermissions({})).toEqual({ permissions: {}, changed: false, unmappable: 0 });
  });

  it("maps every legacy MCP group to its stable product group", () => {
    const result = migrateLegacyToolPermissions({
      fetch: { fetch: "off" },
      searxng: { search_web: "deny" },
      home_assistant: { ha_get_state: "allow" },
      music_assistant: { ma_play: "ask" },
      gateway: { identify_user: "off" },
    });
    expect(result.permissions).toEqual({
      web: { fetch: "off", search_web: "deny" },
      home: { ha_get_state: "allow" },
      music: { ma_play: "ask" },
      gateway: { identify_user: "off" },
    });
  });

  it("uses the more restrictive value when legacy groups collide", () => {
    expect(migrateLegacyToolPermissions({ fetch: { "*": "allow" }, searxng: { "*": "off" } }).permissions).toEqual({
      web: { "*": "off" },
    });
  });

  it("splits native tools and copies a native wildcard conservatively", () => {
    expect(
      migrateLegacyToolPermissions({
        native: { "*": "deny", skill_use: "off", memory_read: "ask", delegateTask: "off" },
      }).permissions,
    ).toEqual({
      skills: { "*": "deny", skill_use: "off" },
      memory: { "*": "deny", memory_read: "ask" },
      delegation: { "*": "deny", delegateTask: "off" },
    });
  });

  it("quarantines unmappable native values instead of dropping restrictive intent", () => {
    const result = migrateLegacyToolPermissions({ native: { unknown_tool: "off" } });
    expect(result.unmappable).toBe(1);
    expect(result.permissions).toEqual({ legacy_unmapped: { "native.unknown_tool": "off" } });
  });

  it("is idempotent after product keys have replaced legacy keys", () => {
    const once = migrateLegacyToolPermissions({ fetch: { fetch: "deny" } });
    const twice = migrateLegacyToolPermissions(once.permissions);
    expect(twice).toEqual({ permissions: { web: { fetch: "deny" } }, changed: false, unmappable: 0 });
  });
});

function profile(): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u1",
    model: { provider: "openrouter", id: "test" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: { permissions: { fetch: { fetch: "off" } }, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

it("boot migration preserves unrelated profile fields", async () => {
  const current = profile();
  const profileStore = {
    get: vi.fn(async () => ({ ok: true as const, value: current })),
    save: vi.fn(async (_profile: ProfileV1) => ({ ok: true as const, value: undefined })),
  };
  const userStore = { list: vi.fn(async () => ({ ok: true as const, value: [{ userId: "u1" }] })) } as unknown as Pick<
    UserStore,
    "list"
  >;
  await migrateWebToolsEnabled({ userStore, profileStore });
  const saved = profileStore.save.mock.calls[0]?.[0];
  expect(saved?.persona).toEqual(current.persona);
  expect(saved?.tools.permissions).toEqual({ web: { fetch: "off" } });
});
