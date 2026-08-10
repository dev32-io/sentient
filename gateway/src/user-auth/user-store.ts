import { promises as fs } from "node:fs";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "./atomic-write.js";
import { getUsersJsonPath } from "./paths.js";
import type { StoreResult, UserRecord } from "./types.js";
import { isLegacyUserRecord, migrateUserRecord } from "./user-record-migration.js";

const log = getLog(["sentient", "gateway", "user-auth", "user-store"]);

// The role migration is applied on READ, in memory, and persists the first time
// anything writes the file. It is announced ONCE per process: `readAll` runs on
// every get/list, so logging per read would spam a line per request until an
// unrelated mutation happened to rewrite users.json.
let loggedLegacyMigration = false;

function migrateAll(rows: unknown[]): UserRecord[] {
  const migrated = rows.map(migrateUserRecord);
  const legacyCount = rows.filter(isLegacyUserRecord).length;
  if (legacyCount > 0 && !loggedLegacyMigration) {
    loggedLegacyMigration = true;
    log.info("read.role-migrated", {
      legacyCount,
      total: rows.length,
      reason: "records stored isAdmin and no role; derived one on read (true→admin, otherwise adult)",
    });
  }
  return migrated;
}

export interface UserStore {
  list(): Promise<StoreResult<UserRecord[]>>;
  get(userId: string): Promise<StoreResult<UserRecord | null>>;
  add(rec: UserRecord): Promise<StoreResult<void>>;
  update(userId: string, patch: Partial<Omit<UserRecord, "userId" | "createdAt">>): Promise<StoreResult<void>>;
  remove(userId: string): Promise<StoreResult<void>>;
}

async function readAll(): Promise<StoreResult<UserRecord[]>> {
  const path = getUsersJsonPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug("list.empty", { reason: "users.json missing", path });
      return { ok: true, value: [] };
    }
    log.warn("list.io-error", { path, reason: (e as Error).message });
    return { ok: false, error: "io-error" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    log.warn("list.corrupt", { path, reason: (e as Error).message });
    return { ok: false, error: "corrupt-file" };
  }
  if (!Array.isArray(parsed)) {
    log.warn("list.corrupt", { path, reason: "not an array" });
    return { ok: false, error: "corrupt-file" };
  }
  return { ok: true, value: migrateAll(parsed) };
}

async function writeAll(users: UserRecord[]): Promise<StoreResult<void>> {
  try {
    await writeFileAtomic(getUsersJsonPath(), JSON.stringify(users, null, 2), { mode: 0o600 });
    log.info("write-all", { count: users.length });
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    log.warn("write-all.io-error", { reason: (e as Error).message });
    return { ok: false, error: "io-error" };
  }
}

export function createUserStore(): UserStore {
  return {
    async list() {
      return readAll();
    },

    async get(userId) {
      const r = await readAll();
      if (!r.ok) return r;
      const found = r.value.find((u) => u.userId === userId) ?? null;
      return { ok: true, value: found };
    },

    async add(rec) {
      const r = await readAll();
      if (!r.ok) return r;
      if (r.value.some((u) => u.userId === rec.userId)) {
        log.warn("add.already-exists", { userId: rec.userId });
        return { ok: false, error: "already-exists" };
      }
      return writeAll([...r.value, rec]);
    },

    async update(userId, patch) {
      const r = await readAll();
      if (!r.ok) return r;
      const idx = r.value.findIndex((u) => u.userId === userId);
      if (idx === -1) {
        log.warn("update.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      const existing = r.value[idx];
      if (!existing) return { ok: false, error: "not-found" };
      const next: UserRecord = {
        ...existing,
        ...patch,
        userId: existing.userId,
        createdAt: existing.createdAt,
      };
      const updated = [...r.value];
      updated[idx] = next;
      log.info("update", { userId, fields: Object.keys(patch) });
      return writeAll(updated);
    },

    async remove(userId) {
      const r = await readAll();
      if (!r.ok) return r;
      const next = r.value.filter((u) => u.userId !== userId);
      if (next.length === r.value.length) {
        log.warn("remove.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      log.info("remove", { userId });
      return writeAll(next);
    },
  };
}
