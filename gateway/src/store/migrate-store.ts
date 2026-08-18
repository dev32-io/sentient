// Schema migration for the per-user session store.
//
// Runs on every open, immediately after the frozen baseline DDL. `PRAGMA
// user_version` is SQLite's own 4-byte header slot, so it costs nothing and
// needs no bookkeeping table of its own.
//
// Forward-only. A database at a version HIGHER than this binary knows about
// (an operator rolled the gateway back) is left alone and reported: the extra
// columns are additive, so every read this binary performs still works, and
// silently "migrating" it down would destroy data.

import type { Database } from "bun:sqlite";
import { getLog } from "../logging/logger.js";
import { STORE_MIGRATIONS, STORE_SCHEMA_VERSION, type StoreMigration } from "./schema.js";

const log = getLog(["sentient", "store", "migrate-store"]);

export function readUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/** Shared forward-only SQLite migration runner. */
export function migrateDatabase(
  db: Database,
  ownerId: string,
  migrations: readonly StoreMigration[],
  schemaVersion: number,
  logScope = "store",
): number {
  const from = readUserVersion(db);
  if (from > schemaVersion) {
    log.warn(`${logScope}.schema.ahead-of-binary`, {
      userId: ownerId,
      dbVersion: from,
      binaryVersion: schemaVersion,
      reason: "database was migrated by a newer gateway; migrations are forward-only so it is left untouched",
    });
    return from;
  }
  if (from === schemaVersion) return from;
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
    })();
    log.info(`${logScope}.schema.migrated`, { userId: ownerId, from, to: migration.version, name: migration.name });
  }
  return readUserVersion(db);
}

/**
 * Bring [db] up to [STORE_SCHEMA_VERSION]. Idempotent: a store already at the
 * target version does no work. Returns the version the database is left at.
 */
export function migrateStore(db: Database, userId: string): number {
  return migrateDatabase(db, userId, STORE_MIGRATIONS, STORE_SCHEMA_VERSION);
}
