import { describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import { migrateWebToolsEnabled } from "./web-tools-migrator.js";

function makeProfile(overrides: Partial<ProfileV1["tools"]["permissions"]>): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u1",
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "v1" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: { permissions: overrides as ProfileV1["tools"]["permissions"], toolsets: [] },
    compression: { threshold: 0.8 },
    advanced: { extraSystemPrompt: "", maxTokens: 512, reasoningEffort: "minimal" },
  };
}

describe("migrateWebToolsEnabled", () => {
  it("renames duckduckgo key to searxng + fetch when present", async () => {
    const profile = makeProfile({ duckduckgo: { search: "allow" } });
    const profileStore = {
      get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
      save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

    await migrateWebToolsEnabled({ userStore, profileStore });

    expect(profileStore.save).toHaveBeenCalledTimes(1);
    const [saved] = (profileStore.save.mock.calls[0] ?? []) as [ProfileV1];
    expect(saved.tools.permissions.duckduckgo).toBeUndefined();
    expect(saved.tools.permissions.searxng).toEqual({});
    expect(saved.tools.permissions.fetch).toEqual({});
  });

  it("is a no-op when duckduckgo key is absent (idempotent)", async () => {
    const profile = makeProfile({ searxng: {}, fetch: {} });
    const profileStore = {
      get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
      save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

    await migrateWebToolsEnabled({ userStore, profileStore });

    expect(profileStore.save).not.toHaveBeenCalled();
  });

  it("preserves other entries in tools.permissions", async () => {
    const profile = makeProfile({
      duckduckgo: { search: "allow" },
      home_assistant: { ha_get_state: "allow" },
      music_assistant: {},
    });
    const profileStore = {
      get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
      save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

    await migrateWebToolsEnabled({ userStore, profileStore });

    const [saved] = (profileStore.save.mock.calls[0] ?? []) as [ProfileV1];
    expect(saved.tools.permissions.home_assistant).toEqual({ ha_get_state: "allow" });
    expect(saved.tools.permissions.music_assistant).toEqual({});
  });

  it("logs and skips users whose profile fails to load", async () => {
    const profileStore = {
      get: vi.fn().mockResolvedValue({ ok: false, error: "io-error" }),
      save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const userStore = {
      list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }, { userId: "u2" }] }),
    };

    await migrateWebToolsEnabled({ userStore, profileStore });

    expect(profileStore.get).toHaveBeenCalledTimes(2);
    expect(profileStore.save).not.toHaveBeenCalled();
  });
});
