import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../../access/access-manager.js";
import type { AttachmentParserClient } from "../../attachments/parser-client.js";
import { createAttachmentStorage, mintAttachmentId } from "../../attachments/storage.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import { openSessionStore } from "../../store/session-store.js";
import type { UserRecord } from "../../user-auth/types.js";
import { createAttachmentsHandler } from "./attachments.js";

const roots: string[] = [];
const limits = {
  maxFileBytes: 1024,
  maxFilesPerAttempt: 2,
  maxRequestBytes: 1024,
  maxUserBytes: 4096,
  stagingTtlMs: 60_000,
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

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

async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("attachment preview HTTP integration", () => {
  it("renders only owner-ready assets through parser and keeps original endpoint as download", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentient-attachment-preview-"));
    roots.push(root);
    const access = createAccessManager({ userDataRoot: join(root, "users") });
    const principal = createUserPrincipal("u_a1b2c3d4", "adult", "home");
    const storage = createAttachmentStorage(access.grant(principal, "attachment-store") as never, limits);
    const [staged] = await storage.stageAttempt("send-preview", [
      {
        attachmentId: mintAttachmentId(),
        fileIdentity: "file-preview",
        displayName: "fixture.png",
        contentType: "image/png",
        bytes: bytes(PNG),
      },
    ]);
    if (!staged) throw new Error("staging failed");
    const store = openSessionStore(access.grant(principal, "session-store"));
    const record = store.registerStagedAttachment(staged, Date.now() + 60_000);
    const admission = store.admitUserMessage(
      {
        sessionId: "session-preview",
        turnId: "turn-preview",
        replyId: null,
        kind: "user",
        createdAt: Date.now(),
        text: "",
        toolCallId: null,
        toolName: null,
        toolArgs: null,
        cutoff: null,
        compactedThroughSeq: null,
        pendingId: "pending-preview",
      },
      [record.attachmentId],
      { maxAttachments: 2, createSession: { mintKey: "mint-preview" } },
    );
    await storage.publishCommitted({ ...record, status: "staged" }, "session-preview");
    store.markAttachmentReady(record.attachmentId, "session-preview", admission.entry.seq);
    store.close();

    const operations: string[] = [];
    const requestedEdges: number[] = [];
    let previewBody = PNG;
    const parser: AttachmentParserClient = {
      async parse(request) {
        operations.push(request.operation.operation);
        if ("maxEdge" in request.operation) requestedEdges.push(request.operation.maxEdge);
        return {
          ok: true,
          value: { requestId: "synthetic", status: 200, contentType: "image/png", headers: {}, body: previewBody },
        };
      },
    };
    const users = new Map([
      [principal.userId, user(principal.userId)],
      ["u_b1c2d3e4", user("u_b1c2d3e4")],
    ]);
    const handlerDeps = {
      tokens: {
        validate: async (token: string) => ({
          ok: true as const,
          value: { userId: token === "foreign" ? "u_b1c2d3e4" : principal.userId, issuedAt: 1, expiresAt: 2 },
        }),
      },
      users: { get: async (id: string) => ({ ok: true as const, value: users.get(id) ?? null }) },
      accessManager: access,
      dbFileName: "sessions.db",
      limits,
    };
    const handler = createAttachmentsHandler({ ...handlerDeps, parser, previewMaxEdge: 800 });
    const item = `http://localhost/api/v1/attachments/${record.attachmentId}`;

    const foreign = await handler(new Request(`${item}/preview`, { headers: { authorization: "Bearer foreign" } }));
    expect(foreign.status).toBe(404);
    expect(operations).toEqual([]);

    const preview = await handler(new Request(`${item}/preview`, { headers: { authorization: "Bearer owner" } }));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("content-disposition")).toContain("inline;");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG);
    expect(operations).toEqual(["image-normalize"]);
    expect(requestedEdges).toEqual([640]);

    previewBody = new Uint8Array(5 * 1024 * 1024 + 1);
    previewBody.set(PNG);
    const oversized = await handler(new Request(`${item}/preview`, { headers: { authorization: "Bearer owner" } }));
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toEqual({ error: "preview_too_large" });

    const original = await handler(new Request(item, { headers: { authorization: "Bearer owner" } }));
    expect(original.status).toBe(200);
    expect(original.headers.get("content-disposition")).toContain("attachment;");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(PNG);

    const unavailable = await createAttachmentsHandler(handlerDeps)(
      new Request(`${item}/preview`, { headers: { authorization: "Bearer owner" } }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "parser_unavailable" });
  });
});
