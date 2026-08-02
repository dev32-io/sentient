import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Capability } from "../access/capability.js";
import { migrateStore } from "./migrate-store.js";
import { STORE_DDL, STORE_MIGRATIONS } from "./schema.js";
import { openSessionStore } from "./session-store.js";

const ROOT = "/tmp/sentient-session-metadata-test";
mkdirSync(`${ROOT}/u_meta`, { recursive: true });

const cap: Capability = Object.freeze({
  ownerUserId: "u_meta",
  resource: "session-store",
  rootPath: `${ROOT}/u_meta`,
});

// Reconstructs a database exactly as far as schema [version] and no further —
// the fixture for "does the ladder reach an EXISTING database", not just a
// fresh one. A slimmed copy of the ladder-walking loop in migrate-store.ts,
// stopped early instead of run to STORE_SCHEMA_VERSION.
function openStoreAtSchemaVersion(version: number): Database {
  const db = new Database(":memory:");
  db.exec(STORE_DDL);
  for (const migration of STORE_MIGRATIONS) {
    if (migration.version > version) break;
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  return db;
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("session metadata", () => {
  it("INVARIANT: the sessions table is created in a database that predates it", () => {
    const db = openStoreAtSchemaVersion(0); // baseline only
    migrateStore(db, "u_test");
    expect(db.query("SELECT name FROM sqlite_master WHERE name='sessions'").all()).toHaveLength(1);
  });

  it("INVARIANT: creating a session twice with one mint key yields one row", () => {
    const store = openSessionStore(cap);
    const first = store.createSession("s_aaa", "mint-1");
    expect(() => store.createSession("s_bbb", "mint-1")).toThrow();
    expect(store.findSessionByMintKey("mint-1")?.sessionId).toBe(first.sessionId);
    store.close();
  });

  it("INVARIANT: a title write with a stale version is refused", () => {
    const store = openSessionStore(cap);
    const s = store.createSession("s_ccc", "mint-2");
    expect(store.setTitle("s_ccc", "Renamed", "user", s.version)).toBe(true);
    expect(store.setTitle("s_ccc", "Generated", "generated", s.version)).toBe(false);
    store.close();
  });

  it("INVARIANT: provenance=user is never overwritten by a generated title", () => {
    const store = openSessionStore(cap);
    const created = store.createSession("s_ddd", "mint-3");
    store.setTitle("s_ddd", "Kitchen lights", "user", created.version);
    const named = store.getSession("s_ddd");
    expect(named).not.toBeNull();
    if (named === null) throw new Error("unreachable: asserted non-null above");
    expect(store.setTitle("s_ddd", "Auto title", "generated", named.version)).toBe(false);
    store.close();
  });
});
