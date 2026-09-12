import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import type { Capability } from "../../access/capability.js";
import type { ScheduleCommands } from "../../scheduling/contracts.js";
import { createScheduleService } from "../../scheduling/service.js";
import { openSessionStore } from "../../store/session-store.js";
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

  test("serves valid cards when historical completed provenance has no response", async () => {
    const root = mkdtempSync(join(tmpdir(), "scheduled-cards-api-"));
    const userId = "u_aaaaaaaa";
    const accessManager = createAccessManager({ userDataRoot: root });
    const schedules = createScheduleService({ userDataRoot: root });
    const sessionStore = openSessionStore(
      Object.freeze({
        ownerUserId: userId,
        resource: "session-store",
        rootPath: join(root, userId),
        role: "adult",
      } satisfies Capability),
    );
    const seed = (sessionId: string, occurrenceId: string, completedAt: string, text?: string) => {
      sessionStore.createSession(sessionId, `scheduled:${occurrenceId}`);
      sessionStore.setScheduledProvenance?.(
        sessionId,
        `schedule-${occurrenceId}`,
        occurrenceId,
        "2026-08-01T15:00:00.000Z",
        "2026-08-01T15:00:01.000Z",
      );
      sessionStore.setScheduledTurn?.(sessionId, occurrenceId, `turn-${occurrenceId}`);
      const entry = text
        ? sessionStore.append({
            sessionId,
            turnId: `turn-${occurrenceId}`,
            replyId: `reply-${occurrenceId}`,
            kind: "assistant",
            createdAt: Date.parse(completedAt),
            text,
            toolCallId: null,
            toolName: null,
            toolArgs: null,
            cutoff: null,
            compactedThroughSeq: null,
            pendingId: null,
          })
        : undefined;
      sessionStore.recordScheduledTerminal?.(
        sessionId,
        `turn-${occurrenceId}`,
        "completed",
        completedAt,
        entry ? String(entry.seq) : null,
      );
    };
    try {
      seed("session-valid", "occurrence-valid", "2026-08-01T15:00:03.000Z", "Saved response");
      seed("session-contentless", "occurrence-contentless", "2026-08-01T15:00:02.000Z");
      const handler = createScheduledMessagesHandler({
        tokens: { validate: async () => ({ ok: true, value: { userId, issuedAt: 1, expiresAt: 2 } }) },
        users: {
          get: async () => ({
            ok: true,
            value: {
              userId,
              displayName: "Alice",
              pinHash: "x",
              role: "adult",
              avatarTint: "terra",
              createdAt: "2026-01-01T00:00:00Z",
              credentialsValidFrom: "2026-01-01T00:00:00Z",
            },
          }),
        },
        accessManager,
        schedules,
      });
      const response = await handler(
        new Request("http://local/api/v1/scheduled-session-cards", { headers: { authorization: "Bearer token" } }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as { cards: Array<{ sessionId: string; status: string }> };
      expect(body.cards.map((card) => [card.sessionId, card.status])).toEqual([
        ["session-valid", "completed"],
        ["session-contentless", "failed"],
      ]);
    } finally {
      sessionStore.close();
      schedules.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
