// SQLite schema for the per-user session store (spec §3).
//
// One database file per user. WAL mode: appends inside a user serialize on
// that user's connection, and different users touch different files, so there
// is no cross-user write contention at all.
//
// THE BASELINE DDL IS FROZEN. Never add a column to `STORE_DDL` — add a
// migration below instead. `CREATE TABLE IF NOT EXISTS` is not a migration:
// every per-user database under ~/.sentient already exists, so a column added
// to the DDL reaches NONE of them, and the first query naming it fails at
// runtime for real users while every fresh-database test stays green. That
// exact blind spot is what deleted the `pending_id` round trip (defect D14).
//
// The ladder is preferred over an `ALTER TABLE` guarded by a `PRAGMA
// table_info` check for one reason: with the baseline frozen, a fresh database
// and a long-lived one run the SAME migration code. A fresh-database test
// therefore cannot pass while a real user's database fails — which is the
// property the table_info variant does not have, since a fresh DB whose DDL
// already carries the column never executes the ALTER path at all.

/** One forward-only schema step. Applied in ascending `version` order inside a
 *  transaction, after which `PRAGMA user_version` is set to `version`. */
export interface StoreMigration {
  readonly version: number;
  /** Human name for the log line — applying one is a state change. */
  readonly name: string;
  readonly statements: readonly string[];
}

/** Schema version 0 — the shape the store shipped with. FROZEN; see header. */
export const STORE_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS entries (
  seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL,
  turn_id               TEXT    NOT NULL,
  kind                  TEXT    NOT NULL,
  created_at            INTEGER NOT NULL,
  text                  TEXT,
  tool_call_id          TEXT,
  tool_name             TEXT,
  tool_args             TEXT,
  cutoff                TEXT,
  compacted_through_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entries_session_seq ON entries (session_id, seq);
`;

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    name: "entries.pending_id",
    statements: [
      // The client's own id for a message it has not yet seen committed. It is
      // what makes a resend idempotent (the store is the durable record of
      // what was already committed) and what lets the client reconcile its
      // optimistic bubble against the committed echo.
      "ALTER TABLE entries ADD COLUMN pending_id TEXT",
      // Every lookup is "has THIS session already committed THIS pendingId".
      "CREATE INDEX IF NOT EXISTS idx_entries_session_pending ON entries (session_id, pending_id)",
    ],
  },
];

/** The version a store is brought up to on open. Derived, never hand-written. */
export const STORE_SCHEMA_VERSION: number = STORE_MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
