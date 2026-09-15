import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import type { Capability } from "../../access/capability.js";
import { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import type { ScheduleCommands, ScheduledSessionCardCommands } from "../../scheduling/contracts.js";
import { createScheduleService } from "../../scheduling/service.js";
import { openSessionStore } from "../../store/session-store.js";
import type { UserId } from "../../user-auth/user-id.js";
import { createScheduledMessagesHandler } from "./scheduled-messages.js";

describe("scheduled messages API ownership", () => {
  test("selects storage only from the authenticated principal and rejects a body owner", async () => {
    let selected: UserId | undefined;
    let clearedOccurrenceIds: readonly string[] | undefined;
    const schedules: ScheduleCommands & ScheduledSessionCardCommands = {
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
      clearCard: async (resource) => {
        selected = resource.ownerUserId;
        return { ok: true, value: undefined };
      },
      clearCards: async (resource, occurrenceIds) => {
        selected = resource.ownerUserId;
        clearedOccurrenceIds = occurrenceIds;
        return { ok: true, value: undefined };
      },
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
    expect(
      (
        await handler(
          new Request("http://local/api/v1/scheduled-session-cards/session-owned", {
            method: "DELETE",
            headers: { authorization: "Bearer token" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(selected).toBe("u_aaaaaaaa");
    const clearAll = await handler(
      new Request("http://local/api/v1/scheduled-session-cards", {
        method: "DELETE",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ occurrenceIds: ["occ-owned"] }),
      }),
    );
    expect(clearAll.status).toBe(200);
    expect(selected).toBe("u_aaaaaaaa");
    expect(clearedOccurrenceIds).toEqual(["occ-owned"]);
  });

  test("rejects malformed bulk clear targets before scheduling", async () => {
    let calls = 0;
    const schedules = {
      create: async () => ({ ok: false as const, error: { code: "internal" as const, retryable: false } }),
      patch: async () => ({ ok: false as const, error: { code: "internal" as const, retryable: false } }),
      delete: async () => ({ ok: false as const, error: { code: "internal" as const, retryable: false } }),
      list: async () => ({ ok: true as const, value: { schedules: [] } }),
      cards: async () => ({ ok: true as const, value: { cards: [] } }),
      clearCard: async () => ({ ok: true as const, value: undefined }),
      clearCards: async () => {
        calls += 1;
        return { ok: true as const, value: undefined };
      },
    } satisfies ScheduleCommands & ScheduledSessionCardCommands;
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
    for (const body of [{ occurrenceIds: [] }, { occurrenceIds: [""] }, { occurrenceIds: ["same", "same"] }]) {
      const response = await handler(
        new Request("http://local/api/v1/scheduled-session-cards", {
          method: "DELETE",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
    }
    expect(calls).toBe(0);
  });

  test("serves cards committed by terminal finalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "scheduled-cards-api-"));
    const userId = "u_aaaaaaaa";
    const accessManager = createAccessManager({ userDataRoot: root });
    const schedules = createScheduleService({
      userDataRoot: root,
      clock: () => new Date("2026-08-02T00:00:00Z"),
    });
    const sessionStore = openSessionStore(
      Object.freeze({
        ownerUserId: userId,
        resource: "session-store",
        rootPath: join(root, userId),
        role: "adult",
      } satisfies Capability),
    );
    const resource = new PrivateScheduleResource(
      accessManager.grant(
        {
          userId,
          role: "adult",
          householdId: "home",
        },
        "schedule-private",
      ),
    );
    const seed = async (
      sessionId: string,
      key: string,
      completedAt: string,
      outcome: "completed" | "failed",
      text?: string,
    ) => {
      const created = await schedules.create(
        resource,
        {
          idempotencyKey: key,
          message: "Scheduled message",
          enabled: true,
          timing: { kind: "once-at", at: "2026-08-01T15:00:00Z" },
        },
        new Date("2026-08-01T14:00:00Z"),
      );
      if (!created.ok) throw new Error("create failed");
      const due = await schedules.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
      if (!due.ok || !due.value[0]) throw new Error("claim failed");
      const claim = due.value[0];
      sessionStore.createSession(sessionId, `scheduled:${claim.occurrenceId}`);
      sessionStore.setScheduledProvenance?.(
        sessionId,
        claim.scheduleId,
        claim.occurrenceId,
        claim.intendedAt,
        completedAt,
      );
      sessionStore.setScheduledTurn?.(sessionId, claim.occurrenceId, `turn-${key}`);
      const entry = text
        ? sessionStore.append({
            sessionId,
            turnId: `turn-${key}`,
            replyId: `reply-${key}`,
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
        `turn-${key}`,
        outcome,
        completedAt,
        entry ? String(entry.seq) : null,
      );
      if (!(await schedules.associateSession(claim, sessionId)).ok) throw new Error("association failed");
      const finalized = await schedules.finalizeClaim(
        claim,
        outcome === "completed" && entry
          ? {
              outcome,
              sessionId,
              completedAt,
              content: { ownerUserId: userId, sessionId, occurrenceId: claim.occurrenceId, entryId: String(entry.seq) },
            }
          : { outcome: "failed", sessionId, completedAt },
        undefined,
      );
      if (!finalized.ok) throw new Error("finalization failed");
      return claim.occurrenceId;
    };
    try {
      await seed("session-valid", "valid", "2026-08-01T15:00:03.000Z", "completed", "Saved response");
      const failedOccurrenceId = await seed("session-contentless", "contentless", "2026-08-01T15:00:02.000Z", "failed");
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

      const clearOne = await handler(
        new Request("http://local/api/v1/scheduled-session-cards/session-valid", {
          method: "DELETE",
          headers: { authorization: "Bearer token" },
        }),
      );
      expect(clearOne.status).toBe(200);
      expect(await clearOne.json()).toEqual({ cleared: true });
      const clearAgain = await handler(
        new Request("http://local/api/v1/scheduled-session-cards/session-valid", {
          method: "DELETE",
          headers: { authorization: "Bearer token" },
        }),
      );
      expect(clearAgain.status).toBe(200);
      const unknown = await handler(
        new Request("http://local/api/v1/scheduled-session-cards/unknown", {
          method: "DELETE",
          headers: { authorization: "Bearer token" },
        }),
      );
      expect(unknown.status).toBe(404);
      const encodedSlash = await handler(
        new Request("http://local/api/v1/scheduled-session-cards/session%2Fvalid", {
          method: "DELETE",
          headers: { authorization: "Bearer token" },
        }),
      );
      expect(encodedSlash.status).toBe(404);
      const clearAll = await handler(
        new Request("http://local/api/v1/scheduled-session-cards", {
          method: "DELETE",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({ occurrenceIds: [failedOccurrenceId] }),
        }),
      );
      expect(clearAll.status).toBe(200);
      expect(await clearAll.json()).toEqual({ cleared: true });
      const emptied = await handler(
        new Request("http://local/api/v1/scheduled-session-cards", {
          headers: { authorization: "Bearer token" },
        }),
      );
      expect(await emptied.json()).toEqual({ cards: [] });
    } finally {
      sessionStore.close();
      schedules.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
