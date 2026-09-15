import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Capability, capabilityCoversPath } from "../access/capability.js";
import { migrateStore } from "./migrate-store.js";
import { STORE_DDL } from "./schema.js";

export const DEFAULT_USER_DB_FILENAME = "sessions.db";

export function configuredUserDatabasePath(cap: Capability, dbFileName: string = DEFAULT_USER_DB_FILENAME): string {
  const dbPath = path.join(cap.rootPath, dbFileName);
  if (!capabilityCoversPath(cap, dbPath)) throw new Error(`store path escapes capability scope: ${dbPath}`);
  return dbPath;
}

/** Shared physical setup only. Domain modules must validate resource class before calling. */
export function openConfiguredUserDatabase(
  cap: Capability,
  dbFileName: string = DEFAULT_USER_DB_FILENAME,
): { db: Database; path: string; schemaVersion: number } {
  return openUserDatabaseAtPath(configuredUserDatabasePath(cap, dbFileName), cap.ownerUserId);
}

/** Physical setup for already-authorized domain/supervisor paths; grants no resource authority. */
export function openUserDatabaseAtPath(
  dbPath: string,
  ownerId: string,
): { db: Database; path: string; schemaVersion: number } {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(STORE_DDL);
    db.exec("PRAGMA foreign_keys = ON");
    return { db, path: dbPath, schemaVersion: migrateStore(db, ownerId) };
  } catch (error) {
    db.close();
    throw error;
  }
}
