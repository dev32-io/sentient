import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Capability } from "../access/capability.js";
import type { NewSessionEntry } from "./entry-types.js";
import { STORE_DDL, STORE_MIGRATIONS } from "./schema.js";
import { DeletedSessionError, openSessionStore } from "./session-store.js";

const ROOT = "/tmp/sentient-session-lifecycle-test";

function capability(userId: `u_${string}`): Capability {
  const rootPath = `${ROOT}/${userId}`;
  mkdirSync(rootPath, { recursive: true });
  return Object.freeze({ ownerUserId: userId, resource: "session-store", rootPath, role: "adult" });
}

function entry(sessionId: string, createdAt: number, kind: NewSessionEntry["kind"] = "user"): NewSessionEntry {
  return {
    sessionId,
    turnId: `turn-${createdAt}`,
    replyId: null,
    kind,
    createdAt,
    text: "synthetic",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("session lifecycle store", () => {
  it("backfills and advances actual activity without treating title or tool rows as activity", () => {
    const cap = capability("u_activity");
    const db = new Database(`${cap.rootPath}/sessions.db`, { create: true });
    db.exec(STORE_DDL);
    for (const migration of STORE_MIGRATIONS) {
      if (migration.version > 9) break;
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec(`
      INSERT INTO sessions(session_id,mint_key,created_at,updated_at,title,title_provenance,version)
      VALUES ('old','mint-old',1,999,'recent title','user',2);
      INSERT INTO entries(session_id,turn_id,kind,created_at,text)
      VALUES ('old','t1','user',10,'synthetic'),('old','t2','assistant',20,'synthetic');
    `);
    db.close();

    const store = openSessionStore(cap);
    expect(store.getSession("old")?.lastActivityAt).toBe(20);
    store.append(entry("old", 999, "tool_call"));
    expect(store.getSession("old")?.lastActivityAt).toBe(20);
    expect(store.listRetentionCandidates(21, 10)).toContainEqual({ sessionId: "old", lastActivityAt: 20 });
    store.append(entry("old", 30, "assistant"));
    expect(store.getSession("old")?.lastActivityAt).toBe(30);
    expect(store.deleteSession("old", { inactivityCutoff: 30 })).toEqual({ status: "active", lastActivityAt: 30 });
    store.close();
  });

  it("lists and deletes legacy entry-only sessions", () => {
    const store = openSessionStore(capability("u_legacy"));
    store.append(entry("legacy", 10));
    expect(store.getSession("legacy")).toBeNull();
    expect(store.listRetentionCandidates(11, 10)).toContainEqual({ sessionId: "legacy", lastActivityAt: 10 });
    expect(store.deleteSession("legacy", { inactivityCutoff: 11 })).toMatchObject({
      status: "deleted",
      alreadyDeleted: false,
    });
    expect(store.readSession("legacy")).toEqual([]);
    store.close();
  });

  it("fences late writes and old mint keys across same-user handles without crossing owners", () => {
    const alice = capability("u_alice");
    const first = openSessionStore(alice);
    const late = openSessionStore(alice);
    first.createSession("shared", "old-mint");
    first.append(entry("shared", 10));
    expect(first.deleteSession("shared").status).toBe("deleted");
    expect(() => late.append(entry("shared", 11))).toThrow(DeletedSessionError);
    expect(() => late.createSession("replacement", "old-mint")).toThrow(DeletedSessionError);
    expect(first.deleteSession("not-yet")).toEqual({ status: "absent" });
    expect(first.listFileCleanupIntents(10).map((intent) => intent.sessionId)).not.toContain("not-yet");
    expect(() => late.append(entry("not-yet", 11))).not.toThrow();

    const bob = openSessionStore(capability("u_bob"));
    expect(() => bob.createSession("shared", "old-mint")).not.toThrow();
    bob.close();
    late.close();
    first.close();
  });

  it("rolls back failed deletion and retries idempotently with one cleanup intent", () => {
    const cap = capability("u_rollback");
    const store = openSessionStore(cap);
    store.createSession("rollback", "mint-rollback");
    store.append(entry("rollback", 10));

    const db = new Database(`${cap.rootPath}/sessions.db`);
    db.exec(`CREATE TRIGGER fail_cleanup BEFORE INSERT ON session_file_cleanup_intents
      BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END`);
    expect(() => store.deleteSession("rollback")).toThrow("synthetic cleanup failure");
    expect(store.readSession("rollback")).toHaveLength(1);
    expect(() => store.append(entry("rollback", 11))).not.toThrow();
    db.exec("DROP TRIGGER fail_cleanup");
    db.close();

    const first = store.deleteSession("rollback");
    expect(first).toMatchObject({ status: "deleted", alreadyDeleted: false });
    if (first.status !== "deleted") throw new Error("expected deletion");
    expect(store.deleteSession("rollback")).toEqual({ ...first, alreadyDeleted: true });
    expect(store.listFileCleanupIntents(1).map((intent) => intent.sessionId)).toEqual(["rollback"]);
    expect(store.ackFileCleanupIntent("rollback")).toBe(true);
    expect(store.ackFileCleanupIntent("rollback")).toBe(false);
    store.close();
  });

  it("removes target delivery links while preserving recurring and unrelated schedules", () => {
    const cap = capability("u_schedule");
    const store = openSessionStore(cap);
    store.createSession("target", "mint-target");
    store.createSession("other", "mint-other");
    const db = new Database(`${cap.rootPath}/sessions.db`);
    db.exec(`
      INSERT INTO schedules(schedule_id,owner_user_id,revision,generation,message,timing_json,enabled,source_json,
        next_run_at,created_at,updated_at,idempotency_key,create_fingerprint)
      VALUES
        ('schedule-target','u_schedule',1,1,'synthetic','{}',1,'{}',NULL,'now','now','key-target','fp-target'),
        ('schedule-other','u_schedule',1,1,'synthetic','{}',1,'{}',NULL,'now','now','key-other','fp-other');
      INSERT INTO occurrences(occurrence_id,schedule_id,generation,intended_at,claim_token,claimed_until,session_id)
      VALUES ('occ-target','schedule-target',1,'now','claim','later','target'),
             ('occ-other','schedule-other',1,'now','claim-other','later','other');
      INSERT INTO content_outbox(outbox_id,occurrence_id,owner_user_id,session_id,entry_id,available_at)
      VALUES ('out-target','occ-target','u_schedule','target','1','now'),
             ('out-other','occ-other','u_schedule','other','2','now');
      INSERT INTO notification_cards(occurrence_id,session_id)
      VALUES ('occ-target','target'),('occ-other','other');
    `);
    db.close();

    expect(store.deleteSession("target").status).toBe("deleted");
    const read = new Database(`${cap.rootPath}/sessions.db`, { readonly: true });
    expect(read.query("SELECT schedule_id FROM schedules ORDER BY schedule_id").all()).toHaveLength(2);
    expect(read.query("SELECT outbox_id FROM content_outbox").all()).toEqual([{ outbox_id: "out-other" }]);
    expect(read.query("SELECT occurrence_id FROM notification_cards").all()).toEqual([{ occurrence_id: "occ-other" }]);
    expect(
      read.query("SELECT session_id,outcome,claim_token FROM occurrences WHERE occurrence_id='occ-target'").get(),
    ).toEqual({ session_id: null, outcome: "interrupted", claim_token: null });
    expect(
      read.query("SELECT session_id,outcome,claim_token FROM occurrences WHERE occurrence_id='occ-other'").get(),
    ).toEqual({ session_id: "other", outcome: null, claim_token: "claim-other" });
    read.close();
    store.close();
  });
});
