// SessionStore (spec §3) — the single source of truth for conversation state.
//
// History is append-only during normal operation. Explicit lifecycle deletion
// is transactional and leaves a permanent tombstone, preserving the stronger
// invariant that late writers can never resurrect removed history.
//
// Opened through a Capability, so the DB path is confined to its owner's home
// directory. One file per user (spec §2.5, §2.6).
//
// CLOSED IS A NAMED STATE. `close()` finalizes every prepared statement, after
// which bun:sqlite answers any further call with a bare "Statement has
// finalized" — a message that names neither the store, the session, nor the
// caller that outlived the handle. Since the one owner (runtime/
// session-runtime.ts) closes on socket teardown while a turn may still be
// settling, that message is the exact one an operator would be reading. So the
// closed state is tracked here and reported as the invariant violation it is:
// still a throw (a use-after-close is a caller bug, never a recoverable
// condition to swallow), but one that says what failed and who owns it.

import { SQLiteError } from "bun:sqlite";
import type { AttachmentRef } from "@sentient/protocol";
import type { Capability } from "../access/capability.js";
import type { AttachmentStorage, StagedAttachment } from "../attachments/storage.js";
import { getLog } from "../logging/logger.js";
import type { NewSessionEntry, SessionEntry } from "./entry-types.js";
import {
  type ScheduledSessionExecution,
  type ScheduledSessionOutcome,
  type SessionMetadata,
  type TitleProvenance,
  createSessionMetadataOps,
} from "./session-metadata.js";
import { DEFAULT_USER_DB_FILENAME, openConfiguredUserDatabase } from "./user-database.js";

// Re-exported so a consumer of the public `SessionStore` surface (task 3:
// resolve a mint-key conflict to the existing session) can `catch` and
// `instanceof`-check it without reaching past this module into the internal
// session-metadata.js submodule.
export { DeletedSessionError, MintKeyConflictError } from "./session-metadata.js";
import { DeletedSessionError, MintKeyConflictError } from "./session-metadata.js";

const log = getLog(["sentient", "store", "session-store"]);

interface AttachmentRow {
  attachment_id: string;
  send_attempt_id: string;
  file_identity: string;
  display_name: string;
  content_type: string;
  media_kind: "image" | "pdf" | "text";
  byte_size: number;
  sha256: string;
  staged_at: number;
  expires_at: number;
  status: "staged" | "committed" | "ready";
  session_id: string | null;
  entry_seq: number | null;
  entry_ordinal: number | null;
}

interface EntryRow {
  seq: number;
  session_id: string;
  turn_id: string;
  reply_id: string | null;
  kind: string;
  created_at: number;
  text: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_args: string | null;
  cutoff: string | null;
  compacted_through_seq: number | null;
  pending_id: string | null;
}

function boundedLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 0), 1000) : 0;
}

function toAttachmentRef(row: AttachmentRow): AttachmentRef {
  return {
    attachmentId: row.attachment_id,
    displayName: row.display_name,
    contentType: row.content_type,
    mediaKind: row.media_kind,
    size: row.byte_size,
  };
}

export interface AttachmentManifestRecord extends AttachmentRef {
  ownerUserId: string;
  sendAttemptId: string;
  fileIdentity: string;
  sha256: string;
  stagedAt: number;
  expiresAt: number;
  status: AttachmentRow["status"];
  sessionId: string | null;
  entrySeq: number | null;
}

export class AttachmentAdmissionError extends Error {
  constructor(
    readonly code: "attachment_count" | "attachment_not_found" | "attachment_not_staged" | "attachment_conflict",
  ) {
    super(code);
    this.name = "AttachmentAdmissionError";
  }
}

function toEntry(row: EntryRow, attachments: readonly AttachmentRef[] = []): SessionEntry {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    replyId: row.reply_id,
    kind: row.kind as SessionEntry["kind"],
    createdAt: row.created_at,
    text: row.text,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    cutoff: row.cutoff as SessionEntry["cutoff"],
    compactedThroughSeq: row.compacted_through_seq,
    pendingId: row.pending_id,
    attachments,
  };
}

