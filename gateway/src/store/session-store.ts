// SessionStore (spec §3) — the single source of truth for conversation state.
//
// Append-only by construction: the returned object exposes append + read and
// NOTHING else. There is no update or delete method to call, which is how
// Invariant A (immutable history → byte-stable cache prefix) is enforced.
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

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Capability, capabilityCoversPath } from "../access/capability.js";
import { getLog } from "../logging/logger.js";
import type { NewSessionEntry, SessionEntry } from "./entry-types.js";
import { migrateStore } from "./migrate-store.js";
import { STORE_DDL } from "./schema.js";
import { type SessionMetadata, type TitleProvenance, createSessionMetadataOps } from "./session-metadata.js";

const log = getLog(["sentient", "store", "session-store"]);

// Mirrors gateway/config.yaml#store.db_filename. The composition root does not
// exist yet, so nothing reads that key: `store` is absent from gatewayConfigSchema
// and zod's non-strict parsing drops it, leaving cfg.store undefined. When the
// runtime composition root lands it must add the schema section and thread the
// value here, retiring this constant.
const DB_FILENAME = "sessions.db";

interface EntryRow {
  seq: number;
  session_id: string;
  turn_id: string;
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

function toEntry(row: EntryRow): SessionEntry {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    kind: row.kind as SessionEntry["kind"],
    createdAt: row.created_at,
    text: row.text,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    cutoff: row.cutoff as SessionEntry["cutoff"],
    compactedThroughSeq: row.compacted_through_seq,
    pendingId: row.pending_id,
  };
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
  /** Release the handle. Idempotent. Every other method throws afterwards —
   *  see this file's header. */
  close(): void;
}

export function openSessionStore(cap: Capability): SessionStore {
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

  const dbPath = path.join(cap.rootPath, DB_FILENAME);
  if (!capabilityCoversPath(cap, dbPath)) {
    throw new Error(`store path escapes capability scope: ${dbPath}`);
  }

  // The owner's home dir may not exist yet — a session for a freshly-created
  // user, or any deploy path that did not pre-provision the dir. Create it
  // inside the capability's own scoped root (checked above) BEFORE SQLite
  // opens the file: `new Database(create:true)` creates the DB file but never
  // its parent dir, failing with "unable to open database file". Mirrors
  // FileScope, which already mkdir's dirname on write.
  mkdirSync(cap.rootPath, { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec(STORE_DDL);
  const schemaVersion = migrateStore(db, cap.ownerUserId);
  log.info("store.opened", { userId: cap.ownerUserId, schemaVersion });

  const insert = db.query<
    EntryRow,
    [
      string,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
    ]
  >(`
    INSERT INTO entries
      (session_id, turn_id, kind, created_at, text, tool_call_id, tool_name, tool_args, cutoff, compacted_through_seq, pending_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const selectSession = db.query<EntryRow, [string]>("SELECT * FROM entries WHERE session_id = ? ORDER BY seq ASC");
  const selectSince = db.query<EntryRow, [string, number]>(
    "SELECT * FROM entries WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
  );
  const selectByPendingId = db.query<EntryRow, [string, string]>(
    "SELECT * FROM entries WHERE session_id = ? AND pending_id = ? ORDER BY seq ASC LIMIT 1",
  );
  const selectSessions = db.query<{ session_id: string; started_at: number; last_at: number }, []>(`
    SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS last_at
    FROM entries GROUP BY session_id ORDER BY last_at DESC
  `);
  const metadata = createSessionMetadataOps(db, cap.ownerUserId);

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
      const row = insert.get(
        entry.sessionId,
        entry.turnId,
        entry.kind,
        entry.createdAt,
        entry.text,
        entry.toolCallId,
        entry.toolName,
        entry.toolArgs,
        entry.cutoff,
        entry.compactedThroughSeq,
        entry.pendingId,
      );
      if (!row) throw new Error("append returned no row");
      log.debug("entry.appended", {
        userId: cap.ownerUserId,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        kind: entry.kind,
        seq: row.seq,
      });
      return toEntry(row);
    },
    readSession(sessionId) {
      assertOpen("readSession");
      return selectSession.all(sessionId).map(toEntry);
    },
    readSince(sessionId, afterSeq) {
      assertOpen("readSince");
      return selectSince.all(sessionId, afterSeq).map(toEntry);
    },
    findByPendingId(sessionId, pendingId) {
      assertOpen("findByPendingId");
      const row = selectByPendingId.get(sessionId, pendingId);
      return row ? toEntry(row) : null;
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
    close() {
      if (closed) return;
      closed = true;
      db.close();
      log.info("store.closed", { userId: cap.ownerUserId });
    },
  };
}
