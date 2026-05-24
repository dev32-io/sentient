import { describe, expect, it, vi } from "vitest";
import type { SessionRouter } from "../../session-router.js";
import { createUpdateUserSettingsTool } from "./update-user-settings.js";

const fakeRouter = {
  bind: vi.fn(),
  release: vi.fn(),
  rebind: vi.fn(),
  get: vi.fn(),
  updateConversationId: vi.fn(),
  findActiveSessionFor: vi.fn(),
} as unknown as SessionRouter;

const ctx = {
  sessionId: null,
  userId: "alice",
  role: "user" as const,
  sessionChannel: "voice" as const,
};

describe("update_user_settings", () => {
  it("rejects empty patch (no fields)", async () => {
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({}, ctx);
    expect(r.isError).toBe(true);
  });

  it("rejects invalid channel value", async () => {
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({ channel: "bogus" }, ctx);
    expect(r.isError).toBe(true);
  });

  it("errors when no active session", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({ ttsEnabled: false }, ctx);
    expect(r.isError).toBe(true);
  });

  it("invokes controls with valid ttsEnabled", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const updateUserSettings = vi.fn(async () => {});
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings },
      router: fakeRouter,
    });
    const r = await t.run({ ttsEnabled: false, channel: "text" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(updateUserSettings).toHaveBeenCalledWith("s1", "alice", {
      ttsEnabled: false,
      channel: "text",
    });
  });

  it("accepts voice + model fields", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const updateUserSettings = vi.fn(async () => {});
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings },
      router: fakeRouter,
    });
    await t.run(
      {
        voice: { provider: "fish-audio", id: "v123" },
        model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      },
      ctx,
    );
    expect(updateUserSettings).toHaveBeenCalledWith("s1", "alice", {
      voice: { provider: "fish-audio", id: "v123" },
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
    });
  });
});