export type SessionDeletionResult =
  | { status: "deleted"; alreadyDeleted: boolean; deletedAt: number }
  | { status: "absent" }
  | { status: "active"; lastActivityAt: number };

export interface SessionFileCleanupIntent {
  sessionId: string;
  requestedAt: number;
}

export interface RetentionCandidate {
  sessionId: string;
  lastActivityAt: number;
}

export type RetentionCandidateCursor = RetentionCandidate;

export interface UserMessageAdmission {
  entry: SessionEntry;
  attachments: AttachmentManifestRecord[];
}

export interface SessionStore {
  /** Append an entry. Returns it with the store-assigned seq. */
  append(entry: NewSessionEntry): SessionEntry;
  readSession(sessionId: string): SessionEntry[];
  readSince(sessionId: string, afterSeq: number): SessionEntry[];
  /** The entry this session already committed for [pendingId], or null. This
   *  is the idempotency record for a client resend — durable rather than a
   *  process-lifetime set, so it survives reconnect, restart and redeploy. */
  findByPendingId(sessionId: string, pendingId: string): SessionEntry | null;
  listSessions(): Array<{ sessionId: string; startedAt: number; lastAt: number }>;
  /** Throws `MintKeyConflictError` (session-metadata.js) when `mintKey` already
   *  names a session — the `UNIQUE` constraint on `mint_key` is what makes
   *  minting idempotent, not a read-then-write check. */
  createSession(sessionId: string, mintKey: string): SessionMetadata;
  findSessionByMintKey(mintKey: string): SessionMetadata | null;
  getSession(sessionId: string): SessionMetadata | null;
  /** Newest-updated first. */
  listSessionsWithMetadata(): SessionMetadata[];
  /** Compare-and-set title write. `false` when `expectedVersion` is stale or a
   *  `generated` title would overwrite a `user` one. */
  setTitle(sessionId: string, title: string, provenance: TitleProvenance, expectedVersion: number): boolean;
  setScheduledProvenance?(
    sessionId: string,
    scheduleId: string,
    occurrenceId: string,
    intendedAt: string,
    actualAt: string,
  ): boolean;
  setScheduledTurn?(sessionId: string, occurrenceId: string, turnId: string): boolean;
  recordScheduledTerminal?(
    sessionId: string,
    turnId: string,
    outcome: ScheduledSessionOutcome,
    completedAt: string,
    entryId: string | null,
  ): ScheduledSessionExecution | null;
  findScheduledByOccurrence?(occurrenceId: string): SessionMetadata | null;
  /** Atomically rechecks optional inactivity cutoff, fences writers, removes raw history, and queues file cleanup. */
  deleteSession(sessionId: string, options?: { inactivityCutoff?: number }): SessionDeletionResult;
  listRetentionCandidates(
    inactivityCutoff: number,
    limit: number,
    after?: RetentionCandidateCursor,
  ): RetentionCandidate[];
  listFileCleanupIntents(limit: number, afterSessionId?: string): SessionFileCleanupIntent[];
  ackFileCleanupIntent(sessionId: string): boolean;
  /** Release the handle. Idempotent. Every other method throws afterwards —
   *  see this file's header. */
  close(): void;
}

export interface AttachmentSessionStore extends SessionStore {
  /** Persist one completed upload. Idempotent for one send-attempt/file identity. */
  registerStagedAttachment(ref: StagedAttachment, expiresAt: number): AttachmentManifestRecord;
  findAttachment(attachmentId: string): AttachmentManifestRecord | null;
  findAttachmentByAttempt(sendAttemptId: string, fileIdentity: string): AttachmentManifestRecord | null;
  /** Atomically append a user message, bind staged refs, and optionally create its first-session metadata. */
  admitUserMessage(
    entry: NewSessionEntry,
    attachmentIds: readonly string[],
    options: { maxAttachments: number; createSession?: { mintKey: string } },
  ): UserMessageAdmission;
  markAttachmentReady(attachmentId: string, sessionId: string, entrySeq: number): boolean;
  listCommittedAttachments(limit: number, afterAttachmentId?: string): AttachmentManifestRecord[];
  /** IDs whose physical staging files still back live manifest rows. */
  listStagingRetentionIds(limit: number, afterAttachmentId?: string): string[];
  /** Atomically unclaims expired, still-uncommitted manifests before filesystem expiry. */
  deleteExpiredStagedAttachments(expiresBefore: number, limit: number): AttachmentManifestRecord[];
  deleteStagedAttachment(attachmentId: string): boolean;
}

