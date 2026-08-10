import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { migrateStore } from "./migrate-store.js";
import { STORE_DDL, STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from "./schema.js";

const ROOT = "/tmp/sentient-schema-v4-test";
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function columns(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(entries)")
    .all()
    .map((r) => r.name);
}

describe("store migration v4", () => {
  it("carries message_id values onto reply_id and drops the old column", () => {
    const db = new Database(`${ROOT}/v3.db`);
    db.exec(STORE_DDL);
    // Bring the database to v3 only, then seed a row the old way.
    for (const m of STORE_MIGRATIONS) {
      if (m.version > 3) continue;
      for (const s of m.statements) db.exec(s);
    }
    db.exec("PRAGMA user_version = 3");
    db.exec(
      "INSERT INTO entries (session_id, turn_id, kind, created_at, text, message_id) VALUES ('s1','t1','assistant',1,'hi','r1')",
    );

    expect(migrateStore(db, "u_test")).toBe(STORE_SCHEMA_VERSION);
    expect(columns(db)).toContain("reply_id");
    expect(columns(db)).not.toContain("message_id");
    const row = db.query<{ reply_id: string | null }, []>("SELECT reply_id FROM entries").get();
    expect(row?.reply_id).toBe("r1");
    db.close();
  });
});
