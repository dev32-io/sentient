import { Database } from "bun:sqlite";
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Capability } from "../access/capability.js";
import { getLog } from "../logging/logger.js";
import { configuredUserDatabasePath, openConfiguredUserDatabase } from "../store/user-database.js";
import { CALENDAR_SCHEMA_VERSION } from "./schema.js";

const log = getLog(["sentient", "calendar", "private-calendar-consolidation"]);
const LEGACY_RELATIVE_PATH = join("calendar-v2", "calendar.db");

const TABLES = [
  {
    name: "events",
    columns: [
      "id",
      "revision",
      "title",
      "description",
      "start_instant",
      "start_time_zone_id",
      "start_all_day",
      "start_date",
      "end_instant",
      "end_time_zone_id",
      "end_all_day",
      "end_date",
      "recurrence",
      "visibility",
      "importance",
      '"group"',
      "notification_policy",
      "created_at",
      "updated_at",
    ],
    since: 1,
  },
  { name: "exceptions", columns: ["event_id", "occurrence_key", "cancelled", "override_json"], since: 1 },
  { name: "exclusions", columns: ["event_id", "occurrence_key"], since: 1 },
  { name: "tags", columns: ["event_id", "tag"], since: 1 },
  { name: "reminder_consents", columns: ["event_id", "owner_user_id", "consented_at"], since: 2 },
  {
    name: "reminder_reconciliation",
    columns: ["event_id", "requested_at", "attempt_count", "generation"],
    since: 2,
  },
] as const;

type Table = (typeof TABLES)[number];

function sourceSelect(table: Table, sourceVersion: number): string {
  const columns = table.columns.join(",");
  if (sourceVersion < table.since)
    return `SELECT ${table.columns.map((column) => `NULL AS ${column}`).join(",")} WHERE 0`;
  if (table.name === "reminder_reconciliation" && sourceVersion === 2)
    return "SELECT event_id,requested_at,attempt_count,1 AS generation FROM legacy.reminder_reconciliation";
  return `SELECT ${columns} FROM legacy.${table.name}`;
}

function rowCount(db: Database, sql: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM (${sql})`).get()?.count ?? 0;
}

function tablesMatch(db: Database, sourceVersion: number): boolean {
  return TABLES.every((table) => {
    const columns = table.columns.join(",");
    const source = sourceSelect(table, sourceVersion);
    return (
      rowCount(db, `SELECT ${columns} FROM main.${table.name} EXCEPT ${source}`) === 0 &&
      rowCount(db, `${source} EXCEPT SELECT ${columns} FROM main.${table.name}`) === 0
    );
  });
}

function destinationIsEmpty(db: Database): boolean {
  return TABLES.every((table) => rowCount(db, `SELECT 1 FROM main.${table.name}`) === 0);
}

function foreignKeyViolations(db: Database, schema = "main"): number {
  return db.query(`PRAGMA ${schema}.foreign_key_check`).all().length;
}

export interface PrivateCalendarConsolidationDeps {
  /** Focused fault hook after commit, before durability checkpoint and source retirement. */
  afterCommit?: () => void;
}

/** Import one user's legacy private calendar into configured per-user DB, then retire source file. */
export function consolidatePrivateCalendar(
  cap: Capability,
  dbFileName: string,
  deps: PrivateCalendarConsolidationDeps = {},
): void {
  if (cap.resource !== "calendar-private")
    throw new Error(`private calendar consolidation requires calendar-private capability, got ${cap.resource}`);

  const rootPath = resolve(cap.rootPath);
  const sourcePath = resolve(rootPath, LEGACY_RELATIVE_PATH);
  const targetPath = resolve(configuredUserDatabasePath(cap, dbFileName));
  const sourceLink = lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!sourceLink) return;
  if (sourcePath === targetPath) throw new Error("private calendar source and configured user DB are same file");
  if (sourceLink.isSymbolicLink()) throw new Error("private calendar source symlinks are unsupported");

  const physicalRootPath = realpathSync(rootPath);
  if (realpathSync(sourcePath) !== resolve(physicalRootPath, relative(rootPath, sourcePath)))
    throw new Error("private calendar source symlinks are unsupported");

  const targetLink = lstatSync(targetPath, { throwIfNoEntry: false });
  let existingTargetAncestor = targetPath;
  while (!lstatSync(existingTargetAncestor, { throwIfNoEntry: false }))
    existingTargetAncestor = dirname(existingTargetAncestor);
  if (
    lstatSync(existingTargetAncestor).isSymbolicLink() ||
    realpathSync(existingTargetAncestor) !== resolve(physicalRootPath, relative(rootPath, existingTargetAncestor))
  )
    throw new Error("configured user DB symlinks are unsupported");
  if (targetLink) {
    const sourceFile = statSync(sourcePath);
    const targetFile = statSync(targetPath);
    if (sourceFile.dev === targetFile.dev && sourceFile.ino === targetFile.ino)
      throw new Error("private calendar source and configured user DB are same file");
  }

  const target = openConfiguredUserDatabase(cap, dbFileName);
  try {
    target.db.exec("PRAGMA synchronous = FULL");
    const source = new Database(sourcePath);
    let sourceVersion: number;
    try {
      sourceVersion = source.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (sourceVersion < 1 || sourceVersion > CALENDAR_SCHEMA_VERSION)
        throw new Error(`unsupported private calendar schema version ${sourceVersion}`);
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (foreignKeyViolations(source) > 0) throw new Error("legacy private calendar foreign key check failed");
    } finally {
      source.close();
    }

    target.db.query("ATTACH DATABASE ? AS legacy").run(sourcePath);
    try {
      // Queries validate every required source table/column before destination mutation.
      const empty = destinationIsEmpty(target.db);
      if (!empty && !tablesMatch(target.db, sourceVersion))
        throw new Error("private calendar destination conflicts with legacy source");

      if (empty) {
        target.db.transaction(() => {
          for (const table of TABLES) {
            const columns = table.columns.join(",");
            target.db.exec(`INSERT INTO main.${table.name} (${columns}) ${sourceSelect(table, sourceVersion)}`);
          }
          if (!tablesMatch(target.db, sourceVersion)) throw new Error("private calendar import verification failed");
          if (foreignKeyViolations(target.db) > 0) throw new Error("configured user DB foreign key check failed");
        })();
      }
      if (!tablesMatch(target.db, sourceVersion)) throw new Error("private calendar post-commit verification failed");
      if (foreignKeyViolations(target.db) > 0) throw new Error("configured user DB foreign key check failed");
    } finally {
      target.db.exec("DETACH DATABASE legacy");
    }

    deps.afterCommit?.();
    const checkpoint = target.db.query<{ busy: number }, []>("PRAGMA main.wal_checkpoint(TRUNCATE)").get();
    if (!checkpoint || checkpoint.busy !== 0) throw new Error("configured user DB checkpoint busy");
    rmSync(sourcePath);
    rmSync(`${sourcePath}-wal`, { force: true });
    rmSync(`${sourcePath}-shm`, { force: true });
    log.info("private-calendar.consolidated", { userId: cap.ownerUserId, sourceVersion });
  } finally {
    target.db.close();
  }
}
