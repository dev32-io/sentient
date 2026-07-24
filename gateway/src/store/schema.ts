// SQLite DDL for the per-user session store (spec §3).
//
// One database file per user. WAL mode: appends inside a user serialize on
// that user's connection, and different users touch different files, so there
// is no cross-user write contention at all.

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
