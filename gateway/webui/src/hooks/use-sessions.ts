import { type Signal, signal } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import {
  type DraftRecord,
  type DraftStore,
  type SessionsChangeEvent,
  type SessionsConnector,
  SessionsRestError,
  createLogger,
  mintLocalDraftId,
  setCurrentSessionId,
} from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "use-sessions"]);

const CURRENT_SESSION_KEY = "sentient.currentSessionId";
const DEFAULT_NEW_CHAT_TITLE = "New chat";
const LIST_PAGE_LIMIT = 50;
const SEARCH_LIMIT = 20;
const DELETE_RETRY_DELAYS_MS = [500, 2_000, 8_000] as const;

function readStoredSessionId(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return sessionStorage.getItem(CURRENT_SESSION_KEY);
  } catch {
    return null;
  }
}

export interface UseSessions {
  readonly items: Signal<SessionRow[]>;
  readonly drafts: Signal<readonly DraftRecord[]>;
  readonly searchHits: Signal<SessionRow[] | null>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<string | null>;
  readonly deleteFailureCount: Signal<number>;
  readonly currentId: Signal<string | null>;
  load(): Promise<void>;
  search(q: string): Promise<void>;
  switchTo(id: string): Promise<boolean>;
  openDraft(id: string): Promise<boolean>;
  newChat(): Promise<boolean>;
  delete(id: string): Promise<void>;
  retryFailedDeletes(): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  dispose(): void;
}

export interface UseSessionsConfig {
  readonly draftStore?: DraftStore;
  readonly drafts?: Signal<readonly DraftRecord[]>;
  readonly onOpenNewDraft?: (draftKey: string) => void;
  readonly onBeforeNewDraft?: () => void | Promise<void>;
  readonly onDraftsChanged?: () => void | Promise<void>;
}

interface DeletionRecovery {
  readonly deletionId?: string;
  gatewayDraftKey: string | null;
  detached: DraftRecord | null | undefined;
  routedId: string | null;
}

