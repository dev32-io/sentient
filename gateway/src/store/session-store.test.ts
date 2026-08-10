import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createAccessManager } from "../access/access-manager.js";
import type { Capability } from "../access/capability.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { NewSessionEntry } from "./entry-types.js";
import { openSessionStore } from "./session-store.js";

const ROOT = "/tmp/sentient-store-test";
mkdirSync(`${ROOT}/u_aaaaaaaa`, { recursive: true });

const cap: Capability = Object.freeze({
  ownerUserId: "u_aaaaaaaa",
  resource: "session-store",
  rootPath: `${ROOT}/u_aaaaaaaa`,
  role: "adult",
});

// For the confused-deputy test below: a real AccessManager grant, so the
// wrong-class capability has the EXACT rootPath `cap` above has — proving the
// rejection is the resource-class check, not a path mismatch that would
// reject it anyway.
const accessManager = createAccessManager({ userDataRoot: ROOT });
const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");

function entry(overrides: Partial<NewSessionEntry> = {}): NewSessionEntry {
  return {
    sessionId: "s1",
    turnId: "t1",
    replyId: null,
    kind: "user",
    createdAt: Date.now(),
    text: "hi",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...overrides,
  };
}

// The DDL as it shipped before the pending_id migration — a verbatim copy, not a
// reference to STORE_DDL, so this test keeps describing the schema real users
// already have on disk even after STORE_DDL is edited again.
const PRE_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS entries (
  seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL,
  turn_id               TEXT    NOT NULL,
  kind                  TEXT    NOT NULL,
  created_at            INTEGER NOT NULL,
  text                  TEXT,
  tool_call_id          TEXT,
  tool_name             TEXT,
  tool_args             TEXT,
  cutoff                TEXT,
  compacted_through_seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_session_seq ON entries (session_id, seq);
`;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("SessionStore", () => {
  it("assigns monotonic seq and a timestamp on append", () => {
    const store = openSessionStore(cap);
    const a = store.append(entry({ sessionId: "seqtest", text: "one" }));
    const b = store.append(entry({ sessionId: "seqtest", text: "two" }));
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.createdAt).toBeGreaterThan(0);
    store.close();
  });

  it("SECURITY: a capability for another resource class cannot open the session store", () => {
    const fileScope = accessManager.grant(principal, "file-scope");
    expect(() => openSessionStore(fileScope)).toThrow(/resource class/i);
  });

  // I7: `store.db_filename` (config.yaml#store) is threaded through — an operator
  // override must land in the file it names, not the hardcoded "sessions.db".
  it("CONFIG: opens the db file named by the threaded db_filename, defaulting to sessions.db", () => {
    const custom = openSessionStore(cap, "custom-store.db");
    custom.append(entry({ sessionId: "cfg", text: "hi" }));
    custom.close();
    expect(existsSync(`${cap.rootPath}/custom-store.db`)).toBe(true);

    const dflt = openSessionStore(cap); // no filename → session-store default
    dflt.append(entry({ sessionId: "cfg-default", text: "hi" }));
    dflt.close();
    expect(existsSync(`${cap.rootPath}/sessions.db`)).toBe(true);
  });

  it("INVARIANT: exposes no mutating API — history is append-only", () => {
    const store = openSessionStore(cap);
    const opaque = store as unknown as Record<string, unknown>;
    expect(opaque.update).toBeUndefined();
    expect(opaque.delete).toBeUndefined();
    expect(opaque.replace).toBeUndefined();
    store.close();
  });

  it("reads a session back in append order, surviving reopen", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "persist", text: "first" }));
    store.append(entry({ sessionId: "persist", kind: "assistant", text: "second" }));
    store.close();

    const reopened = openSessionStore(cap);
    const rows = reopened.readSession("persist");
    expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
    expect(rows[0]?.kind).toBe("user");
    expect(rows[1]?.kind).toBe("assistant");
    reopened.close();
  });

  it("readSince returns only entries after the given seq", () => {
    const store = openSessionStore(cap);
    const first = store.append(entry({ sessionId: "since", text: "a" }));
    store.append(entry({ sessionId: "since", text: "b" }));
    const later = store.readSince("since", first.seq);
    expect(later.map((r) => r.text)).toEqual(["b"]);
    store.close();
  });

  it("round-trips tool_call and tool_result correlation fields", () => {
    const store = openSessionStore(cap);
    store.append(
      entry({
        sessionId: "tools",
        kind: "tool_call",
        text: null,
        toolCallId: "call_1",
        toolName: "search",
        toolArgs: '{"q":"weather"}',
      }),
    );
    store.append(
      entry({
        sessionId: "tools",
        kind: "tool_result",
        text: null,
        toolCallId: "call_1",
        toolName: "search",
        toolArgs: '{"temp":"20C"}',
      }),
    );
    const rows = store.readSession("tools");
    expect(rows[0]?.toolCallId).toBe("call_1");
    expect(rows[1]?.toolCallId).toBe("call_1");
    expect(rows[1]?.kind).toBe("tool_result");
    store.close();
  });

  it("creates its owner's home dir when absent, then opens", () => {
    // A freshly-created user whose home dir was never provisioned. The store
    // must mkdir its own scoped root — not fail with "unable to open database
    // file". Regression for the live-WS e2e where session.configure threw.
    const freshRoot = `${ROOT}/u_bbbbbbbb`; // NOT pre-created above
    const freshCap: Capability = Object.freeze({
      ownerUserId: "u_bbbbbbbb",
      resource: "session-store",
      rootPath: freshRoot,
      role: "adult",
    });
    const store = openSessionStore(freshCap);
    const appended = store.append(entry({ sessionId: "fresh", text: "hi" }));
    expect(appended.seq).toBeGreaterThan(0);
    expect(existsSync(freshRoot)).toBe(true);
    store.close();
  });

  it("MIGRATION: a database created by the OLD DDL opens, migrates in place, and keeps its rows", () => {
    // Every per-user database under ~/.sentient already exists, so a new column
    // in STORE_DDL reaches NONE of them: `CREATE TABLE IF NOT EXISTS` is not a
    // migration. This is the case a fresh-DB test structurally cannot see.
    const legacyRoot = `${ROOT}/u_cccccccc`;
    mkdirSync(legacyRoot, { recursive: true });
    const legacy = new Database(`${legacyRoot}/sessions.db`, { create: true });
    legacy.exec(PRE_MIGRATION_DDL);
    legacy.exec(
      "INSERT INTO entries (session_id, turn_id, kind, created_at, text) VALUES ('old', 't0', 'user', 5, 'legacy row')",
    );
    legacy.close();

    const legacyCap: Capability = Object.freeze({
      ownerUserId: "u_cccccccc",
      resource: "session-store",
      rootPath: legacyRoot,
      role: "adult",
    });
    const store = openSessionStore(legacyCap);
    const rows = store.readSession("old");
    expect(rows.map((r) => r.text)).toEqual(["legacy row"]);
    expect(rows[0]?.pendingId).toBeNull();
    // …and the migrated column is usable, which is what the first query naming
    // it would otherwise fail on at runtime, on real users only.
    const appended = store.append(entry({ sessionId: "old", text: "new row", pendingId: "p-legacy" }));
    expect(appended.pendingId).toBe("p-legacy");
    expect(store.findByPendingId("old", "p-legacy")?.seq).toBe(appended.seq);
    store.close();
  });

  it("MIGRATION: re-opening an already-migrated database is a no-op", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "idem", text: "a", pendingId: "p-idem" }));
    store.close();
    const reopened = openSessionStore(cap);
    expect(reopened.findByPendingId("idem", "p-idem")?.text).toBe("a");
    reopened.close();
  });

  it("findByPendingId is scoped to its session and returns null for an unseen id", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "scopeA", text: "a", pendingId: "p-scope" }));
    expect(store.findByPendingId("scopeB", "p-scope")).toBeNull();
    expect(store.findByPendingId("scopeA", "never-sent")).toBeNull();
    store.close();
  });

  it("lists sessions with first and last activity", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "listA", createdAt: 1000 }));
    store.append(entry({ sessionId: "listA", createdAt: 2000 }));
    store.append(entry({ sessionId: "listB", createdAt: 1500 }));
    const sessions = store.listSessions();
    const a = sessions.find((s) => s.sessionId === "listA");
    expect(a?.startedAt).toBe(1000);
    expect(a?.lastAt).toBe(2000);
    expect(sessions.some((s) => s.sessionId === "listB")).toBe(true);
    store.close();
  });
});
