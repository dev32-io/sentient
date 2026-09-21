import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../access/access-manager.js";
import { type AttachmentCapability, type AttachmentUpload, createAttachmentStorage } from "../attachments/storage.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { type AttachmentSessionStore, openSessionStore } from "../store/session-store.js";
import { cleanupUser } from "./history-user-cleanup.js";

const roots: string[] = [];
const principal = createUserPrincipal("u_aaaaaaaa", "adult", "home");
const limits = {
  maxFileBytes: 1024,
  maxFilesPerAttempt: 2,
  maxRequestBytes: 2048,
  maxUserBytes: 4096,
  stagingTtlMs: 50,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "history-user-cleanup-"));
  roots.push(root);
  const access = createAccessManager({ userDataRoot: root });
  mkdirSync(access.userHomeDir(principal), { recursive: true });
  return {
    root,
    access,
    store: openSessionStore(access.grant(principal, "session-store")),
    storage: createAttachmentStorage(access.grant(principal, "attachment-store") as AttachmentCapability, limits),
  };
}

function entry(sessionId: string, createdAt: number, overrides: Partial<NewSessionEntry> = {}): NewSessionEntry {
  return {
    sessionId,
    turnId: `turn-${sessionId}`,
    replyId: null,
    kind: "user",
    createdAt,
    text: "synthetic",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...overrides,
  };
}

function only<T>(items: readonly T[]): T {
  const item = items[0];
  if (!item) throw new Error("expected one item");
  return item;
}

function upload(attachmentId: string, fileIdentity: string, text: string): AttachmentUpload {
  return {
    attachmentId,
    fileIdentity,
    displayName: "fixture.txt",
    contentType: "text/plain",
    bytes: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}

const noResidentSessions = { handlesFor: () => null };

function run(
  store: AttachmentSessionStore,
  storage: ReturnType<typeof createAttachmentStorage>,
  overrides: Partial<Parameters<typeof cleanupUser>[0]> = {},
) {
  return cleanupUser({
    principal,
    store,
    storage,
    sessionRegistry: noResidentSessions,
    cutoff: null,
    batchSize: 2,
    finishSessionDeletion: () => undefined,
    ...overrides,
  });
}

describe("per-user history cleanup", () => {
  it("keyset-pages past a busy first batch and preserves activity committed after selection", async () => {
    const { store, storage } = harness();
    const old = 1_000;
    for (const id of ["s_busy_a", "s_busy_b", "s_idle", "s_fresh"]) store.append(entry(id, old));

    let refreshed = false;
    const selectingStore = {
      ...store,
      listRetentionCandidates(cutoff: number, limit: number, after?: { sessionId: string; lastActivityAt: number }) {
        const found = store.listRetentionCandidates(cutoff, limit, after);
        if (!after && !refreshed) {
          refreshed = true;
          store.append(entry("s_fresh", cutoff + 1, { turnId: "fresh-turn" }));
        }
        return found;
      },
    } satisfies AttachmentSessionStore;
    const deleted: string[] = [];
    const busy = new Set(["s_busy_a", "s_busy_b"]);
    const result = await run(selectingStore, storage, {
      cutoff: 2_000,
      sessionRegistry: {
        handlesFor: (sessionId) =>
          busy.has(sessionId) ? ({ work: { isTurnInFlight: true, hasPendingForegroundTool: false } } as never) : null,
      },
      finishSessionDeletion: (_principal, sessionId) => deleted.push(sessionId),
    });

    expect(deleted).toEqual(["s_idle"]);
    expect(result.deleted).toBe(1);
    expect(store.readSession("s_fresh")).toHaveLength(2);
    expect(store.readSession("s_busy_a")).toHaveLength(1);
    store.close();
  });

  it("at retention zero repairs committed files and expires only uncommitted expired staging", async () => {
    const { root, store, storage } = harness();
    const committed = only(
      await storage.stageAttempt("attempt-committed", [
        upload("att_11111111111111111111111111111111", "committed", "keep"),
      ]),
    );
    const expired = await Promise.all(
      ["2", "3", "4"].map(async (digit) =>
        only(
          await storage.stageAttempt(`attempt-expired-${digit}`, [
            upload(`att_${digit.repeat(32)}`, `expired-${digit}`, "drop"),
          ]),
        ),
      ),
    );
    store.registerStagedAttachment(committed, Date.now() + 10_000);
    for (const item of expired) store.registerStagedAttachment(item, Date.now() - 1);
    store.admitUserMessage(entry("s_committed", Date.now(), { pendingId: "pending-1" }), [committed.attachmentId], {
      maxAttachments: 2,
      createSession: { mintKey: "mint-1" },
    });
    const old = new Date(Date.now() - 1_000);
    for (const item of expired)
      await utimes(join(root, principal.userId, "attachments", "staging", item.attachmentId), old, old);

    const result = await run(store, storage, { cutoff: null, now: () => Date.now() });

    expect(result.reconciled).toBe(1);
    expect(store.findAttachment(committed.attachmentId)?.status).toBe("ready");
    for (const item of expired) {
      expect(store.findAttachment(item.attachmentId)).toBeNull();
      expect(existsSync(join(root, principal.userId, "attachments", "staging", item.attachmentId))).toBe(false);
    }
    expect(store.getSession("s_committed")).not.toBeNull();
    store.close();
  });

  it("drains newly accepted deletions past a failed first cleanup batch", async () => {
    const { store, storage } = harness();
    for (const id of ["s_a", "s_b", "s_c"]) store.append(entry(id, 1_000));
    const attempted: string[] = [];
    const result = await run(
      store,
      {
        ...storage,
        cleanupSession: async (id) => {
          attempted.push(id);
          if (id === "s_a") throw new Error("synthetic unlink failure");
          await storage.cleanupSession(id);
        },
      },
      { cutoff: 2_000, batchSize: 1 },
    );
    expect(result.deleted).toBe(3);
    expect(attempted).toEqual(["s_a", "s_b", "s_c"]);
    expect(result.cleanupIntentsFailed).toBe(1);
    expect(store.listFileCleanupIntents(10).map((intent) => intent.sessionId)).toEqual(["s_a"]);
    store.close();
  });

  it("keeps a failed durable cleanup intent for a successful restart retry", async () => {
    const { root, access, store, storage } = harness();
    const staged = only(
      await storage.stageAttempt("attempt-durable", [
        upload("att_33333333333333333333333333333333", "durable", "durable"),
      ]),
    );
    store.registerStagedAttachment(staged, Date.now() + 10_000);
    store.admitUserMessage(entry("s_delete", 1_000, { pendingId: "pending-delete" }), [staged.attachmentId], {
      maxAttachments: 2,
      createSession: { mintKey: "mint-delete" },
    });
    await storage.publishCommitted(staged, "s_delete");
    store.deleteSession("s_delete");

    const failed = await run(store, { ...storage, cleanupSession: async () => Promise.reject(new Error("synthetic")) });
    expect(failed.cleanupIntentsFailed).toBe(1);
    expect(store.listFileCleanupIntents(10)).toHaveLength(1);
    store.close();

    const restarted = openSessionStore(access.grant(principal, "session-store"));
    await run(restarted, storage);
    expect(restarted.listFileCleanupIntents(10)).toEqual([]);
    expect(readdirSync(join(root, principal.userId, "attachments", "sessions"))).toEqual([]);
    restarted.close();
  });
});
