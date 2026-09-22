import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationPendingDeleteError,
  DraftConflictError,
  type DraftStore,
  createDraftStore,
  normalizeGatewayUrl,
} from "./draft-store.ts";

const stores: DraftStore[] = [];
const databases: string[] = [];

function store(accountId = "account-a", gatewayUrl = "wss://EXAMPLE.test/api/v1/ws/"): DraftStore {
  const databaseName = `sentient-drafts-test-${crypto.randomUUID()}`;
  databases.push(databaseName);
  const result = createDraftStore({ accountId, gatewayUrl, databaseName, now: () => 1234 });
  stores.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((item) => item.close()));
  await Promise.all(
    databases.splice(0).map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
});

describe("draft IndexedDB availability", () => {
  it("requires IndexedDB in test environment", () => {
    expect(typeof globalThis.indexedDB).toBe("object");
  });
});

describe("draft store", () => {
  it("isolates account scopes and enforces one draft per existing session", async () => {
    const databaseName = `sentient-drafts-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const first = createDraftStore({
      accountId: "account-a",
      gatewayUrl: "wss://EXAMPLE.test/api/v1/ws/",
      databaseName,
    });
    const sameScope = createDraftStore({
      accountId: "account-a",
      gatewayUrl: "wss://example.test/api/v1/ws",
      databaseName,
    });
    const otherAccount = createDraftStore({
      accountId: "account-b",
      gatewayUrl: "wss://example.test/api/v1/ws",
      databaseName,
    });
    stores.push(first, sameScope, otherAccount);

    const draft = await first.save({ sessionId: "session-1", text: "first", attachments: [] }, null);
    expect(draft.id).toMatch(/^d_[0-9a-f]{32}$/);
    expect((await sameScope.list()).drafts).toEqual([draft]);
    expect((await otherAccount.list()).drafts).toEqual([]);
    await expect(
      sameScope.save({ sessionId: "session-1", text: "second", attachments: [] }, null),
    ).rejects.toBeInstanceOf(DraftConflictError);

    await first.save({ sessionId: null, text: "new one", attachments: [] }, null);
    await first.save({ sessionId: null, text: "new two", attachments: [] }, null);
    expect((await first.list()).drafts).toHaveLength(4);
  });

  it("freezes stable pending identity and preserves newer edits on old acknowledgement", async () => {
    const drafts = store();
    const blob = new Blob(["synthetic"], { type: "text/plain" });
    const original = await drafts.save(
      {
        sessionId: null,
        text: "send this",
        attachments: [{ id: "attachment-1", name: "fixture.txt", type: "text/plain", blob }],
      },
      null,
    );
    const pending = await drafts.beginSend(original.id, original.revision, "surface-a");
    expect(pending).toMatchObject({ mintKey: original.id, surfaceId: "surface-a" });
    expect(await drafts.beginSend(original.id, original.revision, "surface-a")).toEqual(pending);
    const uploaded = await drafts.saveUploadedRef(pending.pendingId, "attachment-1", {
      attachmentId: "att_0123456789abcdef0123456789abcdef",
      displayName: "fixture.txt",
      contentType: "text/plain",
      mediaKind: "text",
      size: 9,
    });
    expect((await drafts.list()).pendingSends[0]?.uploadedRefs).toEqual(uploaded.uploadedRefs);
    expect(await drafts.beginSend(original.id, original.revision, "surface-b")).toEqual(uploaded);
    const bound = await drafts.bindPendingSession(pending.pendingId, "session-created");
    expect(bound).toMatchObject({
      mintKey: original.id,
      sessionId: "session-created",
      uploadedRefs: uploaded.uploadedRefs,
    });

    const edited = await drafts.save({ ...original, text: "newer edit" }, original.revision);
    expect(pending.text).toBe("send this");
    expect(await pending.attachments[0]?.blob.text()).toBe("synthetic");
    expect(await drafts.reconcileSend(pending.pendingId, "acknowledged")).toBe(true);
    expect((await drafts.list()).drafts).toEqual([edited]);
    expect((await drafts.list()).pendingSends).toEqual([]);
  });

  it("persists stale edits as a detached recovery draft", async () => {
    const databaseName = `sentient-drafts-test-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const first = createDraftStore({ accountId: "account-a", gatewayUrl: "wss://example.test", databaseName });
    const second = createDraftStore({ accountId: "account-a", gatewayUrl: "wss://example.test", databaseName });
    stores.push(first, second);
    const original = await first.save({ sessionId: "session-1", text: "original", attachments: [] }, null);
    await first.save({ ...original, text: "winner" }, original.revision);

    const conflict = await second.save({ ...original, text: "loser" }, original.revision).catch((cause) => cause);
    expect(conflict).toBeInstanceOf(DraftConflictError);
    expect((conflict as DraftConflictError).recovery).toMatchObject({ sessionId: null, text: "loser" });
    expect((conflict as DraftConflictError).recovery?.id).toMatch(/^d_[0-9a-f]{32}$/);
    expect((await first.list()).drafts.map((draft) => draft.text).sort()).toEqual(["loser", "winner"]);
  });

  it("atomically detaches edits and fences pending send after remote deletion", async () => {
    const drafts = store();
    const draft = await drafts.save({ sessionId: "session-1", text: "recover me", attachments: [] }, null);
    await drafts.beginSend(draft.id, draft.revision, "surface-a");

    const detached = await drafts.detachSession("session-1");
    const snapshot = await drafts.list();
    expect(detached).toMatchObject({ sessionId: null, text: "recover me", revision: 1 });
    expect(detached?.id).toMatch(/^d_[0-9a-f]{32}$/);
    expect(snapshot.drafts).toEqual([detached]);
    expect(snapshot.pendingSends).toEqual([]);
  });

  it("atomically persists delete intent and removes related draft and pending send", async () => {
    const drafts = store();
    const draft = await drafts.save({ sessionId: "session-1", text: "unsent", attachments: [] }, null);
    await drafts.beginSend(draft.id, draft.revision, "surface-a");

    const intent = await drafts.saveDeleteIntent("session-1");
    const snapshot = await drafts.list();
    expect(snapshot.drafts).toEqual([]);
    expect(snapshot.pendingSends).toEqual([]);
    expect(snapshot.deleteIntents).toEqual([intent]);
    await expect(
      drafts.save({ sessionId: "session-1", text: "must not resurrect", attachments: [] }, null),
    ).rejects.toBeInstanceOf(ConversationPendingDeleteError);

    await drafts.saveDeleteIntent("session-1", "forbidden");
    expect((await drafts.list()).deleteIntents[0]).toMatchObject({
      failureCode: "forbidden",
      createdAt: intent.createdAt,
    });
    await drafts.removeDeleteIntent("session-1");
    expect((await drafts.list()).deleteIntents).toEqual([]);
  });
});

describe("normalizeGatewayUrl", () => {
  it("normalizes host casing, default ports, trailing slash, query, and fragment", () => {
    expect(normalizeGatewayUrl("WSS://EXAMPLE.test:443/api/v1/ws/?token=ignored#ignored")).toBe(
      "wss://example.test/api/v1/ws",
    );
  });
});