export function createUseSessions(connector: SessionsConnector, config: UseSessionsConfig = {}): UseSessions {
  const items = signal<SessionRow[]>([]);
  const drafts = config.drafts ?? signal<readonly DraftRecord[]>([]);
  const searchHits = signal<SessionRow[] | null>(null);
  const loading = signal(false);
  const err = signal<string | null>(null);
  const deleteFailureCount = signal(0);
  const currentId = signal<string | null>(readStoredSessionId());
  const deleting = new Set<string>();
  const deleteRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const currentDeletionDrafts = new Map<string, DeletionRecovery>();
  const detachingSessions = new Set<string>();
  let disposed = false;

  const retryDelete = async (sessionId: string, attempt = 0): Promise<void> => {
    if (disposed || !config.draftStore || deleting.has(sessionId)) return;
    const timer = deleteRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    deleteRetryTimers.delete(sessionId);
    deleting.add(sessionId);
    try {
      await connector.delete(sessionId);
      await config.draftStore.removeDeleteIntent(sessionId);
    } catch (cause) {
      const transient =
        !(cause instanceof SessionsRestError) ||
        cause.status === 0 ||
        cause.status === 408 ||
        cause.status === 429 ||
        cause.status >= 500;
      if (transient && attempt < DELETE_RETRY_DELAYS_MS.length) {
        deleteRetryTimers.set(
          sessionId,
          setTimeout(() => void retryDelete(sessionId, attempt + 1), DELETE_RETRY_DELAYS_MS[attempt]),
        );
      } else {
        const failureCode = cause instanceof SessionsRestError ? cause.code : "network-error";
        await config.draftStore.saveDeleteIntent(sessionId, failureCode);
        deleteFailureCount.value += 1;
        err.value = "Conversation could not be deleted. It remains hidden until you retry.";
      }
    } finally {
      deleting.delete(sessionId);
    }
  };

  const filterPendingDeletes = async (rows: SessionRow[]): Promise<SessionRow[]> => {
    if (!config.draftStore) return rows;
    const snapshot = await config.draftStore.list();
    const hidden = new Set(snapshot.deleteIntents.map((intent) => intent.sessionId));
    deleteFailureCount.value = snapshot.deleteIntents.filter((intent) => intent.failureCode !== null).length;
    for (const intent of snapshot.deleteIntents) if (intent.failureCode === null) void retryDelete(intent.sessionId);
    return rows.filter((row) => !hidden.has(row.sessionId));
  };

  const onOnline = () => {
    if (!config.draftStore) return;
    void config.draftStore
      .list()
      .then((snapshot) => {
        for (const intent of snapshot.deleteIntents)
          if (intent.failureCode === null) void retryDelete(intent.sessionId);
      })
      .catch(() => {
        err.value = "Pending deletions could not be restored from local storage.";
      });
  };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  const offChange = connector.onSessionsChanged((e: SessionsChangeEvent) => {
    log.debug("sessions.change", { kind: e.kind, sessionId: "sessionId" in e ? e.sessionId : undefined });
    if (e.kind === "deleted" || e.kind === "unavailable") {
      items.value = items.value.filter((r) => r.sessionId !== e.sessionId);
      if (searchHits.value) searchHits.value = searchHits.value.filter((r) => r.sessionId !== e.sessionId);
      if (detachingSessions.has(e.sessionId)) return;
      const wasCurrent = currentId.value === e.sessionId;
      const existing = currentDeletionDrafts.get(e.sessionId);
      if (wasCurrent && existing?.detached !== undefined) return;
      const recovery: DeletionRecovery = existing ?? {
        ...(e.deletionId !== undefined ? { deletionId: e.deletionId } : {}),
        gatewayDraftKey: null,
        detached: undefined,
        routedId: null,
      };
      if (wasCurrent && existing === undefined) currentDeletionDrafts.set(e.sessionId, recovery);
      detachingSessions.add(e.sessionId);
      void (async () => {
        try {
          recovery.detached = (await config.draftStore?.detachSession(e.sessionId)) ?? null;
          await config.onDraftsChanged?.();
          const gatewayDraftKey = recovery.gatewayDraftKey;
          if (!wasCurrent || (currentId.value !== e.sessionId && currentId.value !== gatewayDraftKey)) return;
          try {
            sessionStorage.removeItem(CURRENT_SESSION_KEY);
          } catch {
            /* storage disabled */
          }
          if (recovery.detached) {
            recovery.routedId = recovery.detached.id;
            setCurrentSessionId(recovery.detached.id);
            currentId.value = recovery.detached.id;
            config.onOpenNewDraft?.(recovery.detached.id);
            return;
          }
          currentId.value = null;
          void connector.newChat().catch((cause: unknown) => {
            log.warn("post-delete-newchat-failed", { reason: (cause as Error).message });
          });
        } catch {
          err.value = "Local edits could not be recovered after conversation deletion.";
        } finally {
          detachingSessions.delete(e.sessionId);
          if (recovery.deletionId === undefined) currentDeletionDrafts.delete(e.sessionId);
        }
      })();
      return;
    }
    if (e.kind === "renamed") {
      items.value = items.value.map((r) => (r.sessionId === e.sessionId ? { ...r, title: e.title } : r));
      if (searchHits.value) {
        searchHits.value = searchHits.value.map((r) => (r.sessionId === e.sessionId ? { ...r, title: e.title } : r));
      }
      return;
    }
    if (e.kind === "switched") {
      currentId.value = e.sessionId;
      return;
    }
    if (e.kind === "draft") {
      // Only a draft carrying this exact deletion identity belongs to the
      // deleted-session handshake. Ordinary New Chat has no deletionId and
      // must remain free to replace a completed recovery route.
      const recovery =
        e.deletionId === undefined
          ? undefined
          : [...currentDeletionDrafts.values()].find((item) => item.deletionId === e.deletionId);
      if (recovery) {
        recovery.gatewayDraftKey = e.draftKey;
        if (recovery.routedId !== null && currentId.value === recovery.routedId) {
          setCurrentSessionId(recovery.routedId);
        }
        return;
      }
      // A draft is not a session: it has no row, so nothing goes into the
      // list. Anchor accepted key here too: connector lifecycle can advance
      // after startup pointer handling, and reload must follow UI route.
      setCurrentSessionId(e.draftKey);
      currentId.value = e.draftKey;
      return;
    }
    // created
    currentId.value = e.sessionId;
    const next: SessionRow = {
      sessionId: e.sessionId,
      rootId: e.sessionId,
      title: e.title ?? DEFAULT_NEW_CHAT_TITLE,
      startedAt: e.ts,
      lastActiveAt: e.ts,
      messageCount: 0,
      isActive: true,
    };
    items.value = [next, ...items.value.filter((r) => r.sessionId !== e.sessionId)];
  });

  return {
    items,
    drafts,
    searchHits,
    loading,
    error: err,
    deleteFailureCount,
    currentId,
    async load() {
      loading.value = true;
      err.value = null;
      try {
        const { items: rows } = await connector.list({ limit: LIST_PAGE_LIMIT, offset: 0 });
        items.value = await filterPendingDeletes(rows);
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.load.failed", { reason: message });
        err.value = message;
      } finally {
        loading.value = false;
      }
    },
    async search(q) {
      if (!q.trim()) {
        searchHits.value = null;
        return;
      }
      try {
        const hits = await connector.search(q, SEARCH_LIMIT);
        searchHits.value = await filterPendingDeletes(hits);
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.search.failed", { reason: message });
        err.value = message;
      }
    },
    async switchTo(id) {
      err.value = null;
      try {
        await connector.switchTo(id);
        currentId.value = id;
        return true;
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.switch.failed", { sessionId: id, reason: message });
        err.value = message;
        return false;
      }
    },
    async openDraft(id) {
      const draft = drafts.peek().find((item) => item.id === id);
      if (!draft) return false;
      if (draft.sessionId !== null) {
        try {
          await connector.switchTo(draft.sessionId);
          currentId.value = draft.sessionId;
          return true;
        } catch (e: unknown) {
          err.value = (e as Error).message;
          return false;
        }
      }
      currentId.value = draft.id;
      config.onOpenNewDraft?.(draft.id);
      return true;
    },
    async newChat() {
      err.value = null;
      try {
        await config.onBeforeNewDraft?.();
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          const draftKey = mintLocalDraftId();
          currentId.value = draftKey;
          config.onOpenNewDraft?.(draftKey);
          return true;
        }
        const previousId = currentId.peek();
        const answer = await connector.newChat();
        const draftKey = answer.draftKey === previousId ? mintLocalDraftId() : answer.draftKey;
        setCurrentSessionId(draftKey);
        currentId.value = draftKey;
        if (draftKey !== answer.draftKey) config.onOpenNewDraft?.(draftKey);
        return true;
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.new.failed", { reason: message });
        err.value = message;
        return false;
      }
    },
    async delete(id) {
      if (!config.draftStore) {
        try {
          await connector.delete(id);
        } catch (e: unknown) {
          const message = (e as Error).message;
          log.warn("sessions.delete.failed", { sessionId: id, reason: message });
          err.value = message;
        }
        return;
      }
      try {
        await config.draftStore.saveDeleteIntent(id);
      } catch {
        err.value = "Conversation could not be queued for deletion because local storage is unavailable.";
        return;
      }
      items.value = items.value.filter((row) => row.sessionId !== id);
      if (searchHits.value) searchHits.value = searchHits.value.filter((row) => row.sessionId !== id);
      await config.onDraftsChanged?.();
      if (currentId.value === id) {
        try {
          sessionStorage.removeItem(CURRENT_SESSION_KEY);
        } catch {
          /* storage disabled */
        }
        currentId.value = null;
        void connector.newChat().catch(() => undefined);
      }
      void retryDelete(id);
    },
    async retryFailedDeletes() {
      const draftStore = config.draftStore;
      if (!draftStore) return;
      const snapshot = await draftStore.list();
      const failed = snapshot.deleteIntents.filter((intent) => intent.failureCode !== null);
      deleteFailureCount.value = 0;
      await Promise.all(failed.map((intent) => draftStore.saveDeleteIntent(intent.sessionId, null)));
      for (const intent of failed) void retryDelete(intent.sessionId);
    },
    async rename(id, title) {
      try {
        await connector.rename(id, title);
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.rename.failed", { sessionId: id, reason: message });
        err.value = message;
      }
    },
    dispose() {
      disposed = true;
      for (const timer of deleteRetryTimers.values()) clearTimeout(timer);
      deleteRetryTimers.clear();
      offChange();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    },
  };
}
