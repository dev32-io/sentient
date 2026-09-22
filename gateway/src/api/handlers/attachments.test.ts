import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import { createAttachmentStorage } from "../../attachments/storage.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import type { NewSessionEntry } from "../../store/entry-types.js";
import { openSessionStore } from "../../store/session-store.js";
import type { UserRecord } from "../../user-auth/types.js";
import { createAttachmentsHandler } from "./attachments.js";

const roots: string[] = [];
const limits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerAttempt: 8,
  maxRequestBytes: 20 * 1024 * 1024,
  maxUserBytes: 64 * 1024 * 1024,
  stagingTtlMs: 60_000,
};

function user(userId: string): UserRecord {
  return {
    userId,
    displayName: "Synthetic User",
    pinHash: "unused",
    role: "adult",
    avatarTint: "sage",
    createdAt: "2026-01-01T00:00:00.000Z",
    credentialsValidFrom: "1970-01-01T00:00:00.000Z",
  };
}

function entry(sessionId: string): NewSessionEntry {
  return {
    sessionId,
    turnId: "turn-http",
    replyId: null,
    kind: "user",
    createdAt: 100,
    text: "",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: "pending-http",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("attachments HTTP", () => {
  it("uploads idempotently, authorizes download, and deletes staged refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentient-attachments-http-"));
    roots.push(root);
    const access = createAccessManager({ userDataRoot: join(root, "users") });
    const users = new Map([
      ["u_a1b2c3d4", user("u_a1b2c3d4")],
      ["u_b1c2d3e4", user("u_b1c2d3e4")],
    ]);
    const handler = createAttachmentsHandler({
      tokens: {
        validate: async (token) => ({
          ok: true,
          value: { userId: token === "bob" ? "u_b1c2d3e4" : "u_a1b2c3d4", issuedAt: 1, expiresAt: 2 },
        }),
      },
      users: { get: async (id) => ({ ok: true, value: users.get(id) ?? null }) },
      accessManager: access,
      dbFileName: "sessions.db",
      limits,
    });

    const url =
      "http://localhost/api/v1/attachments?sendAttemptId=send-1&fileIdentity=file-1&displayName=note.txt&contentType=text%2Fplain";
    const first = await handler(
      new Request(url, { method: "POST", headers: { authorization: "Bearer alice" }, body: "synthetic" }),
    );
    expect(first.status).toBe(201);
    const uploaded = (await first.json()) as { attachmentId: string };

    const retry = await handler(
      new Request(url, { method: "POST", headers: { authorization: "Bearer alice" }, body: "synthetic" }),
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).attachmentId).toBe(uploaded.attachmentId);
    const changedRetry = await handler(
      new Request(url, { method: "POST", headers: { authorization: "Bearer alice" }, body: "different" }),
    );
    expect(changedRetry.status).toBe(409);
    expect(await changedRetry.json()).toEqual({ error: "identity_conflict" });

    const concurrentUrl =
      "http://localhost/api/v1/attachments?sendAttemptId=send-race&fileIdentity=file-race&displayName=race.txt&contentType=text%2Fplain";
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        handler(
          new Request(concurrentUrl, {
            method: "POST",
            headers: { authorization: "Bearer alice" },
            body: "same bytes",
          }),
        ),
      ),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(
      new Set(await Promise.all(concurrent.map(async (response) => (await response.json()).attachmentId))).size,
    ).toBe(1);

    expect(
      (
        await handler(
          new Request(`http://localhost/api/v1/attachments/${uploaded.attachmentId}`, {
            headers: { authorization: "Bearer bob" },
          }),
        )
      ).status,
    ).toBe(404);

    const principal = createUserPrincipal("u_a1b2c3d4", "adult", "home");
    const store = openSessionStore(access.grant(principal, "session-store"));
    const record = store.findAttachment(uploaded.attachmentId);
    if (!record) throw new Error("missing manifest");
    const admitted = store.admitUserMessage(entry("s_http"), [record.attachmentId], {
      maxAttachments: 8,
      createSession: { mintKey: "mint-http" },
    });
    const storage = createAttachmentStorage(access.grant(principal, "attachment-store") as never, limits);
    await storage.publishCommitted({ ...record, status: "staged" }, "s_http");
    store.markAttachmentReady(record.attachmentId, "s_http", admitted.entry.seq);
    store.close();

    const downloaded = await handler(
      new Request(`http://localhost/api/v1/attachments/${uploaded.attachmentId}`, {
        headers: { authorization: "Bearer alice" },
      }),
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("attachment;");
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await downloaded.text()).toBe("synthetic");

    const stagedResponse = await handler(
      new Request(
        "http://localhost/api/v1/attachments?sendAttemptId=send-2&fileIdentity=file-2&displayName=delete.txt&contentType=text%2Fplain",
        { method: "POST", headers: { authorization: "Bearer alice" }, body: "delete me" },
      ),
    );
    const staged = (await stagedResponse.json()) as { attachmentId: string };
    expect(
      (
        await handler(
          new Request(`http://localhost/api/v1/attachments/${staged.attachmentId}`, {
            method: "DELETE",
            headers: { authorization: "Bearer alice" },
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handler(
          new Request(`http://localhost/api/v1/attachments/${staged.attachmentId}`, {
            headers: { authorization: "Bearer alice" },
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("rejects unauthenticated, malformed, and oversized uploads before storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentient-attachments-http-validation-"));
    roots.push(root);
    const access = createAccessManager({ userDataRoot: join(root, "users") });
    const handler = createAttachmentsHandler({
      tokens: { validate: async () => ({ ok: true, value: { userId: "u_a1b2c3d4", issuedAt: 1, expiresAt: 2 } }) },
      users: { get: async () => ({ ok: true, value: user("u_a1b2c3d4") }) },
      accessManager: access,
      dbFileName: "sessions.db",
      limits: { ...limits, maxFileBytes: 4 },
    });
    expect((await handler(new Request("http://localhost/api/v1/attachments", { method: "POST" }))).status).toBe(401);
    expect(
      (
        await handler(
          new Request("http://localhost/api/v1/attachments?sendAttemptId=x", {
            method: "POST",
            headers: { authorization: "Bearer token" },
            body: "x",
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await handler(
          new Request(
            "http://localhost/api/v1/attachments?sendAttemptId=s&fileIdentity=f&displayName=x.txt&contentType=text%2Fplain",
            {
              method: "POST",
              headers: { authorization: "Bearer token", "content-length": "5" },
              body: "hello",
            },
          ),
        )
      ).status,
    ).toBe(413);
  });
});
