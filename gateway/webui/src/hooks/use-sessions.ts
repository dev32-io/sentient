import { type Signal, signal } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import { type SessionsChangeEvent, type SessionsConnector, createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "use-sessions"]);

const CURRENT_SESSION_KEY = "sentient.currentSessionId";
const DEFAULT_NEW_CHAT_TITLE = "New chat";
const LIST_PAGE_LIMIT = 50;
const SEARCH_LIMIT = 20;

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
  readonly searchHits: Signal<SessionRow[] | null>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<string | null>;
  readonly currentId: Signal<string | null>;
  load(): Promise<void>;
  search(q: string): Promise<void>;
  switchTo(id: string): Promise<void>;
  newChat(): Promise<void>;
  delete(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  dispose(): void;
}

export function createUseSessions(connector: SessionsConnector): UseSessions {
  const items = signal<SessionRow[]>([]);
  const searchHits = signal<SessionRow[] | null>(null);
  const loading = signal(false);
  const err = signal<string | null>(null);
  const currentId = signal<string | null>(readStoredSessionId());

  const offChange = connector.onSessionsChanged((e: SessionsChangeEvent) => {
    log.debug("sessions.change", { kind: e.kind, sessionId: "sessionId" in e ? e.sessionId : undefined });
    if (e.kind === "deleted") {
      items.value = items.value.filter((r) => r.sessionId !== e.sessionId);
      if (searchHits.value) {
        searchHits.value = searchHits.value.filter((r) => r.sessionId !== e.sessionId);
      }
      if (currentId.value === e.sessionId) {
        // Chat pane shows messages from a session that no longer exists.
        // Drop the storage pointer and request a fresh chat. The gateway
        // will emit session.created + session.switched + conversation.snapshot,
        // which resets the ConversationHistoryConnector mirror via the
        // existing pipeline.
        if (typeof sessionStorage !== "undefined") {
          try {
            sessionStorage.removeItem(CURRENT_SESSION_KEY);
          } catch {
            // ignore — sessionStorage may be disabled
          }
        }
        currentId.value = null;
        void connector.newChat().catch((err: unknown) => {
          log.warn("post-delete-newchat-failed", { reason: (err as Error).message });
        });
      }
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
      // A draft is not a session: it has no row, so nothing goes into the
      // list. The pointer moves so the composer sends against this draft, and
      // the row appears only when the first message mints the real id.
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
    searchHits,
    loading,
    error: err,
    currentId,
    async load() {
      loading.value = true;
      err.value = null;
      try {
        const { items: rows } = await connector.list({ limit: LIST_PAGE_LIMIT, offset: 0 });
        items.value = rows;
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
        searchHits.value = hits;
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.search.failed", { reason: message });
        err.value = message;
      }
    },
    async switchTo(id) {
      try {
        await connector.switchTo(id);
        currentId.value = id;
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.switch.failed", { sessionId: id, reason: message });
        err.value = message;
      }
    },
    async newChat() {
      try {
        const { draftKey } = await connector.newChat();
        currentId.value = draftKey;
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.new.failed", { reason: message });
        err.value = message;
      }
    },
    async delete(id) {
      try {
        await connector.delete(id);
      } catch (e: unknown) {
        const message = (e as Error).message;
        log.warn("sessions.delete.failed", { sessionId: id, reason: message });
        err.value = message;
      }
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
      offChange();
    },
  };
}
