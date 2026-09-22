import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import {
  type AttachmentStorage,
  consumeAttachmentCleanupIntents,
  createAttachmentStorage,
  mintAttachmentId,
} from "../attachments/storage.js";
import { snapshotFeedItems } from "../runtime/conversation-feed.js";
import type { NewSessionEntry } from "./entry-types.js";
import {
  AttachmentAdmissionError,
  openSessionStore,
  publishAdmittedAttachments,
  reconcileCommittedAttachments,
} from "./session-store.js";

const roots: string[] = [];
const limits = {
  maxFileBytes: 1024,
  maxFilesPerAttempt: 2,
  maxRequestBytes: 1024,
  maxUserBytes: 4096,
  stagingTtlMs: 60_000,
};

function cap(root: string, resource: "session-store" | "attachment-store"): Capability {
  return { ownerUserId: "u_a1b2c3d4", resource, rootPath: root, role: "adult" };
}

function entry(sessionId: string, pendingId: string): NewSessionEntry {
  return {
    sessionId,
    turnId: "turn-1",
    replyId: null,
    kind: "user",
    createdAt: 10,
    text: "read this",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("attachment message admission", () => {
  it("atomically creates first session, binds refs, survives publish crash, and projects metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentient-attachment-admission-"));
    roots.push(root);
    const storage = createAttachmentStorage(cap(root, "attachment-store") as never, limits);
    const staged = (
      await storage.stageAttempt("send-1", [
        {
          attachmentId: mintAttachmentId(),
          fileIdentity: "file-1",
          displayName: "notes.txt",
          contentType: "text/plain",
          bytes: (async function* () {
            yield new TextEncoder().encode("synthetic notes");
          })(),
        },
      ])
    )[0];
    if (!staged) throw new Error("missing staged attachment");

    let store = openSessionStore(cap(root, "session-store"));
    store.registerStagedAttachment(staged, staged.stagedAt + limits.stagingTtlMs);
    expect(() =>
      store.admitUserMessage(entry("s_failed", "pending-failed"), ["att_00000000000000000000000000000000"], {
        maxAttachments: 2,
        createSession: { mintKey: "mint-failed" },
      }),
    ).toThrow(AttachmentAdmissionError);
    expect(store.getSession("s_failed")).toBeNull();

    const admitted = store.admitUserMessage(entry("s_first", "pending-1"), [staged.attachmentId], {
      maxAttachments: 2,
      createSession: { mintKey: "mint-first" },
    });
    expect(admitted.attachments[0]?.status).toBe("committed");
    expect(store.findAttachment(staged.attachmentId)?.status).toBe("committed");
    store.close();

    // Crash seam: DB commit precedes file publication. Reopen finds work to reconcile.
    store = openSessionStore(cap(root, "session-store"));
    const pending = store.listCommittedAttachments(10);
    expect(pending.map((item) => item.attachmentId)).toEqual([staged.attachmentId]);
    expect(await reconcileCommittedAttachments(store, storage, 10)).toEqual({ ready: 1, failed: 0 });
    const ready = store.findAttachment(staged.attachmentId);
    if (!ready?.sessionId) throw new Error("attachment was not reconciled");
    const durable = { ...ready, status: "durable" as const, sessionId: ready.sessionId };
    expect(snapshotFeedItems(store.readSession("s_first"))[0]).toMatchObject({
      kind: "user",
      sessionId: "s_first",
      attachments: [{ attachmentId: staged.attachmentId, displayName: "notes.txt", size: 15 }],
    });

    const retry = store.admitUserMessage(entry("s_first", "pending-1"), [staged.attachmentId], {
      maxAttachments: 2,
    });
    expect(retry.entry.seq).toBe(admitted.entry.seq);
    expect(await collect(storage.read(durable))).toBe("synthetic notes");
    expect(store.deleteSession("s_first").status).toBe("deleted");
    expect(store.findAttachment(staged.attachmentId)).toBeNull();
    expect(store.listFileCleanupIntents(10).map((intent) => intent.sessionId)).toEqual(["s_first"]);
    store.close();
  });

  it("fences publication after cleanup and serializes cleanup racing an in-flight publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentient-attachment-publication-fence-"));
    roots.push(root);
    const storage = createAttachmentStorage(cap(root, "attachment-store") as never, limits);
    const store = openSessionStore(cap(root, "session-store"));

    async function admit(sessionId: string, attempt: string) {
      const staged = (
        await storage.stageAttempt(attempt, [
          {
            attachmentId: mintAttachmentId(),
            fileIdentity: "file-1",
            displayName: "private.txt",
            contentType: "text/plain",
            bytes: (async function* () {
              yield new TextEncoder().encode("private bytes");
            })(),
          },
        ])
      )[0];
      if (!staged) throw new Error("missing staged attachment");
      store.registerStagedAttachment(staged, staged.stagedAt + limits.stagingTtlMs);
      return {
        staged,
        admission: store.admitUserMessage(entry(sessionId, `pending-${attempt}`), [staged.attachmentId], {
          maxAttachments: 2,
          createSession: { mintKey: `mint-${attempt}` },
        }),
      };
    }

    const late = await admit("s_late", "late");
    expect(store.deleteSession("s_late").status).toBe("deleted");
    expect(await consumeAttachmentCleanupIntents(store, storage, 10)).toEqual({ cleaned: 1, failed: 0 });
    await expect(publishAdmittedAttachments(store, storage, late.admission)).rejects.toMatchObject({
      code: "identity_conflict",
    });
    await expect(
      collect(storage.read({ ...late.staged, status: "durable", sessionId: "s_late" })),
    ).rejects.toMatchObject({ code: "not_found" });

    const racing = await admit("s_racing", "racing");
    let cleanup: Promise<{ cleaned: number; failed: number }> | undefined;
    const racingStorage: Pick<AttachmentStorage, "publishCommitted"> = {
      publishCommitted: (ref, sessionId, fence) =>
        storage.publishCommitted(ref, sessionId, () => {
          const allowed = fence?.() ?? true;
          expect(store.deleteSession(sessionId).status).toBe("deleted");
          cleanup = consumeAttachmentCleanupIntents(store, storage, 10);
          return allowed;
        }),
    };
    await expect(publishAdmittedAttachments(store, racingStorage, racing.admission)).rejects.toBeInstanceOf(
      AttachmentAdmissionError,
    );
    expect(await cleanup).toEqual({ cleaned: 1, failed: 0 });
    await expect(
      collect(storage.read({ ...racing.staged, status: "durable", sessionId: "s_racing" })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(store.listFileCleanupIntents(10)).toEqual([]);
    store.close();
  });
});

async function collect(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of bytes) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}
