import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Capability } from "../access/capability.js";
import { openCalendarStore } from "./calendar-store.js";
import { CALENDAR_SCHEMA_VERSION } from "./schema.js";
import type { CalendarConfig } from "./types.js";

const cfg = {} as CalendarConfig;
const roots: string[] = [];
function cap(rootPath: string, resource: Capability["resource"] = "calendar-private"): Capability {
  return { ownerUserId: "u1" as Capability["ownerUserId"], resource, rootPath, role: "adult" };
}
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "calendar-store-test-"));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("CalendarStore factory", () => {
  it("gates resource class before touching the path", () => {
    const missing = join(root(), "does-not-exist");
    expect(() => openCalendarStore(cap(missing, "session-store"), cfg)).toThrow(/wrong resource class/);
    expect(existsSync(missing)).toBe(false);
  });

  it("creates the private database, migrates v0, and enables WAL", () => {
    const base = root();
    const store = openCalendarStore(cap(base), cfg);
    const db = new Database(join(base, "calendar", "calendar.db"));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(CALENDAR_SCHEMA_VERSION);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeTruthy();
    expect(db.query<{ name: string }, []>("PRAGMA table_info(events)").all().some((column) => column.name === "group")).toBe(true);
    store.close();
    store.close();
    expect(store.list({ from: { kind: "all-day", date: "2026-01-01" }, to: { kind: "all-day", date: "2026-01-02" } })).toEqual({ ok: false, error: "closed" });
    db.close();
  });

  it("leaves an ahead-of-binary database untouched", () => {
    const base = root();
    const dbPath = join(base, "calendar", "calendar.db");
    mkdirSync(join(base, "calendar"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${CALENDAR_SCHEMA_VERSION + 10}`);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    db.close();
    const store = openCalendarStore(cap(base), cfg);
    const check = new Database(dbPath);
    expect(check.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(CALENDAR_SCHEMA_VERSION + 10);
    store.close();
    check.close();
  });
});
