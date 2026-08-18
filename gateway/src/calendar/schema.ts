import type { StoreMigration } from "../store/schema.js";

/** Baseline connection pragmas. The schema itself is installed by migration 1. */
export const CALENDAR_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
`;

/** v1 is deliberately a migration (rather than CREATE TABLE in CALENDAR_DDL),
 * so a fresh v0 database exercises exactly the same path as an existing one. */
export const CALENDAR_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    name: "calendar.baseline",
    statements: [
      `CREATE TABLE events (
        id TEXT PRIMARY KEY,
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
      )`,
      `CREATE TABLE exceptions (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        occurrence_key TEXT NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        override_json TEXT,
        PRIMARY KEY (event_id, occurrence_key)
      )`,
      `CREATE TABLE exdates (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        occurrence_key TEXT NOT NULL,
        PRIMARY KEY (event_id, occurrence_key)
      )`,
      `CREATE TABLE tags (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (event_id, tag)
      )`,
      "CREATE INDEX idx_events_start_instant ON events (start_instant)",
      "CREATE INDEX idx_events_start_date ON events (start_date)",
    ],
  },
];

export const CALENDAR_SCHEMA_VERSION = CALENDAR_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
