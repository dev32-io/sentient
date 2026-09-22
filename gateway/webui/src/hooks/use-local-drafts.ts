import { type Signal, useSignal } from "@preact/signals";
import type { AttachmentRef } from "@sentient/protocol";
import {
  type AttachmentsRest,
  AttachmentsRestError,
  type DraftAttachment,
  DraftConflictError,
  type DraftRecord,
  type DraftStore,
  type PendingSendRecord,
  getOrCreateSurfaceId,
} from "@sentient/web-sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/jp2",
  "image/jxl",
]);
const IMAGE_EXTENSIONS = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["avif", "image/avif"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["bmp", "image/bmp"],
  ["jp2", "image/jp2"],
  ["j2k", "image/jp2"],
  ["j2c", "image/jp2"],
  ["jpc", "image/jp2"],
  ["jpf", "image/jp2"],
  ["jpx", "image/jp2"],
  ["jpm", "image/jp2"],
  ["jxl", "image/jxl"],
]);
const RAW_EXTENSIONS = new Set([
  "raw",
  "dng",
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "arw",
  "srf",
  "sr2",
  "raf",
  "rw2",
  "orf",
  "pef",
  "x3f",
]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "py",
  "kt",
  "kts",
  "swift",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "rs",
  "go",
  "sh",
]);

export type AttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "failed" | "cancelled"; readonly message: string }
  | { readonly status: "uploaded"; readonly ref: AttachmentRef };

interface LocalDraftsOptions {
  store: DraftStore;
  attachments: AttachmentsRest;
  drafts?: Signal<readonly DraftRecord[]>;
  currentId: string | null;
  /** Reads route signal before component rerender catches up with session action. */
  getCurrentId?(): string | null;
  connectionReady: boolean;
  isConnectionBoundTo(targetId: string, pendingSurfaceId?: string): boolean;
  recoverPendingRoute(routeId: string, surfaceId: string): void;
  sendText(text: string, pendingId: string, attachmentIds?: readonly string[]): void;
}

function normalizedType(file: File): string | null {
  const lowerName = file.name.toLowerCase();
  const extension = lowerName.split(".").pop() ?? "";
  if (RAW_EXTENSIONS.has(extension)) return null;
  if (lowerName.endsWith(".livephoto.zip")) return "application/vnd.sentient.live-photo+zip";
  const imageType = IMAGE_EXTENSIONS.get(extension);
  if (imageType) return imageType;
  if (IMAGE_TYPES.has(file.type)) return file.type;
  if (file.type === "application/pdf" || extension === "pdf") return "application/pdf";
  if (TEXT_TYPES.has(file.type)) return file.type;
  if (
    TEXT_EXTENSIONS.has(extension) &&
    (!file.type || file.type.startsWith("text/") || file.type === "application/json")
  )
    return "text/plain";
  return null;
}

function uploadError(cause: unknown): string {
  if (cause instanceof AttachmentsRestError) {
    if (cause.code === "quota_exceeded") return "Storage quota reached.";
    if (cause.code === "file_too_large" || cause.code === "request_too_large") return "File is too large.";
    if (cause.code === "unsupported_type") return "File type is not supported.";
  }
  return "Upload failed. Retry when connected.";
}

