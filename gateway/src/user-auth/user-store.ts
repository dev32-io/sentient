import { randomUUID } from "node:crypto";
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

// ponytail: one process-wide write queue for users.json, including separate store
// handles. Multi-process writers require a transactional store instead.
const removingUsers = new Set<string>();
let mutationQueue: Promise<unknown> = Promise.resolve();
function mutate(operation: () => Promise<StoreResult<void>>): Promise<StoreResult<void>> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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
  /** Security hook before and after durable role/deletion mutation. Pre-write failure aborts mutation. */
  onAuthorityChanging?(listener: (user: UserRecord) => void): void;
  list(): Promise<StoreResult<UserRecord[]>>;
  get(userId: string): Promise<StoreResult<UserRecord | null>>;
  add(rec: UserRecord): Promise<StoreResult<void>>;
  update(
    userId: string,
    patch: Partial<Omit<UserRecord, "userId" | "createdAt" | "deviceAuthorityRevision">>,
  ): Promise<StoreResult<void>>;
  /** Optional archive runs after retirement, before account deletion, inside the mutation queue. */
  remove(userId: string, beforeRemove?: () => Promise<StoreResult<void>>): Promise<StoreResult<void>>;
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
  const authorityListeners = new Set<(user: UserRecord) => void>();
  function retire(user: UserRecord): boolean {
    try {
      for (const listener of authorityListeners) listener(user);
      return true;
    } catch {
      log.warn("authority-retirement-failed", { userId: user.userId });
      return false;
    }
  }
  const store: UserStore = {
    onAuthorityChanging: (listener) => {
      authorityListeners.add(listener);
    },
    async list() {
      return readAll();
    },

    async get(userId) {
      const r = await readAll();
      if (!r.ok) return r;
      if (removingUsers.has(userId)) return { ok: true, value: null };
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
      if (patch.role !== undefined && patch.role !== existing.role && !retire(existing))
        return { ok: false, error: "io-error" };
      const next: UserRecord = {
        ...existing,
        ...patch,
        userId: existing.userId,
        createdAt: existing.createdAt,
        // Role round-trips must not revive old device credentials. PIN changes
        // preserve this revision, independently of the human credential floor.
        ...(patch.role !== undefined && patch.role !== existing.role ? { deviceAuthorityRevision: randomUUID() } : {}),
      };
      const updated = [...r.value];
      updated[idx] = next;
      log.info("update", { userId, fields: Object.keys(patch) });
      const result = await writeAll(updated);
      // File replacement yields. Fence enrollments/inputs authorized during that
      // window too, including lookups holding the previous owner snapshot.
      if (result.ok && patch.role !== undefined && patch.role !== existing.role && !retire(next)) {
        return { ok: false, error: "io-error" };
      }
      return result;
    },

    async remove(userId, beforeRemove) {
      const r = await readAll();
      if (!r.ok) return r;
      const next = r.value.filter((u) => u.userId !== userId);
      if (next.length === r.value.length) {
        log.warn("remove.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      const existing = r.value.find((u) => u.userId === userId);
      if (existing && !retire(existing)) return { ok: false, error: "io-error" };
      removingUsers.add(userId);
      try {
        if (beforeRemove) {
          const prepared = await beforeRemove();
          if (!prepared.ok) return prepared;
        }
        log.info("remove", { userId });
        const result = await writeAll(next);
        if (result.ok && existing && !retire(existing)) return { ok: false, error: "io-error" };
        return result;
      } finally {
        removingUsers.delete(userId);
      }
    },
  };
  // Serialize the read-modify-write, not only rename: a racing PIN update must
  // never restore the role/revision read before a role change.
  return {
    ...store,
    add: (rec) => mutate(() => store.add(rec)),
    update: (userId, patch) => mutate(() => store.update(userId, patch)),
    remove: (userId, beforeRemove) => mutate(() => store.remove(userId, beforeRemove)),
  };
}
