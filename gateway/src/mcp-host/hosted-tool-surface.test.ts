import { mcpCatalogSchema } from "@sentient/config";
import { describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import { NEVER_REVOKED } from "../user-auth/credential-floor.js";
import type { UserRecord } from "../user-auth/types.js";
import { createHostedToolSurface } from "./hosted-tool-surface.js";

const catalog = mcpCatalogSchema.parse({
  gateway: {
    product_group: "gateway",
    default_exposure: "advanced",
    transport: "stdio",
    command: "nc",
    tools: { include: [{ name: "identify_user", tier: "read" }] },
  },
});

function profile(permission?: "allow" | "ask" | "deny" | "off"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u_test",
    model: { provider: "openrouter", id: "test" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: { permissions: permission ? { gateway: { identify_user: permission } } : undefined, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

const user: UserRecord = {
  userId: "u_test",
  displayName: "Test",
  pinHash: "hash",
  role: "adult",
  avatarTint: "sage",
  createdAt: "2026-01-01T00:00:00.000Z",
  credentialsValidFrom: NEVER_REVOKED,
};

describe("gateway-hosted delegated permission projection", () => {
  it("defaults advanced tools off, advertises only allow, and rechecks before dispatch", async () => {
    let current = profile();
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const surface = createHostedToolSurface({
      userId: "u_test",
      handlers: [
        {
          def: { name: "identify_user", description: "identify", inputSchema: { type: "object", properties: {} } },
          run,
        },
      ],
      catalog,
      profileStore: {
        get: vi.fn(async () => ({ ok: true as const, value: current })),
        save: vi.fn(async () => ({ ok: true as const, value: undefined })),
        remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
      },
      userStore: { get: vi.fn(async () => ({ ok: true as const, value: user })) },
    });

    await surface.refresh();
    expect(surface.definitions()).toEqual([]);

    current = profile("allow");
    await surface.refresh();
    expect(surface.definitions().map((definition) => definition.name)).toEqual(["identify_user"]);
    const advertised = surface.handler("identify_user");
    expect(advertised).not.toBeNull();

    current = profile("ask");
    const denied = await advertised?.run({}, { sessionId: null, userId: "u_test", sessionChannel: "voice" });
    expect(denied?.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await surface.refresh();
    expect(surface.definitions()).toEqual([]);

    for (const permission of ["deny", "off"] as const) {
      current = profile(permission);
      await surface.refresh();
      expect(surface.definitions()).toEqual([]);
    }
  });
});
