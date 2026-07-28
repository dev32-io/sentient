// SessionStore (spec §3) — the single source of truth for conversation state.
//
// Append-only by construction: the returned object exposes append + read and
// NOTHING else. There is no update or delete method to call, which is how
// Invariant A (immutable history → byte-stable cache prefix) is enforced.
//
// Opened through a Capability, so the DB path is confined to its owner's home
// directory. One file per user (spec §2.5, §2.6).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Capability, capabilityCoversPath } from "../access/capability.js";
import { getLog } from "../logging/logger.js";
import type { NewSessionEntry, SessionEntry } from "./entry-types.js";
import { STORE_DDL } from "./schema.js";

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
  };
}

export interface SessionStore {
  /** Append an entry. Returns it with the store-assigned seq. */
  append(entry: NewSessionEntry): SessionEntry;
  readSession(sessionId: string): SessionEntry[];
  readSince(sessionId: string, afterSeq: number): SessionEntry[];
  listSessions(): Array<{ sessionId: string; startedAt: number; lastAt: number }>;
  close(): void;
}

export function openSessionStore(cap: Capability): SessionStore {
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
  log.info("store.opened", { userId: cap.ownerUserId });

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
    ]
  >(`
    INSERT INTO entries
      (session_id, turn_id, kind, created_at, text, tool_call_id, tool_name, tool_args, cutoff, compacted_through_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const selectSession = db.query<EntryRow, [string]>("SELECT * FROM entries WHERE session_id = ? ORDER BY seq ASC");
  const selectSince = db.query<EntryRow, [string, number]>(
    "SELECT * FROM entries WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
  );
  const selectSessions = db.query<{ session_id: string; started_at: number; last_at: number }, []>(`
    SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS last_at
    FROM entries GROUP BY session_id ORDER BY last_at DESC
  `);

  return {
    append(entry) {
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
      return selectSession.all(sessionId).map(toEntry);
    },
    readSince(sessionId, afterSeq) {
      return selectSince.all(sessionId, afterSeq).map(toEntry);
    },
    listSessions() {
      return selectSessions.all().map((r) => ({
        sessionId: r.session_id,
        startedAt: r.started_at,
        lastAt: r.last_at,
      }));
    },
    close() {
      db.close();
      log.info("store.closed", { userId: cap.ownerUserId });
    },
  };
}
