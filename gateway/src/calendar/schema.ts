/**
 * V2 is a fresh cutover.  Unlike the other per-user stores, this schema is
 * intentionally not a migration ladder: an old `calendar/calendar.db` is
 * outside the V2 location and an old database copied into the V2 location is
 * not interpreted by this module.
 */
export const CALENDAR_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  title TEXT NOT NULL,
  description TEXT,
  start_instant TEXT,
  start_time_zone_id TEXT,
  start_all_day INTEGER NOT NULL DEFAULT 0 CHECK (start_all_day IN (0, 1)),
  start_date TEXT,
  end_instant TEXT,
  end_time_zone_id TEXT,
  end_all_day INTEGER NOT NULL DEFAULT 0 CHECK (end_all_day IN (0, 1)),
  end_date TEXT,
  recurrence TEXT,
  visibility TEXT NOT NULL DEFAULT 'everyone',
  importance TEXT NOT NULL DEFAULT 'normal',
  "group" TEXT,
  notification_policy TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE exceptions (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  override_json TEXT,
  PRIMARY KEY (event_id, occurrence_key)
);

CREATE TABLE exclusions (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence_key)
);

CREATE TABLE tags (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (event_id, tag)
);

CREATE INDEX idx_events_start_instant ON events (start_instant);
CREATE INDEX idx_events_start_date ON events (start_date);
`;

/** Kept as an empty export so callers cannot accidentally add a V1 migration. */
export const CALENDAR_MIGRATIONS: readonly never[] = [];
export const CALENDAR_SCHEMA_VERSION = 1;
