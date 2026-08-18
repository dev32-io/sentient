import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Capability, ResourceClass } from "../access/capability.js";
import { migrateDatabase, readUserVersion } from "../store/migrate-store.js";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarEventId,
  CalendarListWindow,
  CalendarResult,
  CalendarStore,
  Occurrence,
} from "./types.js";
import { CALENDAR_DDL, CALENDAR_MIGRATIONS, CALENDAR_SCHEMA_VERSION } from "./schema.js";

export const ACCEPTED_CLASSES: ReadonlySet<ResourceClass> = new Set(["calendar-private", "calendar-household"]);

export interface CalendarStoreDeps {
  /** Override only for tests or an embedding store coordinator. */
  migrate?: typeof migrateDatabase;
}

function notImplemented<T>(): CalendarResult<T> {
  return { ok: false, error: "not-implemented" };
}

/** Opens the capability-rooted calendar database at <root>/calendar/calendar.db.
 * A database newer than this binary is intentionally left untouched; opening it
 * succeeds, but operations remain stubs until a compatible implementation is
 * installed. This is the same explicit, forward-only policy as SessionStore. */
export function openCalendarStore(cap: Capability, cfg: CalendarConfig, deps: CalendarStoreDeps = {}): CalendarStore {
  // This must remain before join/mkdir: resource class is the authority check,
  // not an incidental consequence of the path supplied by the capability.
  if (!ACCEPTED_CLASSES.has(cap.resource)) {
    throw new Error(
      `openCalendarStore: wrong resource class "${cap.resource}" — expected calendar-private or calendar-household`,
    );
  }
  void cfg;

  const calendarRoot = join(cap.rootPath, "calendar");
  const dbPath = join(calendarRoot, "calendar.db");
  mkdirSync(calendarRoot, { recursive: true });
  const db = new Database(dbPath, { create: true });
  const recordedVersion = readUserVersion(db);
  if (recordedVersion <= CALENDAR_SCHEMA_VERSION) db.exec(CALENDAR_DDL);
  const migrate = deps.migrate ?? migrateDatabase;
  migrate(db, cap.ownerUserId, CALENDAR_MIGRATIONS, CALENDAR_SCHEMA_VERSION, "calendar");

  let closed = false;
  const usable = <T>(operation: () => CalendarResult<T>): CalendarResult<T> => {
    if (closed) return { ok: false, error: "closed" };
    return operation();
  };

  return {
    get: (_id: CalendarEventId) => usable(() => notImplemented<CalendarEvent>()),
    list: (_window: CalendarListWindow) => usable(() => notImplemented<Occurrence[]>()),
    create: (_event: CalendarEvent) => usable(() => notImplemented<CalendarEvent>()),
    update: (_event: CalendarEvent) => usable(() => notImplemented<CalendarEvent>()),
    delete: (_id: CalendarEventId) => usable(() => notImplemented<void>()),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
