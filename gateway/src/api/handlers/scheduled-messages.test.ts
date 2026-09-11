import { describe, expect, test } from "bun:test";
import { createAccessManager } from "../../access/access-manager.js";
import type { ScheduleCommands } from "../../scheduling/contracts.js";
import type { UserId } from "../../user-auth/user-id.js";
import { createScheduledMessagesHandler } from "./scheduled-messages.js";

describe("scheduled messages API ownership", () => {
  test("selects storage only from the authenticated principal and rejects a body owner", async () => {
    let selected: UserId | undefined;
    const schedules: ScheduleCommands = {
      create: async (resource) => {
        selected = resource.ownerUserId;
        return { ok: false, error: { code: "internal", retryable: false } };
      },
      patch: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
      delete: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
      list: async (resource) => {
        selected = resource.ownerUserId;
        return { ok: true, value: { schedules: [] } };
      },
      cards: async () => ({ ok: true, value: { cards: [] } }),
    };
    const handler = createScheduledMessagesHandler({
      tokens: { validate: async () => ({ ok: true, value: { userId: "u_aaaaaaaa", issuedAt: 1, expiresAt: 2 } }) },
      users: {
        get: async () => ({
          ok: true,
          value: {
            userId: "u_aaaaaaaa",
            displayName: "Alice",
            pinHash: "x",
            role: "adult",
            avatarTint: "terra",
            createdAt: "2026-01-01T00:00:00Z",
            credentialsValidFrom: "2026-01-01T00:00:00Z",
          },
        }),
      },
      accessManager: createAccessManager({ userDataRoot: "/tmp/schedule-handler-users" }),
      schedules,
    });
    const list = await handler(
      new Request("http://local/api/v1/schedules?userId=u_bbbbbbbb", { headers: { authorization: "Bearer token" } }),
    );
    expect(list.status).toBe(200);
    expect(selected).toBe("u_aaaaaaaa");
    const create = await handler(
      new Request("http://local/api/v1/schedules", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({
          ownerUserId: "u_bbbbbbbb",
          idempotencyKey: "x",
          message: "hello",
          timing: { kind: "once-after", afterSeconds: 30 },
        }),
      }),
    );
    expect(create.status).toBe(422);
    expect(selected).toBe("u_aaaaaaaa");
  });
});
