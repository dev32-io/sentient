export const SCHEDULING_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schedules (
    schedule_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    message TEXT NOT NULL,
    timing_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    source_json TEXT NOT NULL,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    create_fingerprint TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_revision INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS occurrences (
    occurrence_id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
    generation INTEGER NOT NULL,
    intended_at TEXT NOT NULL,
    claim_token TEXT,
    claimed_until TEXT,
    session_id TEXT,
    outcome TEXT,
    completed_at TEXT,
    entry_id TEXT,
    message TEXT,
    source_json TEXT,
    one_time INTEGER,
    UNIQUE(schedule_id, generation, intended_at)
  )`,
  "CREATE INDEX IF NOT EXISTS schedules_due ON schedules(deleted, enabled, next_run_at)",
  `CREATE TABLE IF NOT EXISTS content_outbox (
    outbox_id TEXT PRIMARY KEY,
    occurrence_id TEXT NOT NULL UNIQUE REFERENCES occurrences(occurrence_id),
    owner_user_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    entry_id TEXT NOT NULL,
    available_at TEXT NOT NULL,
    claim_token TEXT,
    claimed_until TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS content_outbox_due ON content_outbox(completed_at, available_at, claimed_until)",
  `CREATE TABLE IF NOT EXISTS notification_cards (
    occurrence_id TEXT PRIMARY KEY REFERENCES occurrences(occurrence_id),
    session_id TEXT NOT NULL REFERENCES sessions(session_id)
  )`,
] as const;