/** Publish files only after their manifest+entry transaction committed. Call before exposing committed feed. */
export async function publishAdmittedAttachments(
  store: AttachmentSessionStore,
  storage: Pick<AttachmentStorage, "publishCommitted">,
  admission: UserMessageAdmission,
): Promise<void> {
  for (const record of admission.attachments) {
    if (!record.sessionId || record.entrySeq === null) throw new AttachmentAdmissionError("attachment_conflict");
    await storage.publishCommitted({ ...record, status: "staged" }, record.sessionId, () => {
      const current = store.findAttachment(record.attachmentId);
      return (
        current?.sessionId === record.sessionId &&
        current.entrySeq === record.entrySeq &&
        (current.status === "committed" || current.status === "ready")
      );
    });
    if (!store.markAttachmentReady(record.attachmentId, record.sessionId, record.entrySeq))
      throw new AttachmentAdmissionError("attachment_conflict");
  }
}

/** Startup repair for crashes between durable manifest commit, file publication, and ready marking. */
export async function reconcileCommittedAttachments(
  store: AttachmentSessionStore,
  storage: Pick<AttachmentStorage, "publishCommitted">,
  limit: number,
): Promise<{ ready: number; failed: number }> {
  let ready = 0;
  let failed = 0;
  for (const record of store.listCommittedAttachments(limit)) {
    try {
      if (!record.sessionId || record.entrySeq === null) throw new AttachmentAdmissionError("attachment_conflict");
      await storage.publishCommitted({ ...record, status: "staged" }, record.sessionId, () => {
        const current = store.findAttachment(record.attachmentId);
        return (
          current?.sessionId === record.sessionId &&
          current.entrySeq === record.entrySeq &&
          (current.status === "committed" || current.status === "ready")
        );
      });
      if (!store.markAttachmentReady(record.attachmentId, record.sessionId, record.entrySeq))
        throw new AttachmentAdmissionError("attachment_conflict");
      ready++;
    } catch {
      failed++;
    }
  }
  return { ready, failed };
}