export function useLocalDrafts(options: LocalDraftsOptions) {
  const store = options.store;
  const ownDrafts = useSignal<readonly DraftRecord[]>([]);
  const drafts = options.drafts ?? ownDrafts;
  const pendingSends = useSignal<readonly PendingSendRecord[]>([]);
  const value = useSignal("");
  const activeAttachments = useSignal<readonly DraftAttachment[]>([]);
  const error = useSignal<string | null>(null);
  const uploadStates = useSignal<Readonly<Record<string, AttachmentUploadState>>>({});
  const activeRef = useRef<DraftRecord | null>(null);
  const currentIdRef = useRef(options.currentId);
  const currentIdSourceRef = useRef(options.getCurrentId);
  const writeRef = useRef(Promise.resolve());
  const sentRef = useRef(new Set<string>());
  const sendingRef = useRef(new Set<string>());
  const uploadsRef = useRef(new Map<string, AbortController>());
  const recoveringRef = useRef(new Set<string>());
  const settledRef = useRef(new Set<string>());
  const surfaceId = useMemo(getOrCreateSurfaceId, []);

  // Keep event handlers on rendered route. Passive effects run after paint and
  // can otherwise save first keystroke for new route over previous draft.
  currentIdRef.current = options.currentId;
  currentIdSourceRef.current = options.getCurrentId;
  const getCurrentId = useCallback(() => currentIdSourceRef.current?.() ?? currentIdRef.current, []);

  const enqueue = useCallback((operation: () => Promise<void>) => {
    writeRef.current = writeRef.current.then(operation, operation);
    return writeRef.current;
  }, []);

  const applySnapshot = useCallback(async () => {
    const snapshot = await store.list();
    drafts.value = snapshot.drafts;
    pendingSends.value = snapshot.pendingSends;
    const currentId = getCurrentId();
    const active = snapshot.drafts.find((draft) => draft.id === currentId || draft.sessionId === currentId) ?? null;
    activeRef.current = active;
    const frozen =
      active &&
      snapshot.pendingSends.some(
        (pending) => pending.draftId === active.id && pending.draftRevision === active.revision,
      );
    value.value = frozen ? "" : (active?.text ?? "");
    activeAttachments.value = frozen ? [] : (active?.attachments ?? []);
    return snapshot;
  }, [store, drafts, pendingSends, value, activeAttachments, getCurrentId]);

  useEffect(() => {
    let cancelled = false;
    void applySnapshot().catch(() => {
      if (!cancelled) error.value = "Drafts could not be restored. Typed text may not survive a reload.";
    });
    return () => {
      cancelled = true;
      for (const controller of uploadsRef.current.values()) controller.abort();
      uploadsRef.current.clear();
      void writeRef.current.finally(() => store.close());
    };
  }, [applySnapshot, error, store]);

  useLayoutEffect(() => {
    const next =
      drafts.peek().find((draft) => draft.id === options.currentId || draft.sessionId === options.currentId) ?? null;
    activeRef.current = next;
    const nextFrozen =
      next &&
      pendingSends.peek().some((pending) => pending.draftId === next.id && pending.draftRevision === next.revision);
    value.value = nextFrozen ? "" : (next?.text ?? "");
    activeAttachments.value = nextFrozen ? [] : (next?.attachments ?? []);
  }, [options.currentId, drafts, pendingSends, value, activeAttachments]);

  const persist = useCallback(
    async (target: string, text: string, attachments: readonly DraftAttachment[]) => {
      const before = await store.list();
      const active = before.drafts.find((draft) => draft.id === target || draft.sessionId === target) ?? null;
      let saved: DraftRecord | null = active;
      if (
        !text &&
        attachments.length === 0 &&
        active &&
        !before.pendingSends.some((pending) => pending.draftId === active.id)
      ) {
        await store.remove(active.id, active.revision);
        saved = null;
      } else if (text || attachments.length > 0) {
        saved = await store.save(
          {
            ...(active ? { id: active.id } : target.startsWith("d_") ? { id: target } : {}),
            sessionId: target.startsWith("d_") ? null : target,
            text,
            attachments,
          },
          active?.revision ?? null,
        );
      }
      const snapshot = await store.list();
      drafts.value = snapshot.drafts;
      pendingSends.value = snapshot.pendingSends;
      if (getCurrentId() === target) {
        activeRef.current = saved;
        activeAttachments.value = saved?.attachments ?? [];
      }
      error.value = null;
    },
    [drafts, error, pendingSends, store, activeAttachments, getCurrentId],
  );

  const save = useCallback(
    (text: string) => {
      const requestedTarget = getCurrentId();
      value.value = text;
      let saved = false;
      const queued = enqueue(async () => {
        const target = requestedTarget ?? getCurrentId();
        if (!target) return;
        try {
          const current = (await store.list()).drafts.find(
            (draft) => draft.id === target || draft.sessionId === target,
          );
          await persist(target, text, current?.attachments ?? []);
          saved = true;
        } catch (cause) {
          if (cause instanceof DraftConflictError) {
            await applySnapshot();
            error.value = "Draft changed in another tab. Your edits were saved as a recovery draft.";
          } else {
            error.value = "Draft could not be saved. Keep this page open and try again.";
          }
        }
      });
      return queued.then(
        () => saved,
        () => false,
      );
    },
    [applySnapshot, enqueue, error, persist, store, value, getCurrentId],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const requestedTarget = getCurrentId();
      void enqueue(async () => {
        const target = requestedTarget ?? getCurrentId();
        if (!target) return;
        try {
          const current = (await store.list()).drafts.find(
            (draft) => draft.id === target || draft.sessionId === target,
          );
          const currentAttachments = current?.attachments ?? [];
          if (currentAttachments.length + files.length > MAX_FILES) {
            error.value = `Attach up to ${MAX_FILES} files.`;
            return;
          }
          const additions: DraftAttachment[] = [];
          for (const file of files) {
            const type = normalizedType(file);
            if (!type) {
              error.value = `${file.name} is not a supported file type.`;
              return;
            }
            if (file.size > MAX_FILE_BYTES) {
              error.value = `${file.name} exceeds 512 MiB.`;
              return;
            }
            additions.push({ id: crypto.randomUUID(), name: file.name, type, blob: file });
          }
          await persist(target, current?.text ?? value.peek(), [...currentAttachments, ...additions]);
        } catch {
          error.value = "Files could not be copied into durable draft storage. Check browser storage quota.";
        }
      });
    },
    [enqueue, error, persist, store, value, getCurrentId],
  );

  const removeFile = useCallback(
    (fileIdentity: string) => {
      const requestedTarget = getCurrentId();
      void enqueue(async () => {
        const target = requestedTarget ?? getCurrentId();
        if (!target) return;
        try {
          const current = (await store.list()).drafts.find(
            (draft) => draft.id === target || draft.sessionId === target,
          );
          const attachments = (current?.attachments ?? []).filter((item) => item.id !== fileIdentity);
          await persist(target, current?.text ?? value.peek(), attachments);
        } catch {
          error.value = "Attachment could not be removed from draft.";
        }
      });
    },
    [enqueue, error, persist, store, value, getCurrentId],
  );

  const sendPending = useCallback(
    async (initial: PendingSendRecord) => {
      const targetId = initial.mintKey;
      if (getCurrentId() !== targetId || !options.isConnectionBoundTo(targetId, initial.surfaceId)) {
        error.value = "Open this message's conversation before retrying.";
        return;
      }
      if (sentRef.current.has(initial.pendingId) || sendingRef.current.has(initial.pendingId)) return;
      sendingRef.current.add(initial.pendingId);
      let pending = initial;
      try {
        for (const file of pending.attachments) {
          if (pending.uploadedRefs[file.id]) continue;
          const key = `${pending.pendingId}:${file.id}`;
          const controller = new AbortController();
          uploadsRef.current.set(key, controller);
          uploadStates.value = { ...uploadStates.peek(), [key]: { status: "uploading", progress: 0 } };
          try {
            const ref = await options.attachments.upload({
              sendAttemptId: pending.pendingId,
              fileIdentity: file.id,
              displayName: file.name,
              contentType: file.type,
              blob: file.blob,
              signal: controller.signal,
              onProgress: (loaded, total) => {
                uploadStates.value = {
                  ...uploadStates.peek(),
                  [key]: { status: "uploading", progress: total ? loaded / total : 0 },
                };
              },
            });
            pending = await store.saveUploadedRef(pending.pendingId, file.id, ref);
            uploadStates.value = { ...uploadStates.peek(), [key]: { status: "uploaded", ref } };
            pendingSends.value = (await store.list()).pendingSends;
          } catch (cause) {
            const cancelled = cause instanceof DOMException && cause.name === "AbortError";
            settledRef.current.add(pending.pendingId);
            uploadStates.value = {
              ...uploadStates.peek(),
              [key]: {
                status: cancelled ? "cancelled" : "failed",
                message: cancelled ? "Upload cancelled." : uploadError(cause),
              },
            };
            return;
          } finally {
            uploadsRef.current.delete(key);
          }
        }
        const attachmentIds = pending.attachments.map((file) => pending.uploadedRefs[file.id]?.attachmentId);
        if (attachmentIds.some((id) => !id)) return;
        if (getCurrentId() !== targetId || !options.isConnectionBoundTo(targetId, initial.surfaceId)) {
          error.value = "Conversation changed before send. Reopen it to retry.";
          return;
        }
        sentRef.current.add(pending.pendingId);
        options.sendText(pending.text, pending.pendingId, attachmentIds as string[]);
      } catch {
        error.value = "Message attachments could not be prepared. Retry send.";
      } finally {
        sendingRef.current.delete(initial.pendingId);
      }
    },
    [
      error,
      options.attachments,
      options.isConnectionBoundTo,
      options.sendText,
      pendingSends,
      store,
      uploadStates,
      getCurrentId,
    ],
  );

  const submit = useCallback(async () => {
    await writeRef.current;
    const active = activeRef.current;
    if (!active || (!active.text.trim() && active.attachments.length === 0)) return;
    try {
      const pending = await store.beginSend(active.id, active.revision, surfaceId);
      pendingSends.value = (await store.list()).pendingSends;
      value.value = "";
      activeAttachments.value = [];
      await sendPending(pending);
    } catch {
      error.value = "Message could not be prepared for reliable send. Try again.";
    }
  }, [error, pendingSends, sendPending, store, surfaceId, value, activeAttachments]);

  const revisePending = useCallback(
    (pendingId: string, removeFileIdentity?: string) =>
      enqueue(async () => {
        const snapshot = await store.list();
        const pending = snapshot.pendingSends.find((item) => item.pendingId === pendingId);
        if (!pending) return;
        const target = pending.sessionId ?? pending.mintKey;
        if (getCurrentId() !== target) {
          error.value = "Open this message's conversation before editing it.";
          return;
        }
        const failed = pending.attachments.some((file) => {
          const state = uploadStates.peek()[`${pending.pendingId}:${file.id}`];
          return state?.status === "failed" || state?.status === "cancelled";
        });
        if (!failed || sentRef.current.has(pendingId)) {
          error.value = "Confirm this message was not sent before editing it.";
          return;
        }
        for (const file of pending.attachments) uploadsRef.current.get(`${pendingId}:${file.id}`)?.abort();
        await Promise.allSettled(
          Object.values(pending.uploadedRefs).map((ref) => options.attachments.delete(ref.attachmentId)),
        );
        await store.reconcileSend(pendingId, "not-committed");
        sentRef.current.delete(pendingId);
        settledRef.current.delete(pendingId);
        const draft = snapshot.drafts.find((item) => item.id === pending.draftId);
        if (draft) {
          const attachments = removeFileIdentity
            ? draft.attachments.filter((file) => file.id !== removeFileIdentity)
            : draft.attachments;
          if (!draft.text && attachments.length === 0) await store.remove(draft.id, draft.revision);
          else await store.save({ ...draft, attachments }, draft.revision);
        }
        uploadStates.value = Object.fromEntries(
          Object.entries(uploadStates.peek()).filter(([key]) => !key.startsWith(`${pendingId}:`)),
        );
        await applySnapshot();
      }).catch(() => {
        error.value = "Message could not be restored for editing.";
      }),
    [applySnapshot, enqueue, error, options.attachments, store, uploadStates, getCurrentId],
  );

  const cancelUpload = useCallback((pendingId: string, fileIdentity: string) => {
    uploadsRef.current.get(`${pendingId}:${fileIdentity}`)?.abort();
  }, []);

  const reconcile = useCallback(
    (acknowledged: ReadonlyMap<string, string>) =>
      enqueue(async () => {
        const snapshot = await store.list();
        let reconciled = false;
        for (const pending of snapshot.pendingSends) {
          const acceptedSessionId = acknowledged.get(pending.pendingId);
          if (!acceptedSessionId || (pending.sessionId !== null && pending.sessionId !== acceptedSessionId)) continue;
          if (pending.sessionId === null) {
            await store.bindPendingSession(pending.pendingId, acceptedSessionId);
            const before = await store.list();
            const current = before.drafts.find((draft) => draft.id === pending.draftId);
            if (current && current.revision > pending.draftRevision && current.sessionId !== acceptedSessionId) {
              try {
                await store.save({ ...current, sessionId: acceptedSessionId }, current.revision);
              } catch (cause) {
                if (!(cause instanceof DraftConflictError)) throw cause;
                const latest = cause.current;
                if (latest?.id === pending.draftId && latest.revision > current.revision) {
                  try {
                    await store.save({ ...latest, sessionId: acceptedSessionId }, latest.revision);
                  } catch (retryCause) {
                    if (!(retryCause instanceof DraftConflictError)) throw retryCause;
                  }
                }
              }
            }
          }
          await store.reconcileSend(pending.pendingId, "acknowledged");
          sentRef.current.delete(pending.pendingId);
          settledRef.current.delete(pending.pendingId);
          reconciled = true;
        }
        if (reconciled) await applySnapshot();
      }).catch(() => {
        error.value = "Acknowledged message could not be reconciled with its local draft.";
      }),
    [applySnapshot, enqueue, error, store],
  );

  const reconcileRejected = useCallback(
    (pendingId: string) =>
      enqueue(async () => {
        // `command.rejected` is the gateway's definitive not-committed answer.
        // Disconnects and post-commit/ambiguous outcomes never enter this path;
        // their sent/settled fences stay in place to prevent duplicate sends.
        const snapshot = await store.list();
        const pending = snapshot.pendingSends.find((item) => item.pendingId === pendingId);
        if (pending !== undefined) await store.reconcileSend(pendingId, "not-committed");
        sendingRef.current.delete(pendingId);
        sentRef.current.delete(pendingId);
        settledRef.current.delete(pendingId);
        uploadStates.value = Object.fromEntries(
          Object.entries(uploadStates.peek()).filter(([key]) => !key.startsWith(`${pendingId}:`)),
        );
        await applySnapshot();
      }).catch(() => {
        error.value = "Refused message could not be restored to its draft.";
      }),
    [applySnapshot, enqueue, error, store, uploadStates],
  );

  useEffect(() => {
    if (!options.connectionReady) {
      // A send is only fenced for one live socket. Reconnect retries same pendingId.
      sentRef.current.clear();
      return;
    }
    if (!options.currentId) return;
    const pending = pendingSends
      .peek()
      .find(
        (item) =>
          item.mintKey === options.currentId &&
          !sentRef.current.has(item.pendingId) &&
          !settledRef.current.has(item.pendingId),
      );
    if (!pending) return;
    if (!options.isConnectionBoundTo(pending.mintKey, pending.surfaceId)) {
      if (!recoveringRef.current.has(pending.pendingId)) {
        recoveringRef.current.add(pending.pendingId);
        options.recoverPendingRoute(pending.mintKey, pending.surfaceId);
      }
      return;
    }
    recoveringRef.current.delete(pending.pendingId);
    void sendPending(pending);
  }, [
    options.connectionReady,
    options.currentId,
    options.isConnectionBoundTo,
    options.recoverPendingRoute,
    pendingSends,
    sendPending,
  ]);

  return {
    store,
    drafts,
    pendingSends,
    value,
    activeAttachments,
    error,
    uploadStates,
    save,
    addFiles,
    removeFile,
    submit,
    retryPending: async (pending: PendingSendRecord) => {
      settledRef.current.delete(pending.pendingId);
      await sendPending(pending);
    },
    revisePending,
    cancelUpload,
    reconcile,
    reconcileRejected,
    flush: async () => {
      await writeRef.current;
    },
    refresh: applySnapshot,
  };
}
