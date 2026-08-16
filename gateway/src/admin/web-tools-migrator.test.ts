import { describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { UserStore } from "../user-auth/user-store.js";
import { migrateLegacyToolPermissions, migrateWebToolsEnabled } from "./web-tools-migrator.js";

describe("legacy product-tool permission migration", () => {
  it("preserves absent versus explicitly empty maps", () => {
    expect(migrateLegacyToolPermissions(undefined)).toEqual({
      permissions: undefined,
      changed: false,
      unmappable: 0,
    });
    expect(migrateLegacyToolPermissions({})).toEqual({
      permissions: {},
      changed: false,
      unmappable: 0,
    });
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
      web: { fetch_content: "off", web_search: "deny" },
      home: { home_state: "allow" },
      music: { "*": "ask" },
      legacy_unmapped: { "music_assistant.ma_play": "ask" },
      gateway: { identify_user: "off" },
    });
  });

  it("keeps unmappable restrictive intent active through the native group wildcard", () => {
    const result = migrateLegacyToolPermissions({
      home_assistant: { ha_eval_template: "off" },
    });
    expect(result).toMatchObject({
      unmappable: 1,
      permissions: { home: { "*": "off" } },
    });
  });

  it("preserves omitted retired servers as off in every partial legacy map", () => {
    const once = migrateLegacyToolPermissions({
      fetch: { fetch: "allow" },
      gateway: { identify_user: "deny" },
    });
    expect(once.permissions).toEqual({
      web: { "*": "off", fetch_content: "allow" },
      home: { "*": "off" },
      music: { "*": "off" },
      gateway: { identify_user: "deny" },
    });
    expect(migrateLegacyToolPermissions(once.permissions)).toEqual({
      permissions: once.permissions,
      changed: false,
      unmappable: 0,
    });
  });

  it("does not carry an old read-tier allow onto a native Music write", () => {
    expect(migrateLegacyToolPermissions({ music_assistant: { ma_volume: "allow" } }).permissions).toEqual({
      web: { "*": "off" },
      home: { "*": "off" },
      music: { music_volume: "ask" },
    });
  });

  it("uses the more restrictive value when legacy groups collide", () => {
    expect(
      migrateLegacyToolPermissions({
        fetch: { "*": "allow" },
        searxng: { "*": "off" },
      }).permissions,
    ).toEqual({
      web: { "*": "off" },
      home: { "*": "off" },
      music: { "*": "off" },
      legacy_unmapped: { "fetch.*": "allow", "searxng.*": "off" },
    });
  });

  it("splits native tools and copies a native wildcard conservatively", () => {
    expect(
      migrateLegacyToolPermissions({
        native: {
          "*": "deny",
          skill_use: "off",
          memory_read: "ask",
          delegateTask: "off",
        },
      }).permissions,
    ).toEqual({
      web: { "*": "off" },
      home: { "*": "off" },
      music: { "*": "off" },
      skills: { "*": "deny", skill_use: "off" },
      memory: { "*": "deny", memory_read: "ask" },
      delegation: { "*": "deny", delegateTask: "off" },
    });
  });

  it("quarantines unmappable native values instead of dropping restrictive intent", () => {
    const result = migrateLegacyToolPermissions({
      native: { unknown_tool: "off" },
    });
    expect(result.unmappable).toBe(1);
    expect(result.permissions).toEqual({
      web: { "*": "off" },
      home: { "*": "off" },
      music: { "*": "off" },
      legacy_unmapped: { "native.unknown_tool": "off" },
    });
  });

  it("is idempotent after a partial legacy map has been made restrictive", () => {
    const once = migrateLegacyToolPermissions({ fetch: { fetch: "deny" } });
    expect(once.permissions).toEqual({
      web: { "*": "off", fetch_content: "deny" },
      home: { "*": "off" },
      music: { "*": "off" },
    });
    const twice = migrateLegacyToolPermissions(once.permissions);
    expect(twice).toEqual({
      permissions: once.permissions,
      changed: false,
      unmappable: 0,
    });
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
    advanced: {
      extraSystemPrompt: "",
      maxTokens: 1024,
      reasoningEffort: "minimal",
    },
  };
}

it("boot migration preserves unrelated profile fields", async () => {
  const current = profile();
  const profileStore = {
    get: vi.fn(async () => ({ ok: true as const, value: current })),
    save: vi.fn(async (_profile: ProfileV1) => ({
      ok: true as const,
      value: undefined,
    })),
  };
  const userStore = {
    list: vi.fn(async () => ({ ok: true as const, value: [{ userId: "u1" }] })),
  } as unknown as Pick<UserStore, "list">;
  await migrateWebToolsEnabled({ userStore, profileStore });
  const saved = profileStore.save.mock.calls[0]?.[0];
  expect(saved?.persona).toEqual(current.persona);
  expect(saved?.tools.permissions).toEqual({
    web: { "*": "off", fetch_content: "off" },
    home: { "*": "off" },
    music: { "*": "off" },
  });
});