export function openSessionStore(
  cap: Capability,
  dbFileName: string = DEFAULT_USER_DB_FILENAME,
): AttachmentSessionStore {
  // Checked BEFORE the path check, deliberately: a wrong-class capability and
  // an escaping path are different faults and must say so. Without this, a
  // `file-scope` capability for the same user has an IDENTICAL rootPath, so
  // `capabilityCoversPath` below passes and the store opens under a grant
  // that was never meant to authorize it — the confused-deputy hole this
  // check closes (spec §3.2).
  if (cap.resource !== "session-store") {
    log.warn("store.resource-class-mismatch", {
      userId: cap.ownerUserId,
      resource: cap.resource,
      reason: "capability was not minted for the session-store resource class",
    });
    throw new Error(`capability resource class mismatch: expected "session-store", got "${cap.resource}"`);
  }

  const { db, schemaVersion } = openConfiguredUserDatabase(cap, dbFileName);
  log.info("store.opened", { userId: cap.ownerUserId, schemaVersion });

  const insert = db.query<
    EntryRow,
    [
      string,
      string,
      string | null,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
      string,
    ]
  >(`
    INSERT INTO entries
      (session_id, turn_id, reply_id, kind, created_at, text, tool_call_id, tool_name, tool_args, cutoff, compacted_through_seq, pending_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id = ?)
    RETURNING *
  `);

  const selectSession = db.query<EntryRow, [string]>("SELECT * FROM entries WHERE session_id = ? ORDER BY seq ASC");
  const selectSince = db.query<EntryRow, [string, number]>(
    "SELECT * FROM entries WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
  );
  const selectByPendingId = db.query<EntryRow, [string, string]>(
    "SELECT * FROM entries WHERE session_id = ? AND pending_id = ? ORDER BY seq ASC LIMIT 1",
  );
  const selectEntryAttachments = db.query<AttachmentRow, [number]>(
    "SELECT * FROM attachments WHERE entry_seq = ? ORDER BY entry_ordinal, attachment_id",
  );
  const selectAttachment = db.query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE attachment_id = ?");
  const selectAttachmentByAttempt = db.query<AttachmentRow, [string, string]>(
    "SELECT * FROM attachments WHERE send_attempt_id = ? AND file_identity = ?",
  );
  const insertAttachment = db.query<
    AttachmentRow,
    [string, string, string, string, string, string, number, string, number, number]
  >(`
    INSERT INTO attachments
      (attachment_id,send_attempt_id,file_identity,display_name,content_type,media_kind,byte_size,sha256,staged_at,expires_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'staged') RETURNING *
  `);
  const bindAttachment = db.query<AttachmentRow, [string, number, number, string]>(`
    UPDATE attachments SET status='committed',session_id=?,entry_seq=?,entry_ordinal=?
    WHERE attachment_id=? AND status='staged' RETURNING *
  `);
  const markAttachmentReady = db.query<AttachmentRow, [string, string, number]>(`
    UPDATE attachments SET status='ready'
    WHERE attachment_id=? AND session_id=? AND entry_seq=? AND status IN ('committed','ready') RETURNING *
  `);
  const selectCommittedAttachments = db.query<AttachmentRow, [number]>(
    "SELECT * FROM attachments WHERE status='committed' ORDER BY attachment_id LIMIT ?",
  );
  const selectCommittedAttachmentsAfter = db.query<AttachmentRow, [string, number]>(
    "SELECT * FROM attachments WHERE status='committed' AND attachment_id>? ORDER BY attachment_id LIMIT ?",
  );
  const selectStagingRetentionIds = db.query<{ attachment_id: string }, [number]>(`
    SELECT attachment_id FROM attachments
    WHERE status IN ('staged','committed') ORDER BY attachment_id LIMIT ?
  `);
  const selectStagingRetentionIdsAfter = db.query<{ attachment_id: string }, [string, number]>(`
    SELECT attachment_id FROM attachments
    WHERE status IN ('staged','committed') AND attachment_id>? ORDER BY attachment_id LIMIT ?
  `);
  const deleteExpiredStagedAttachments = db.query<AttachmentRow, [number, number]>(`
    DELETE FROM attachments WHERE attachment_id IN (
      SELECT attachment_id FROM attachments
      WHERE status='staged' AND expires_at<? ORDER BY expires_at,attachment_id LIMIT ?
    ) AND status='staged' RETURNING *
  `);
  const deleteStagedAttachment = db.query("DELETE FROM attachments WHERE attachment_id=? AND status='staged'");
  const insertSessionForAdmission = db.query<unknown, [string, string, number, number, string, string]>(`
    INSERT INTO sessions (session_id,mint_key,created_at,updated_at,title,title_provenance,version)
    SELECT ?,?,?,?,NULL,NULL,1
    WHERE NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id=? OR mint_key=?)
  `);
  const selectSessions = db.query<{ session_id: string; started_at: number; last_at: number }, []>(`
    SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS last_at
    FROM entries GROUP BY session_id ORDER BY last_at DESC
  `);
  const metadata = createSessionMetadataOps(db, cap.ownerUserId);
  const advanceActivity = db.query(`
    UPDATE sessions
    SET last_activity_at = CASE
      WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END
    WHERE session_id = ?
  `);
  const selectDeletion = db.query<
    { mint_key: string | null; last_activity_at: number | null; exists_flag: number },
    [string, string, string, string]
  >(`
    SELECT s.mint_key,
      COALESCE(s.last_activity_at,
        (SELECT MAX(created_at) FROM entries WHERE session_id = ? AND kind IN ('user','assistant')),
        s.created_at,
        (SELECT MAX(created_at) FROM entries WHERE session_id = ?)) AS last_activity_at,
      1 AS exists_flag
    FROM sessions s WHERE s.session_id = ?
    UNION ALL
    SELECT NULL, COALESCE(MAX(CASE WHEN e.kind IN ('user','assistant') THEN e.created_at END), MAX(e.created_at)), 1
    FROM entries e LEFT JOIN sessions s ON s.session_id=e.session_id
    WHERE e.session_id = ? AND s.session_id IS NULL HAVING COUNT(*) > 0
    LIMIT 1
  `);
  const selectTombstone = db.query<{ deleted_at: number }, [string]>(
    "SELECT deleted_at FROM deleted_sessions WHERE session_id = ?",
  );
  const insertTombstone = db.query("INSERT INTO deleted_sessions(session_id,mint_key,deleted_at) VALUES (?,?,?)");
  const insertCleanupIntent = db.query(
    "INSERT OR IGNORE INTO session_file_cleanup_intents(session_id,requested_at) VALUES (?,?)",
  );
  const deleteCards = db.query("DELETE FROM notification_cards WHERE session_id = ?");
  const deleteOutbox = db.query("DELETE FROM content_outbox WHERE session_id = ?");
  const clearOccurrences = db.query(`
    UPDATE occurrences
    SET session_id=NULL, claim_token=NULL, claimed_until=NULL, entry_id=NULL,
      outcome=COALESCE(outcome,'interrupted'), completed_at=COALESCE(completed_at,?)
    WHERE session_id=?
  `);
  const deleteEntries = db.query("DELETE FROM entries WHERE session_id = ?");
  const deleteMetadata = db.query("DELETE FROM sessions WHERE session_id = ?");
  const retentionActivity = `
    WITH activity AS (
      SELECT s.session_id,
        COALESCE(s.last_activity_at,
          (SELECT MAX(created_at) FROM entries e WHERE e.session_id=s.session_id AND e.kind IN ('user','assistant')),
          s.created_at) AS last_activity_at
      FROM sessions s
      UNION ALL
      SELECT e.session_id,
        COALESCE(MAX(CASE WHEN e.kind IN ('user','assistant') THEN e.created_at END), MAX(e.created_at))
      FROM entries e
      LEFT JOIN sessions s ON s.session_id=e.session_id
      LEFT JOIN deleted_sessions d ON d.session_id=e.session_id
      WHERE s.session_id IS NULL AND d.session_id IS NULL
      GROUP BY e.session_id
    )`;
  const retentionCandidates = db.query<{ session_id: string; last_activity_at: number }, [number, number]>(`
    ${retentionActivity}
    SELECT session_id,last_activity_at FROM activity
    WHERE last_activity_at < ? ORDER BY last_activity_at,session_id LIMIT ?
  `);
  const retentionCandidatesAfter = db.query<
    { session_id: string; last_activity_at: number },
    [number, number, number, string, number]
  >(`
    ${retentionActivity}
    SELECT session_id,last_activity_at FROM activity
    WHERE last_activity_at < ? AND (last_activity_at>? OR (last_activity_at=? AND session_id>?))
    ORDER BY last_activity_at,session_id LIMIT ?
  `);
  const cleanupIntents = db.query<{ session_id: string; requested_at: number }, [string, number]>(
    "SELECT session_id,requested_at FROM session_file_cleanup_intents WHERE session_id > ? ORDER BY session_id LIMIT ?",
  );
  const deleteCleanupIntent = db.query("DELETE FROM session_file_cleanup_intents WHERE session_id = ?");

  function manifest(row: AttachmentRow): AttachmentManifestRecord {
    return {
      ...toAttachmentRef(row),
      ownerUserId: cap.ownerUserId,
      sendAttemptId: row.send_attempt_id,
      fileIdentity: row.file_identity,
      sha256: row.sha256,
      stagedAt: row.staged_at,
      expiresAt: row.expires_at,
      status: row.status,
      sessionId: row.session_id,
      entrySeq: row.entry_seq,
    };
  }

  function entryWithAttachments(row: EntryRow): SessionEntry {
    return toEntry(row, selectEntryAttachments.all(row.seq).map(toAttachmentRef));
  }

  const appendTransaction = db.transaction((entry: NewSessionEntry): EntryRow => {
    const row = insert.get(
      entry.sessionId,
      entry.turnId,
      entry.replyId,
      entry.kind,
      entry.createdAt,
      entry.text,
      entry.toolCallId,
      entry.toolName,
      entry.toolArgs,
      entry.cutoff,
      entry.compactedThroughSeq,
      entry.pendingId,
      entry.sessionId,
    );
    if (!row) throw new DeletedSessionError(entry.sessionId);
    if (entry.kind === "user" || entry.kind === "assistant")
      advanceActivity.run(entry.createdAt, entry.createdAt, entry.sessionId);
    return row;
  });

  const admitTransaction = db.transaction(
    (
      entry: NewSessionEntry,
      attachmentIds: readonly string[],
      maxAttachments: number,
      mintKey: string | undefined,
    ): { row: EntryRow; attachments: AttachmentRow[] } => {
      if (entry.kind !== "user") throw new AttachmentAdmissionError("attachment_conflict");
      if (!Number.isSafeInteger(maxAttachments) || maxAttachments < 0 || attachmentIds.length > maxAttachments)
        throw new AttachmentAdmissionError("attachment_count");
      if (new Set(attachmentIds).size !== attachmentIds.length)
        throw new AttachmentAdmissionError("attachment_conflict");

      const duplicate = entry.pendingId === null ? null : selectByPendingId.get(entry.sessionId, entry.pendingId);
      if (duplicate) {
        const bound = selectEntryAttachments.all(duplicate.seq);
        if (
          duplicate.text !== entry.text ||
          bound.map((row) => row.attachment_id).join("\0") !== attachmentIds.join("\0")
        )
          throw new AttachmentAdmissionError("attachment_conflict");
        return { row: duplicate, attachments: bound };
      }

      if (mintKey !== undefined) {
        const now = Date.now();
        try {
          const created = insertSessionForAdmission.run(entry.sessionId, mintKey, now, now, entry.sessionId, mintKey);
          if (created.changes !== 1) throw new DeletedSessionError(entry.sessionId);
        } catch (error) {
          if (error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_UNIQUE")
            throw new MintKeyConflictError(mintKey);
          throw error;
        }
      }

      const rows = attachmentIds.map((id) => {
        const row = selectAttachment.get(id);
        if (!row) throw new AttachmentAdmissionError("attachment_not_found");
        if (row.status !== "staged") throw new AttachmentAdmissionError("attachment_not_staged");
        return row;
      });
      const appended = insert.get(
        entry.sessionId,
        entry.turnId,
        entry.replyId,
        entry.kind,
        entry.createdAt,
        entry.text,
        entry.toolCallId,
        entry.toolName,
        entry.toolArgs,
        entry.cutoff,
        entry.compactedThroughSeq,
        entry.pendingId,
        entry.sessionId,
      );
      if (!appended) throw new DeletedSessionError(entry.sessionId);
      advanceActivity.run(entry.createdAt, entry.createdAt, entry.sessionId);
      const bound = rows.map((row, ordinal) => {
        const updated = bindAttachment.get(entry.sessionId, appended.seq, ordinal, row.attachment_id);
        if (!updated) throw new AttachmentAdmissionError("attachment_not_staged");
        return updated;
      });
      return { row: appended, attachments: bound };
    },
  );

  const deleteTransaction = db.transaction(
    (sessionId: string, inactivityCutoff: number | undefined): SessionDeletionResult => {
      const tombstone = selectTombstone.get(sessionId);
      if (tombstone) return { status: "deleted", alreadyDeleted: true, deletedAt: tombstone.deleted_at };
      const row = selectDeletion.get(sessionId, sessionId, sessionId, sessionId);
      if (!row) return { status: "absent" };
      if (inactivityCutoff !== undefined && row.last_activity_at !== null && row.last_activity_at >= inactivityCutoff)
        return { status: "active", lastActivityAt: row.last_activity_at };

      const deletedAt = Date.now();
      insertTombstone.run(sessionId, row.mint_key, deletedAt);
      insertCleanupIntent.run(sessionId, deletedAt);
      deleteCards.run(sessionId);
      deleteOutbox.run(sessionId);
      clearOccurrences.run(new Date(deletedAt).toISOString(), sessionId);
      deleteEntries.run(sessionId);
      deleteMetadata.run(sessionId);
      return { status: "deleted", alreadyDeleted: false, deletedAt };
    },
  );

  let closed = false;

  function assertOpen(op: string): void {
    if (!closed) return;
    throw new Error(
      `session store used after close: ${op} on the handle for user ${cap.ownerUserId} — its owner (SessionRuntime) was disposed; the caller outlived it`,
    );
  }

  return {
    append(entry) {
      assertOpen("append");
      const row = appendTransaction(entry);
      log.debug("entry.appended", {
        userId: cap.ownerUserId,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        kind: entry.kind,
        seq: row.seq,
      });
      return entryWithAttachments(row);
    },
    registerStagedAttachment(ref, expiresAt) {
      assertOpen("registerStagedAttachment");
      if (ref.ownerUserId !== cap.ownerUserId) throw new AttachmentAdmissionError("attachment_not_found");
      const existing = selectAttachmentByAttempt.get(ref.sendAttemptId, ref.fileIdentity);
      if (existing) {
        if (
          existing.attachment_id !== ref.attachmentId ||
          existing.sha256 !== ref.sha256 ||
          existing.byte_size !== ref.size
        )
          throw new AttachmentAdmissionError("attachment_conflict");
        return manifest(existing);
      }
      try {
        return manifest(
          insertAttachment.get(
            ref.attachmentId,
            ref.sendAttemptId,
            ref.fileIdentity,
            ref.displayName,
            ref.contentType,
            ref.mediaKind,
            ref.size,
            ref.sha256,
            ref.stagedAt,
            expiresAt,
          ) as AttachmentRow,
        );
      } catch (error) {
        if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_CONSTRAINT"))
          throw new AttachmentAdmissionError("attachment_conflict");
        throw error;
      }
    },
    findAttachment(attachmentId) {
      assertOpen("findAttachment");
      const row = selectAttachment.get(attachmentId);
      return row ? manifest(row) : null;
    },
    findAttachmentByAttempt(sendAttemptId, fileIdentity) {
      assertOpen("findAttachmentByAttempt");
      const row = selectAttachmentByAttempt.get(sendAttemptId, fileIdentity);
      return row ? manifest(row) : null;
    },
    admitUserMessage(entry, attachmentIds, options) {
      assertOpen("admitUserMessage");
      const admitted = admitTransaction.immediate(
        entry,
        attachmentIds,
        options.maxAttachments,
        options.createSession?.mintKey,
      );
      return {
        entry: toEntry(admitted.row, admitted.attachments.map(toAttachmentRef)),
        attachments: admitted.attachments.map(manifest),
      };
    },
    markAttachmentReady(attachmentId, sessionId, entrySeq) {
      assertOpen("markAttachmentReady");
      return markAttachmentReady.get(attachmentId, sessionId, entrySeq) !== null;
    },
    listCommittedAttachments(limit, afterAttachmentId) {
      assertOpen("listCommittedAttachments");
      const bounded = boundedLimit(limit);
      return (
        afterAttachmentId === undefined
          ? selectCommittedAttachments.all(bounded)
          : selectCommittedAttachmentsAfter.all(afterAttachmentId, bounded)
      ).map(manifest);
    },
    listStagingRetentionIds(limit, afterAttachmentId) {
      assertOpen("listStagingRetentionIds");
      const bounded = boundedLimit(limit);
      return (
        afterAttachmentId === undefined
          ? selectStagingRetentionIds.all(bounded)
          : selectStagingRetentionIdsAfter.all(afterAttachmentId, bounded)
      ).map((row) => row.attachment_id);
    },
    deleteExpiredStagedAttachments(expiresBefore, limit) {
      assertOpen("deleteExpiredStagedAttachments");
      return deleteExpiredStagedAttachments.all(expiresBefore, boundedLimit(limit)).map(manifest);
    },
    deleteStagedAttachment(attachmentId) {
      assertOpen("deleteStagedAttachment");
      return deleteStagedAttachment.run(attachmentId).changes === 1;
    },
    readSession(sessionId) {
      assertOpen("readSession");
      return selectSession.all(sessionId).map(entryWithAttachments);
    },
    readSince(sessionId, afterSeq) {
      assertOpen("readSince");
      return selectSince.all(sessionId, afterSeq).map(entryWithAttachments);
    },
    findByPendingId(sessionId, pendingId) {
      assertOpen("findByPendingId");
      const row = selectByPendingId.get(sessionId, pendingId);
      return row ? entryWithAttachments(row) : null;
    },
    listSessions() {
      assertOpen("listSessions");
      return selectSessions.all().map((r) => ({
        sessionId: r.session_id,
        startedAt: r.started_at,
        lastAt: r.last_at,
      }));
    },
    createSession(sessionId, mintKey) {
      assertOpen("createSession");
      return metadata.createSession(sessionId, mintKey);
    },
    findSessionByMintKey(mintKey) {
      assertOpen("findSessionByMintKey");
      return metadata.findSessionByMintKey(mintKey);
    },
    getSession(sessionId) {
      assertOpen("getSession");
      return metadata.getSession(sessionId);
    },
    listSessionsWithMetadata() {
      assertOpen("listSessionsWithMetadata");
      return metadata.listSessionsWithMetadata();
    },
    setTitle(sessionId, title, provenance, expectedVersion) {
      assertOpen("setTitle");
      return metadata.setTitle(sessionId, title, provenance, expectedVersion);
    },
    setScheduledProvenance(sessionId, scheduleId, occurrenceId, intendedAt, actualAt) {
      assertOpen("setScheduledProvenance");
      return metadata.setScheduledProvenance(sessionId, scheduleId, occurrenceId, intendedAt, actualAt);
    },
    setScheduledTurn(sessionId, occurrenceId, turnId) {
      assertOpen("setScheduledTurn");
      return metadata.setScheduledTurn(sessionId, occurrenceId, turnId);
    },
    recordScheduledTerminal(sessionId, turnId, outcome, completedAt, entryId) {
      assertOpen("recordScheduledTerminal");
      return metadata.recordScheduledTerminal(sessionId, turnId, outcome, completedAt, entryId);
    },
    findScheduledByOccurrence(occurrenceId) {
      assertOpen("findScheduledByOccurrence");
      return metadata.findScheduledByOccurrence(occurrenceId);
    },
    deleteSession(sessionId, options) {
      assertOpen("deleteSession");
      const result = deleteTransaction.immediate(sessionId, options?.inactivityCutoff);
      log.info("session.delete", { userId: cap.ownerUserId, status: result.status });
      return result;
    },
    listRetentionCandidates(inactivityCutoff, limit, after) {
      assertOpen("listRetentionCandidates");
      const bounded = boundedLimit(limit);
      const rows = after
        ? retentionCandidatesAfter.all(
            inactivityCutoff,
            after.lastActivityAt,
            after.lastActivityAt,
            after.sessionId,
            bounded,
          )
        : retentionCandidates.all(inactivityCutoff, bounded);
      return rows.map((row) => ({ sessionId: row.session_id, lastActivityAt: row.last_activity_at }));
    },
    listFileCleanupIntents(limit, afterSessionId = "") {
      assertOpen("listFileCleanupIntents");
      return cleanupIntents.all(afterSessionId, boundedLimit(limit)).map((row) => ({
        sessionId: row.session_id,
        requestedAt: row.requested_at,
      }));
    },
    ackFileCleanupIntent(sessionId) {
      assertOpen("ackFileCleanupIntent");
      return deleteCleanupIntent.run(sessionId).changes === 1;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
      log.info("store.closed", { userId: cap.ownerUserId });
    },
  };
}
