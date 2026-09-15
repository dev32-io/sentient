import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import { openConfiguredUserDatabase } from "../store/user-database.js";
import { consolidatePrivateCalendar } from "./private-calendar-consolidation.js";
import { CALENDAR_DDL } from "./schema.js";

const roots: string[] = [];
const cap = (rootPath: string): Capability => ({
  ownerUserId: "u_aaaaaaaa",
  resource: "calendar-private",
  rootPath,
  role: "adult",
});
const sessionCap = (rootPath: string): Capability => ({ ...cap(rootPath), resource: "session-store" });
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "private-calendar-consolidation-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function seedLegacy(base: string, version: 1 | 2 | 3): string {
  const path = join(base, "calendar-v2", "calendar.db");
  mkdirSync(join(base, "calendar-v2"), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(CALENDAR_DDL);
  if (version === 1) db.exec("DROP TABLE reminder_consents; DROP TABLE reminder_reconciliation");
  if (version === 2) db.exec("ALTER TABLE reminder_reconciliation DROP COLUMN generation");
  db.exec(`PRAGMA user_version = ${version}`);
  db.query(
    `INSERT INTO events
      (id,revision,title,description,start_instant,start_time_zone_id,start_all_day,start_date,
       end_instant,end_time_zone_id,end_all_day,end_date,recurrence,visibility,importance,"group",
       notification_policy,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "event-1",
    4,
    "fixture",
    "description",
    "2026-01-01T10:00:00.000Z",
    "UTC",
    0,
    null,
    "2026-01-01T11:00:00.000Z",
    "UTC",
    0,
    null,
    '{"rrule":"FREQ=DAILY;COUNT=2","rule":{"freq":"DAILY","count":2}}',
    "adults",
    "important",
    "family",
    '{"sentientPersonalReminders":{"u_aaaaaaaa":{"enabled":true}}}',
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );
  db.query("INSERT INTO exceptions VALUES (?,?,?,?)").run(
    "event-1",
    '{"occurrence":{"kind":"timed","instant":"2026-01-02T10:00:00.000Z","timeZoneId":"UTC"}}',
    0,
    '{"title":"changed"}',
  );
  db.query("INSERT INTO exclusions VALUES (?,?)").run(
    "event-1",
    '{"occurrence":{"kind":"timed","instant":"2026-01-03T10:00:00.000Z","timeZoneId":"UTC"}}',
  );
  db.query("INSERT INTO tags VALUES (?,?)").run("event-1", "tag-1");
  if (version >= 2) {
    db.query("INSERT INTO reminder_consents VALUES (?,?,?)").run("event-1", "u_aaaaaaaa", "2026-01-01T00:00:00.000Z");
    if (version === 2)
      db.query("INSERT INTO reminder_reconciliation VALUES (?,?,?)").run("event-1", "2026-01-04T00:00:00.000Z", 2);
    else
      db.query("INSERT INTO reminder_reconciliation VALUES (?,?,?,?)").run("event-1", "2026-01-04T00:00:00.000Z", 2, 7);
  }
  db.close();
  return path;
}

function legacySnapshot(path: string): unknown {
  const db = new Database(path);
  try {
    return {
      version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      schema: db
        .query<{ name: string; sql: string }, []>(
          "SELECT name,sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
      events: db.query("SELECT * FROM events ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

function sessionEntry(): NewSessionEntry {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    replyId: null,
    kind: "user",
    createdAt: 1,
    text: "existing session",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  };
}

describe("private calendar consolidation", () => {
  it("imports supported live versions into custom configured DB and preserves existing sessions", () => {
    for (const version of [1, 2, 3] as const) {
      const base = root();
      const source = seedLegacy(base, version);
      const sessions = openSessionStore(sessionCap(base), "person.db");
      sessions.append(sessionEntry());
      sessions.close();

      consolidatePrivateCalendar(cap(base), "person.db");

      expect(existsSync(source)).toBe(false);
      const db = new Database(join(base, "person.db"));
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
      expect(
        db.query<{ revision: number; recurrence: string }, []>("SELECT revision,recurrence FROM events").get(),
      ).toEqual({
        revision: 4,
        recurrence: '{"rrule":"FREQ=DAILY;COUNT=2","rule":{"freq":"DAILY","count":2}}',
      });
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM exceptions").get()?.count).toBe(1);
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM exclusions").get()?.count).toBe(1);
      expect(db.query<{ tag: string }, []>("SELECT tag FROM tags").get()?.tag).toBe("tag-1");
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM reminder_consents").get()?.count).toBe(
        version >= 2 ? 1 : 0,
      );
      expect(
        db.query<{ generation: number }, []>("SELECT generation FROM reminder_reconciliation").get()?.generation,
      ).toBe(version === 3 ? 7 : version === 2 ? 1 : undefined);
      expect(db.query<{ count: number }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();

      const reopened = openSessionStore(sessionCap(base), "person.db");
      expect(reopened.readSession("session-1").map((row) => row.text)).toEqual(["existing session"]);
      reopened.close();
    }
  });

  it("retries safely after target commit and retires source only after verification", () => {
    const base = root();
    const source = seedLegacy(base, 3);
    expect(() =>
      consolidatePrivateCalendar(cap(base), "sessions.db", {
        afterCommit: () => {
          throw new Error("interrupt");
        },
      }),
    ).toThrow("interrupt");
    expect(existsSync(source)).toBe(true);

    consolidatePrivateCalendar(cap(base), "sessions.db");
    consolidatePrivateCalendar(cap(base), "sessions.db");
    const db = new Database(join(base, "sessions.db"));
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
    db.close();
  });

  it("retains source when target checkpoint is busy", () => {
    const base = root();
    const source = seedLegacy(base, 3);
    let reader: Database | undefined;
    try {
      expect(() =>
        consolidatePrivateCalendar(cap(base), "sessions.db", {
          afterCommit: () => {
            reader = new Database(join(base, "sessions.db"));
            reader.exec("BEGIN");
            reader.query("SELECT COUNT(*) FROM events").get();
          },
        }),
      ).toThrow(/checkpoint busy/);
      expect(existsSync(source)).toBe(true);
    } finally {
      reader?.exec("ROLLBACK");
      reader?.close();
    }

    consolidatePrivateCalendar(cap(base), "sessions.db");
    expect(existsSync(source)).toBe(false);
  });

  it("rejects direct, symlink, and hardlink aliases before changing legacy data", () => {
    for (const alias of ["direct", "symlink", "hardlink"] as const) {
      const base = root();
      const source = seedLegacy(base, 3);
      const before = legacySnapshot(source);
      const target = alias === "direct" ? source : join(base, `${alias}.db`);
      if (alias === "symlink") symlinkSync(source, target);
      if (alias === "hardlink") linkSync(source, target);

      expect(() =>
        consolidatePrivateCalendar(cap(base), alias === "direct" ? "calendar-v2/calendar.db" : `${alias}.db`),
      ).toThrow(alias === "symlink" ? /symlink/ : /same file/);
      expect(legacySnapshot(source)).toEqual(before);
    }
  });

  it("rejects a symlinked legacy source without changing its data", () => {
    const base = root();
    const actual = seedLegacy(root(), 3);
    mkdirSync(join(base, "calendar-v2"), { recursive: true });
    symlinkSync(actual, join(base, "calendar-v2", "calendar.db"));
    const before = legacySnapshot(actual);

    expect(() => consolidatePrivateCalendar(cap(base), "sessions.db")).toThrow(/source symlinks/);
    expect(legacySnapshot(actual)).toEqual(before);
    expect(existsSync(join(base, "sessions.db"))).toBe(false);
  });

  it("fails closed for destination conflicts, newer sources, and foreign-key violations", () => {
    const conflicting = root();
    const conflictSource = seedLegacy(conflicting, 3);
    const target = openConfiguredUserDatabase(cap(conflicting), "sessions.db");
    target.db.exec(
      `INSERT INTO events (id,title,start_all_day,start_date,visibility,importance,created_at,updated_at)
       VALUES ('other','other',1,'2026-02-01','everyone','normal','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    );
    target.db.close();
    expect(() => consolidatePrivateCalendar(cap(conflicting), "sessions.db")).toThrow(/conflicts/);
    expect(existsSync(conflictSource)).toBe(true);

    const newer = root();
    const newerSource = seedLegacy(newer, 3);
    const newerDb = new Database(newerSource);
    newerDb.exec("PRAGMA user_version = 4");
    newerDb.close();
    expect(() => consolidatePrivateCalendar(cap(newer), "sessions.db")).toThrow(/unsupported/);
    expect(existsSync(newerSource)).toBe(true);

    const invalid = root();
    const invalidSource = seedLegacy(invalid, 3);
    const invalidDb = new Database(invalidSource);
    invalidDb.exec("PRAGMA foreign_keys = OFF");
    invalidDb.query("INSERT INTO tags VALUES (?,?)").run("missing-event", "orphan");
    invalidDb.close();
    expect(() => consolidatePrivateCalendar(cap(invalid), "sessions.db")).toThrow(/foreign key/);
    expect(existsSync(invalidSource)).toBe(true);
  });

  it("leaves household calendar file untouched and enables foreign keys on reusable user opener", () => {
    const base = root();
    const householdPath = join(base, "household", "calendar-v2", "calendar.db");
    mkdirSync(join(householdPath, ".."), { recursive: true });
    const household = new Database(householdPath);
    household.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged')");
    household.close();

    const opened = openConfiguredUserDatabase(cap(base), "custom.db");
    expect(opened.path).toBe(join(base, "custom.db"));
    expect(opened.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    opened.db.close();
    consolidatePrivateCalendar(cap(base), "custom.db");

    const check = new Database(householdPath);
    expect(check.query<{ value: string }, []>("SELECT value FROM sentinel").get()?.value).toBe("unchanged");
    check.close();
  });
});
