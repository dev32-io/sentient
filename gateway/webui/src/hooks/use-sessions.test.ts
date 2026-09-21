import {
  type DraftRecord,
  type DraftStore,
  type DraftStoreSnapshot,
  type SessionsChangeEvent,
  type SessionsConnector,
  SessionsRestError,
} from "@sentient/web-sdk";
import { describe, expect, it, vi } from "vitest";
import { createUseSessions } from "./use-sessions.ts";

describe("session loading", () => {
  it("preserves populated rows during refresh and after a refresh failure", async () => {
    const row = {
      sessionId: "session-1",
      rootId: "session-1",
      title: "Saved chat",
      startedAt: 1,
      lastActiveAt: 1,
      messageCount: 1,
      isActive: false,
    };
    let rejectRefresh!: (error: Error) => void;
    const connector = {
      onSessionsChanged: vi.fn(() => vi.fn()),
      list: vi
        .fn()
        .mockResolvedValueOnce({ items: [row] })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectRefresh = reject;
            }),
        ),
    };
    const sessions = createUseSessions(connector as unknown as SessionsConnector);

    await sessions.load();
    const refresh = sessions.load();
    expect(sessions.loading.value).toBe(true);
    expect(sessions.items.value).toEqual([row]);
    expect(sessions.error.value).toBeNull();

    rejectRefresh(new Error("offline"));
    await refresh;
    expect(sessions.loading.value).toBe(false);
    expect(sessions.items.value).toEqual([row]);
    expect(sessions.error.value).toBe("offline");
    sessions.dispose();
  });
});

describe("persistent optimistic deletion", () => {
  it("retries transient deletion without waiting for another online event", async () => {
    vi.useFakeTimers();
    const store = {
      saveDeleteIntent: vi.fn(async () => ({}) as never),
      removeDeleteIntent: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ drafts: [], pendingSends: [], deleteIntents: [] })),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn(() => vi.fn()),
      delete: vi
        .fn()
        .mockRejectedValueOnce(new SessionsRestError(503, "unavailable", "unavailable"))
        .mockResolvedValue(undefined),
    };
    const sessions = createUseSessions(connector as unknown as SessionsConnector, { draftStore: store });

    await sessions.delete("session-1");
    expect(connector.delete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(connector.delete).toHaveBeenCalledTimes(2);
    expect(store.removeDeleteIntent).toHaveBeenCalledWith("session-1");
    sessions.dispose();
    vi.useRealTimers();
  });

  it("persists intent before hiding and keeps it for offline retry", async () => {
    const calls: string[] = [];
    const store = {
      saveDeleteIntent: vi.fn(async () => {
        calls.push("persist");
        return {} as never;
      }),
      removeDeleteIntent: vi.fn(),
      list: vi.fn(async () => ({
        drafts: [],
        pendingSends: [],
        deleteIntents: [{ sessionId: "session-1", createdAt: 1, updatedAt: 1, failureCode: null }],
      })),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn(() => vi.fn()),
      delete: vi.fn(async () => {
        calls.push("request");
        throw new Error("offline");
      }),
      newChat: vi.fn().mockResolvedValue({ draftKey: "d_next" }),
    };
    const sessions = createUseSessions(connector as unknown as SessionsConnector, { draftStore: store });
    sessions.items.value = [
      {
        sessionId: "session-1",
        rootId: "session-1",
        title: "Synthetic",
        startedAt: 1,
        lastActiveAt: 1,
        messageCount: 1,
        isActive: true,
      },
    ];
    sessions.currentId.value = "session-1";

    await sessions.delete("session-1");

    expect(calls[0]).toBe("persist");
    expect(sessions.items.value).toEqual([]);
    expect(sessions.currentId.value).toBeNull();
    expect(connector.newChat).toHaveBeenCalledOnce();
    expect(store.removeDeleteIntent).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("stops automatic retry on permanent failure and exposes explicit recovery", async () => {
    let intent = { sessionId: "session-1", createdAt: 1, updatedAt: 1, failureCode: null as string | null };
    const store = {
      saveDeleteIntent: vi.fn(async (_id: string, failureCode: string | null = null) => {
        intent = { ...intent, failureCode };
        return intent;
      }),
      removeDeleteIntent: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ drafts: [], pendingSends: [], deleteIntents: [intent] })),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn(() => vi.fn()),
      delete: vi
        .fn()
        .mockRejectedValueOnce(new SessionsRestError(403, "forbidden", "forbidden"))
        .mockResolvedValue(undefined),
      newChat: vi.fn().mockResolvedValue({ draftKey: "d_next" }),
    };
    const sessions = createUseSessions(connector as unknown as SessionsConnector, { draftStore: store });

    await sessions.delete("session-1");
    await vi.waitFor(() => expect(sessions.deleteFailureCount.value).toBe(1));
    expect(connector.delete).toHaveBeenCalledOnce();

    await sessions.retryFailedDeletes();
    await vi.waitFor(() => expect(connector.delete).toHaveBeenCalledTimes(2));
    expect(store.removeDeleteIntent).toHaveBeenCalledWith("session-1");
    sessions.dispose();
  });
});

