import { type AttachmentStorage, consumeAttachmentCleanupIntents } from "../attachments/storage.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { SessionRegistry } from "../session-handlers/session-registry.js";
import type {
  AttachmentManifestRecord,
  AttachmentSessionStore,
  RetentionCandidateCursor,
} from "../store/session-store.js";

export interface HistoryUserCleanupDeps {
  principal: UserPrincipal;
  store: AttachmentSessionStore;
  storage: Pick<AttachmentStorage, "publishCommitted" | "cleanupSession" | "expireStaging">;
  sessionRegistry: Pick<SessionRegistry, "handlesFor">;
  cutoff: number | null;
  batchSize: number;
  finishSessionDeletion(principal: UserPrincipal, sessionId: string): void;
  now?: () => number;
}

export interface HistoryUserCleanupResult {
  reconciled: number;
  reconcileFailed: number;
  deleted: number;
  deleteFailed: number;
  cleanupIntentsFailed: number;
}

/** One authorized user's restart-safe history and attachment maintenance pass. */
export async function cleanupUser(deps: HistoryUserCleanupDeps): Promise<HistoryUserCleanupResult> {
  const result: HistoryUserCleanupResult = {
    reconciled: 0,
    reconcileFailed: 0,
    deleted: 0,
    deleteFailed: 0,
    cleanupIntentsFailed: 0,
  };

  let afterAttachmentId: string | undefined;
  for (;;) {
    const records = deps.store.listCommittedAttachments(deps.batchSize, afterAttachmentId);
    for (const record of records) {
      try {
        await publishCommitted(deps, record);
        result.reconciled++;
      } catch {
        result.reconcileFailed++;
      }
    }
    if (records.length < deps.batchSize) break;
    afterAttachmentId = records.at(-1)?.attachmentId;
  }

  if (deps.cutoff !== null) {
    let cursor: RetentionCandidateCursor | undefined;
    for (;;) {
      const candidates = deps.store.listRetentionCandidates(deps.cutoff, deps.batchSize, cursor);
      for (const candidate of candidates) {
        cursor = candidate;
        try {
          const work = deps.sessionRegistry.handlesFor(candidate.sessionId)?.work;
          if (work?.isTurnInFlight || work?.hasPendingForegroundTool) continue;
          // Final live-work read and cutoff-guarded transaction stay synchronous: no message can
          // enter through this event loop between them.
          const deletion = deps.store.deleteSession(candidate.sessionId, { inactivityCutoff: deps.cutoff });
          if (deletion.status !== "deleted") continue;
          result.deleted++;
          deps.finishSessionDeletion(deps.principal, candidate.sessionId);
        } catch {
          result.deleteFailed++;
        }
      }
      if (candidates.length < deps.batchSize) break;
    }
  }

  // Include intents accepted by this pass; failed early rows must not starve later batches.
  const intents = await consumeAttachmentCleanupIntents(deps.store, deps.storage, deps.batchSize);
  result.cleanupIntentsFailed = intents.failed;

  const now = (deps.now ?? Date.now)();
  while (deps.store.deleteExpiredStagedAttachments(now, deps.batchSize).length === deps.batchSize) {
    // Each transaction removes its bounded batch; newly committed refs are excluded atomically.
  }
  const retained = new Set<string>();
  let afterRetainedId: string | undefined;
  for (;;) {
    const ids = deps.store.listStagingRetentionIds(deps.batchSize, afterRetainedId);
    for (const id of ids) retained.add(id);
    if (ids.length < deps.batchSize) break;
    afterRetainedId = ids.at(-1);
  }
  await deps.storage.expireStaging(retained);

  return result;
}

async function publishCommitted(deps: HistoryUserCleanupDeps, record: AttachmentManifestRecord): Promise<void> {
  if (!record.sessionId || record.entrySeq === null) throw new Error("invalid committed attachment manifest");
  await deps.storage.publishCommitted({ ...record, status: "staged" }, record.sessionId, () => {
    const current = deps.store.findAttachment(record.attachmentId);
    return (
      current !== null &&
      current.status !== "staged" &&
      current.sessionId === record.sessionId &&
      current.entrySeq === record.entrySeq
    );
  });
  if (!deps.store.markAttachmentReady(record.attachmentId, record.sessionId, record.entrySeq))
    throw new Error("committed attachment changed during publication");
}
