import type { AttachmentRef } from "@sentient/protocol";

const DATABASE_NAME = "sentient-web-drafts";
const DATABASE_VERSION = 1;
const DRAFTS = "drafts";
const PENDING_SENDS = "pendingSends";
const DELETE_INTENTS = "deleteIntents";
const BY_SESSION = "bySession";
const BY_DRAFT = "byDraft";

export interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
}

export interface DraftRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly text: string;
  readonly attachments: readonly DraftAttachment[];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DraftWrite {
  readonly id?: string;
  readonly sessionId: string | null;
  readonly text: string;
  readonly attachments: readonly DraftAttachment[];
}

export interface PendingSendRecord {
  /** Stable client id reused across retries. Gateway dedupe also requires original surfaceId. */
  readonly pendingId: string;
  /** Original gateway route: session id, or unspent server draft mint key. */
  readonly mintKey: string;
  /** Original gateway pending-id namespace. Never replace it with recovering tab's surface. */
  readonly surfaceId: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly sessionId: string | null;
  readonly text: string;
  readonly attachments: readonly DraftAttachment[];
  /** Successfully staged refs, keyed by immutable local file identity. */
  readonly uploadedRefs: Readonly<Record<string, AttachmentRef>>;
  readonly createdAt: number;
}

export interface DeleteIntentRecord {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly failureCode: string | null;
}

export interface DraftStoreSnapshot {
  readonly drafts: DraftRecord[];
  readonly pendingSends: PendingSendRecord[];
  readonly deleteIntents: DeleteIntentRecord[];
}

export interface DraftStoreConfig {
  readonly accountId: string;
  readonly gatewayUrl: string;
  /** Test isolation seam. Consumers should use the default database. */
  readonly databaseName?: string;
  readonly now?: () => number;
}

interface StoredDraft extends DraftRecord {
  readonly scope: string;
  readonly sessionKey?: string;
}

interface StoredPendingSend extends PendingSendRecord {
  readonly scope: string;
}

interface StoredDeleteIntent extends DeleteIntentRecord {
  readonly scope: string;
}

export class DraftConflictError extends Error {
  constructor(
    readonly current: DraftRecord | null,
    readonly recovery: DraftRecord | null = null,
  ) {
    super("draft revision conflict");
    this.name = "DraftConflictError";
  }
}

export class PendingSendConflictError extends Error {
  constructor(readonly pending: PendingSendRecord) {
    super("draft already has a pending send");
    this.name = "PendingSendConflictError";
  }
}

export class ConversationPendingDeleteError extends Error {
  constructor(readonly sessionId: string) {
    super("conversation has a pending delete intent");
    this.name = "ConversationPendingDeleteError";
  }
}

