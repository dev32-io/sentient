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
import { STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from "./schema.js";

const log = getLog(["sentient", "store", "migrate-store"]);

function readUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * Bring [db] up to [STORE_SCHEMA_VERSION]. Idempotent: a store already at the
 * target version does no work. Returns the version the database is left at.
 */
export function migrateStore(db: Database, userId: string): number {
  const from = readUserVersion(db);

  if (from > STORE_SCHEMA_VERSION) {
    log.warn("store.schema.ahead-of-binary", {
      userId,
      dbVersion: from,
      binaryVersion: STORE_SCHEMA_VERSION,
      reason: "database was migrated by a newer gateway; migrations are forward-only so it is left untouched",
    });
    return from;
  }

  if (from === STORE_SCHEMA_VERSION) {
    log.debug("store.schema.current", { userId, version: from });
    return from;
  }

  for (const migration of STORE_MIGRATIONS) {
    if (migration.version <= from) continue;
    // One transaction per step, so a failure mid-ladder leaves the database at
    // the last version that fully applied rather than half-way through one.
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      // Not parameterizable — PRAGMA takes a literal. The value is an integer
      // from this module's own frozen ladder, never external input.
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
    })();
    log.info("store.schema.migrated", {
      userId,
      from,
      to: migration.version,
      name: migration.name,
    });
  }

  return readUserVersion(db);
}
