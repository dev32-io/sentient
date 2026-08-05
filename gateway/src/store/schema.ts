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
  {
    version: 2,
    name: "sessions",
    statements: [
      // A session's identity, separate from its entries: `entries` has never
      // had a row that says a session EXISTS, only rows it happens to own.
      // `mint_key` is UNIQUE so SQLite itself — not a read-then-write race in
      // TypeScript — is what makes minting a session idempotent (spec §4.1).
      // `version` is the CAS token `setTitle` checks before writing.
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id       TEXT    PRIMARY KEY,
        mint_key         TEXT    NOT NULL UNIQUE,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        title            TEXT,
        title_provenance TEXT,
        version          INTEGER NOT NULL DEFAULT 1
      )`,
      // listSessionsWithMetadata orders by this, newest first.
      "CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC)",
    ],
  },
  {
    version: 3,
    name: "entries.message_id",
    statements: [
      // WHICH BUBBLE an entry belongs to. A turn is an interaction; a message
      // is what the person sees as one reply. Usually the same thing — but a
      // ReAct turn narrates, calls a tool, then answers, and the store records
      // each stretch of text as its own entry, so one turn owns several.
      //
      // Grouping them by `turn_id` alone is not enough: a message the person
      // sends mid-turn (spec §4.5's steer) is rendered as its own row BETWEEN
      // two of those stretches, and everything after it has to start a new
      // bubble or the reply visibly swallows the interjection.
      //
      // Server-minted, like every other id the client renders: the alternative
      // is three clients each deriving grouping from ordering, which is three
      // chances to disagree about what one reply was.
      //
      // Nullable, and null on every entry written before this column existed —
      // a bubble per assistant entry is exactly how those conversations already
      // render, so the back catalogue needs no backfill.
      "ALTER TABLE entries ADD COLUMN message_id TEXT",
    ],
  },
];

/** The version a store is brought up to on open. Derived, never hand-written. */
export const STORE_SCHEMA_VERSION: number = STORE_MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