export function normalizeGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("gateway URL must use HTTP or WebSocket protocol");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/** Local draft keys are also gateway mint keys. Keep their wire shape stable. */
export function mintLocalDraftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `d_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const drafts = database.createObjectStore(DRAFTS, { keyPath: ["scope", "id"] });
      drafts.createIndex(BY_SESSION, ["scope", "sessionKey"], { unique: true });
      const pending = database.createObjectStore(PENDING_SENDS, { keyPath: ["scope", "pendingId"] });
      pending.createIndex(BY_DRAFT, ["scope", "draftId"], { unique: true });
      database.createObjectStore(DELETE_INTENTS, { keyPath: ["scope", "sessionId"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
}

function publicDraft({ scope: _scope, sessionKey: _sessionKey, ...draft }: StoredDraft): DraftRecord {
  return draft;
}

function publicPending({ scope: _scope, ...pending }: StoredPendingSend): PendingSendRecord {
  return { ...pending, uploadedRefs: pending.uploadedRefs ?? {} };
}

function publicDeleteIntent({ scope: _scope, ...intent }: StoredDeleteIntent): DeleteIntentRecord {
  return intent;
}

function scopedRange(scope: string): IDBKeyRange {
  return IDBKeyRange.bound([scope], [scope, []]);
}

export interface DraftStore {
  list(): Promise<DraftStoreSnapshot>;
  save(draft: DraftWrite, expectedRevision: number | null): Promise<DraftRecord>;
  remove(draftId: string, expectedRevision: number): Promise<void>;
  beginSend(draftId: string, expectedRevision: number, surfaceId: string): Promise<PendingSendRecord>;
  saveUploadedRef(pendingId: string, fileIdentity: string, ref: AttachmentRef): Promise<PendingSendRecord>;
  bindPendingSession(pendingId: string, sessionId: string): Promise<PendingSendRecord>;
  reconcileSend(pendingId: string, result: "acknowledged" | "not-committed"): Promise<boolean>;
  /** Preserve local edits after another surface removes their remote session. */
  detachSession(sessionId: string): Promise<DraftRecord | null>;
  saveDeleteIntent(sessionId: string, failureCode?: string | null): Promise<DeleteIntentRecord>;
  removeDeleteIntent(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export function createDraftStore(config: DraftStoreConfig): DraftStore {
  if (!config.accountId) throw new TypeError("accountId must not be empty");
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable");

  if (typeof navigator !== "undefined" && navigator.storage?.persist !== undefined) {
    void navigator.storage.persist().catch(() => false);
  }

  const scope = JSON.stringify([config.accountId, normalizeGatewayUrl(config.gatewayUrl)]);
  const now = config.now ?? Date.now;
  const database = openDatabase(config.databaseName ?? DATABASE_NAME);
  void database
    .then((db) => {
      db.onversionchange = () => db.close();
    })
    .catch(() => undefined);

  return {
    async list() {
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS, DELETE_INTENTS]);
      const done = transactionDone(transaction);
      const [drafts, pendingSends, deleteIntents] = await Promise.all([
        requestResult(transaction.objectStore(DRAFTS).getAll(scopedRange(scope))) as Promise<StoredDraft[]>,
        requestResult(transaction.objectStore(PENDING_SENDS).getAll(scopedRange(scope))) as Promise<
          StoredPendingSend[]
        >,
        requestResult(transaction.objectStore(DELETE_INTENTS).getAll(scopedRange(scope))) as Promise<
          StoredDeleteIntent[]
        >,
      ]);
      await done;
      return {
        drafts: drafts.map(publicDraft).sort((a, b) => b.updatedAt - a.updatedAt),
        pendingSends: pendingSends.map(publicPending).sort((a, b) => a.createdAt - b.createdAt),
        deleteIntents: deleteIntents.map(publicDeleteIntent).sort((a, b) => a.createdAt - b.createdAt),
      };
    },

    async save(input, expectedRevision) {
      const db = await database;
      const transaction = db.transaction([DRAFTS, DELETE_INTENTS], "readwrite");
      const done = transactionDone(transaction);
      const drafts = transaction.objectStore(DRAFTS);
      const id = input.id ?? mintLocalDraftId();
      const current = (await requestResult(drafts.get([scope, id]))) as StoredDraft | undefined;
      if ((current?.revision ?? null) !== expectedRevision) {
        const timestamp = now();
        const recovery: StoredDraft = {
          scope,
          id: mintLocalDraftId(),
          sessionId: null,
          text: input.text,
          attachments: input.attachments,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        drafts.put(recovery);
        await done;
        throw new DraftConflictError(current === undefined ? null : publicDraft(current), publicDraft(recovery));
      }
      if (input.sessionId !== null) {
        const deleting = await requestResult(transaction.objectStore(DELETE_INTENTS).get([scope, input.sessionId]));
        if (deleting !== undefined) {
          transaction.abort();
          await done.catch(() => undefined);
          throw new ConversationPendingDeleteError(input.sessionId);
        }
        const other = (await requestResult(drafts.index(BY_SESSION).get([scope, input.sessionId]))) as
          | StoredDraft
          | undefined;
        if (other !== undefined && other.id !== id) {
          const timestamp = now();
          const recovery: StoredDraft = {
            scope,
            id: mintLocalDraftId(),
            sessionId: null,
            text: input.text,
            attachments: input.attachments,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          drafts.put(recovery);
          await done;
          throw new DraftConflictError(publicDraft(other), publicDraft(recovery));
        }
      }
      const timestamp = now();
      const stored: StoredDraft = {
        scope,
        id,
        sessionId: input.sessionId,
        ...(input.sessionId === null ? {} : { sessionKey: input.sessionId }),
        text: input.text,
        attachments: input.attachments,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      drafts.put(stored);
      await done;
      return publicDraft(stored);
    },

    async remove(draftId, expectedRevision) {
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS], "readwrite");
      const done = transactionDone(transaction);
      const drafts = transaction.objectStore(DRAFTS);
      const current = (await requestResult(drafts.get([scope, draftId]))) as StoredDraft | undefined;
      if (current === undefined || current.revision !== expectedRevision) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DraftConflictError(current === undefined ? null : publicDraft(current));
      }
      const pending = (await requestResult(
        transaction.objectStore(PENDING_SENDS).index(BY_DRAFT).get([scope, draftId]),
      )) as StoredPendingSend | undefined;
      if (pending !== undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new PendingSendConflictError(publicPending(pending));
      }
      drafts.delete([scope, draftId]);
      await done;
    },

    async beginSend(draftId, expectedRevision, surfaceId) {
      if (!surfaceId) throw new TypeError("surfaceId must not be empty");
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS], "readwrite");
      const done = transactionDone(transaction);
      const drafts = transaction.objectStore(DRAFTS);
      const draft = (await requestResult(drafts.get([scope, draftId]))) as StoredDraft | undefined;
      if (draft === undefined || draft.revision !== expectedRevision) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DraftConflictError(draft === undefined ? null : publicDraft(draft));
      }
      const pendingStore = transaction.objectStore(PENDING_SENDS);
      const current = (await requestResult(pendingStore.index(BY_DRAFT).get([scope, draftId]))) as
        | StoredPendingSend
        | undefined;
      if (current !== undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        if (current.draftRevision === expectedRevision) return publicPending(current);
        throw new PendingSendConflictError(publicPending(current));
      }
      const pending: StoredPendingSend = {
        scope,
        pendingId: crypto.randomUUID(),
        mintKey: draft.sessionId ?? draft.id,
        surfaceId,
        draftId,
        draftRevision: draft.revision,
        sessionId: draft.sessionId,
        text: draft.text,
        attachments: draft.attachments,
        uploadedRefs: {},
        createdAt: now(),
      };
      pendingStore.put(pending);
      await done;
      return publicPending(pending);
    },

    async saveUploadedRef(pendingId, fileIdentity, ref) {
      const db = await database;
      const transaction = db.transaction(PENDING_SENDS, "readwrite");
      const done = transactionDone(transaction);
      const pendingStore = transaction.objectStore(PENDING_SENDS);
      const current = (await requestResult(pendingStore.get([scope, pendingId]))) as StoredPendingSend | undefined;
      if (current === undefined || !current.attachments.some((attachment) => attachment.id === fileIdentity)) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new Error("pending attachment not found");
      }
      const updated: StoredPendingSend = {
        ...current,
        uploadedRefs: { ...current.uploadedRefs, [fileIdentity]: ref },
      };
      pendingStore.put(updated);
      await done;
      return publicPending(updated);
    },

    async bindPendingSession(pendingId, sessionId) {
      if (!sessionId) throw new TypeError("sessionId must not be empty");
      const db = await database;
      const transaction = db.transaction(PENDING_SENDS, "readwrite");
      const done = transactionDone(transaction);
      const pendingStore = transaction.objectStore(PENDING_SENDS);
      const current = (await requestResult(pendingStore.get([scope, pendingId]))) as StoredPendingSend | undefined;
      if (current === undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new Error("pending send not found");
      }
      const updated: StoredPendingSend = { ...current, sessionId };
      pendingStore.put(updated);
      await done;
      return publicPending(updated);
    },

    async reconcileSend(pendingId, result) {
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS], "readwrite");
      const done = transactionDone(transaction);
      const pendingStore = transaction.objectStore(PENDING_SENDS);
      const pending = (await requestResult(pendingStore.get([scope, pendingId]))) as StoredPendingSend | undefined;
      if (pending === undefined) {
        await done;
        return false;
      }
      if (result === "acknowledged") {
        const drafts = transaction.objectStore(DRAFTS);
        const draft = (await requestResult(drafts.get([scope, pending.draftId]))) as StoredDraft | undefined;
        if (draft?.revision === pending.draftRevision) drafts.delete([scope, pending.draftId]);
      }
      pendingStore.delete([scope, pendingId]);
      await done;
      return true;
    },

    async detachSession(sessionId) {
      if (!sessionId) throw new TypeError("sessionId must not be empty");
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS], "readwrite");
      const done = transactionDone(transaction);
      const drafts = transaction.objectStore(DRAFTS);
      const current = (await requestResult(drafts.index(BY_SESSION).get([scope, sessionId]))) as
        | StoredDraft
        | undefined;
      if (current === undefined) {
        await done;
        return null;
      }
      const pendingStore = transaction.objectStore(PENDING_SENDS);
      const pending = (await requestResult(pendingStore.index(BY_DRAFT).get([scope, current.id]))) as
        | StoredPendingSend
        | undefined;
      if (pending !== undefined) pendingStore.delete([scope, pending.pendingId]);
      drafts.delete([scope, current.id]);
      const { sessionKey: _sessionKey, ...local } = current;
      const detached: StoredDraft = {
        ...local,
        id: mintLocalDraftId(),
        sessionId: null,
        revision: 1,
        updatedAt: now(),
      };
      drafts.put(detached);
      await done;
      return publicDraft(detached);
    },

    async saveDeleteIntent(sessionId, failureCode = null) {
      if (!sessionId) throw new TypeError("sessionId must not be empty");
      const db = await database;
      const transaction = db.transaction([DRAFTS, PENDING_SENDS, DELETE_INTENTS], "readwrite");
      const done = transactionDone(transaction);
      const intents = transaction.objectStore(DELETE_INTENTS);
      const current = (await requestResult(intents.get([scope, sessionId]))) as StoredDeleteIntent | undefined;
      const timestamp = now();
      const intent: StoredDeleteIntent = {
        scope,
        sessionId,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        failureCode,
      };
      intents.put(intent);
      const drafts = transaction.objectStore(DRAFTS);
      const draft = (await requestResult(drafts.index(BY_SESSION).get([scope, sessionId]))) as StoredDraft | undefined;
      if (draft !== undefined) {
        const pendingStore = transaction.objectStore(PENDING_SENDS);
        const pending = (await requestResult(pendingStore.index(BY_DRAFT).get([scope, draft.id]))) as
          | StoredPendingSend
          | undefined;
        if (pending !== undefined) pendingStore.delete([scope, pending.pendingId]);
        drafts.delete([scope, draft.id]);
      }
      await done;
      return publicDeleteIntent(intent);
    },

    async removeDeleteIntent(sessionId) {
      const db = await database;
      const transaction = db.transaction(DELETE_INTENTS, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(DELETE_INTENTS).delete([scope, sessionId]);
      await done;
    },

    async close() {
      (await database).close();
    },
  };
}
