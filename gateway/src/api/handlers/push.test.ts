import { describe, expect, it } from "bun:test";
import { createAccessManager } from "../../access/access-manager.js";
import type { UserId } from "../../user-auth/user-id.js";
import { createPushHandler } from "./push.js";

const userId = "u_a11ce001" as UserId;
const binding = {
  bindingId: "binding",
  installationId: "phone",
  platform: "ios" as const,
  generation: 1,
  state: "active" as const,
  preferences: { enabled: true, previewMode: "hidden" as const, revision: 1 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
function handler() {
  return createPushHandler({
    tokens: {
      validate: async (token) =>
        token === "ok" ? { ok: true, value: { userId, issuedAt: 1, expiresAt: 2 } } : { ok: false, error: "malformed" },
    },
    users: {
      get: async (id) =>
        id === userId
          ? {
              ok: true,
              value: {
                userId,
                role: "adult",
                displayName: "Alice",
                pinHash: "x",
                avatarTint: "sage",
                createdAt: "2026-01-01T00:00:00Z",
                credentialsValidFrom: "2026-01-01T00:00:00Z",
              },
            }
          : { ok: true, value: null },
    },
    accessManager: createAccessManager({ userDataRoot: "/tmp/push-handler" }),
    registrations: {
      issue: async () => ({
        ok: true,
        value: {
          binding,
          revocation: {
            bindingId: "binding",
            generation: 1,
            credential: "secret",
            expiresAt: "2026-01-02T00:00:00.000Z",
          },
          replayed: false,
        },
      }),
      readPreferences: async (resource) =>
        resource.ownerUserId === userId
          ? { ok: true, value: binding }
          : { ok: false, error: { code: "forbidden", retryable: false } },
      updatePreferences: async () => ({ ok: true, value: binding }),
    },
    revocations: {
      revoke: async (request) => ({
        ok: true,
        value: {
          bindingId: request.bindingId,
          generation: request.generation,
          status: "revoked",
          acknowledgedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    },
  });
}
describe("push HTTP authority", () => {
  it("device installation id is not proof for preference reads", async () => {
    const response = await handler()(new Request("http://x/api/v1/push/preferences?installationId=phone"));
    expect(response.status).toBe(401);
  });
  it("authenticated preference response never echoes revocation authority", async () => {
    const response = await handler()(
      new Request("http://x/api/v1/push/preferences?installationId=phone", { headers: { authorization: "Bearer ok" } }),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("the unauthenticated route exposes revoke only and validates its exact DTO", async () => {
    const response = await handler()(
      new Request("http://x/api/v1/push/revocations", {
        method: "POST",
        body: JSON.stringify({
          bindingId: "binding",
          generation: 1,
          idempotencyKey: "r",
          revocationCredential: "secret",
          readPreferences: true,
        }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