describe("remote session deletion", () => {
  it("detaches local edits and cancels pending send before routing recovery draft", async () => {
    let change!: (event: { kind: "deleted"; sessionId: string }) => void;
    const detached = {
      id: "d_recovery",
      sessionId: null,
      text: "unsent",
      attachments: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const store = {
      detachSession: vi.fn().mockResolvedValue(detached),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn((listener) => {
        change = listener;
        return vi.fn();
      }),
      newChat: vi.fn(),
    };
    const onOpenNewDraft = vi.fn();
    const onDraftsChanged = vi.fn();
    const sessions = createUseSessions(connector as unknown as SessionsConnector, {
      draftStore: store,
      onOpenNewDraft,
      onDraftsChanged,
    });
    sessions.currentId.value = "session-1";

    change({ kind: "deleted", sessionId: "session-1" });

    await vi.waitFor(() => expect(sessions.currentId.value).toBe("d_recovery"));
    expect(store.detachSession).toHaveBeenCalledWith("session-1");
    expect(onDraftsChanged).toHaveBeenCalledOnce();
    expect(onOpenNewDraft).toHaveBeenCalledWith("d_recovery");
    expect(connector.newChat).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("prefers detached recovery over the gateway draft handshake after deletion", async () => {
    let change!: (event: SessionsChangeEvent) => void;
    let releaseDetach!: (draft: DraftRecord) => void;
    const detached: DraftRecord = {
      id: "d_recovery",
      sessionId: null,
      text: "unsent",
      attachments: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const store = {
      detachSession: vi.fn(
        () =>
          new Promise<DraftRecord>((resolve) => {
            releaseDetach = resolve;
          }),
      ),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn((listener) => {
        change = listener;
        return vi.fn();
      }),
      newChat: vi.fn(),
    };
    const onOpenNewDraft = vi.fn();
    const sessions = createUseSessions(connector as unknown as SessionsConnector, {
      draftStore: store,
      onOpenNewDraft,
    });
    sessions.currentId.value = "session-1";

    change({ kind: "deleted", sessionId: "session-1", deletionId: "session-1" });
    change({ kind: "draft", draftKey: "d_gateway", ts: 1, deletionId: "session-1" });
    releaseDetach(detached);

    await vi.waitFor(() => expect(sessions.currentId.value).toBe("d_recovery"));
    expect(onOpenNewDraft).toHaveBeenCalledWith("d_recovery");
    expect(onOpenNewDraft).not.toHaveBeenCalledWith("d_gateway");
    sessions.dispose();
  });

  it("recovers refused reload edits and fences its pending send", async () => {
    const sessionId = "session-refused";
    const detached: DraftRecord = {
      id: "d_recovery",
      sessionId: null,
      text: "pending text",
      attachments: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const pending = {
      pendingId: "pending-1",
      mintKey: sessionId,
      surfaceId: "surface-a",
      draftId: "draft-1",
      draftRevision: 1,
      sessionId,
      text: "pending text",
      attachments: [],
      uploadedRefs: {},
      createdAt: 1,
    };
    let snapshot: DraftStoreSnapshot = {
      drafts: [{ ...detached, id: "draft-1", sessionId }],
      pendingSends: [pending],
      deleteIntents: [],
    };
    let change!: (event: SessionsChangeEvent) => void;
    const store = {
      list: vi.fn(async () => snapshot),
      detachSession: vi.fn(async (id: string) => {
        expect(id).toBe(sessionId);
        snapshot = { drafts: [detached], pendingSends: [], deleteIntents: [] };
        return detached;
      }),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn((listener) => {
        change = listener;
        return vi.fn();
      }),
      newChat: vi.fn(),
    };
    const onOpenNewDraft = vi.fn();
    const sessions = createUseSessions(connector as unknown as SessionsConnector, {
      draftStore: store,
      onOpenNewDraft,
      onDraftsChanged: async () => {
        expect((await store.list()).pendingSends).toEqual([]);
      },
    });
    sessions.currentId.value = sessionId;

    change({ kind: "unavailable", sessionId, deletionId: sessionId });
    change({ kind: "draft", draftKey: "d_gateway", ts: 1, deletionId: sessionId });

    await vi.waitFor(() => expect(sessions.currentId.value).toBe(detached.id));
    expect(store.detachSession).toHaveBeenCalledWith(sessionId);
    expect((await store.list()).pendingSends).toEqual([]);
    expect(onOpenNewDraft).toHaveBeenCalledWith(detached.id);
    expect(connector.newChat).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("keeps recovery selected when detach finishes before deletion handshake", async () => {
    let change!: (event: SessionsChangeEvent) => void;
    const detached: DraftRecord = {
      id: "d_recovery",
      sessionId: null,
      text: "unsent",
      attachments: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const store = {
      detachSession: vi.fn().mockResolvedValue(detached),
    } as unknown as DraftStore;
    const connector = {
      onSessionsChanged: vi.fn((listener) => {
        change = listener;
        return vi.fn();
      }),
      newChat: vi.fn(),
    };
    const onOpenNewDraft = vi.fn();
    const sessions = createUseSessions(connector as unknown as SessionsConnector, {
      draftStore: store,
      onOpenNewDraft,
    });
    sessions.currentId.value = "session-1";

    change({ kind: "deleted", sessionId: "session-1", deletionId: "session-1" });
    await vi.waitFor(() => expect(sessions.currentId.value).toBe(detached.id));
    change({ kind: "draft", draftKey: "d_gateway", ts: 1, deletionId: "session-1" });

    expect(sessions.currentId.value).toBe(detached.id);
    expect(onOpenNewDraft).toHaveBeenCalledTimes(1);
    expect(onOpenNewDraft).toHaveBeenCalledWith(detached.id);

    // No deletion identity means legitimate New Chat remains routable.
    change({ kind: "draft", draftKey: "d_new-chat", ts: 2 });
    expect(sessions.currentId.value).toBe("d_new-chat");
    sessions.dispose();
  });
});

describe("session action outcomes", () => {
  it("opens a fresh local draft offline after queued edits flush", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const connector = { onSessionsChanged: vi.fn(() => vi.fn()), newChat: vi.fn() };
    const order: string[] = [];
    const onOpenNewDraft = vi.fn(() => order.push("route"));
    const sessions = createUseSessions(connector as unknown as SessionsConnector, {
      onBeforeNewDraft: async () => {
        order.push("flush");
      },
      onOpenNewDraft,
    });

    expect(await sessions.newChat()).toBe(true);
    expect(sessions.currentId.value).toMatch(/^d_[0-9a-f]{32}$/);
    expect(onOpenNewDraft).toHaveBeenCalledWith(sessions.currentId.value);
    expect(order).toEqual(["flush", "route"]);
    expect(connector.newChat).not.toHaveBeenCalled();
    sessions.dispose();
    online.mockRestore();
  });

  it("keeps an existing local draft when online New chat returns the same gateway key", async () => {
    const connector = {
      onSessionsChanged: vi.fn(() => vi.fn()),
      newChat: vi.fn().mockResolvedValue({ draftKey: "d_existing" }),
    };
    const onOpenNewDraft = vi.fn();
    const sessions = createUseSessions(connector as unknown as SessionsConnector, { onOpenNewDraft });
    sessions.currentId.value = "d_existing";

    expect(await sessions.newChat()).toBe(true);
    expect(sessions.currentId.value).toMatch(/^d_[0-9a-f]{32}$/);
    expect(sessions.currentId.value).not.toBe("d_existing");
    expect(onOpenNewDraft).toHaveBeenCalledWith(sessions.currentId.value);
    sessionStorage.removeItem("sentient.currentSessionId");
    sessions.dispose();
  });

  it.each(["switchTo", "newChat"] as const)(
    "%s reports failure without changing the pointer, then succeeds on retry",
    async (action) => {
      const connector = {
        onSessionsChanged: vi.fn(() => vi.fn()),
        switchTo: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(undefined),
        newChat: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ draftKey: "draft-2" }),
      };
      const sessions = createUseSessions(connector as unknown as SessionsConnector);
      sessions.currentId.value = "session-1";
      const run = () => (action === "switchTo" ? sessions.switchTo("session-2") : sessions.newChat());

      expect(await run()).toBe(false);
      expect(sessions.currentId.value).toBe("session-1");
      expect(sessions.error.value).toBe("unavailable");
      expect(await run()).toBe(true);
      expect(sessions.error.value).toBeNull();
      expect(sessions.currentId.value).toBe(action === "switchTo" ? "session-2" : "draft-2");
      if (action === "newChat") {
        expect(sessionStorage.getItem("sentient.currentSessionId")).toBe("draft-2");
        sessionStorage.removeItem("sentient.currentSessionId");
      }
      expect(sessions.items.value).toEqual([]);
      sessions.dispose();
    },
  );
});
