import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "user-lifecycle"]);

export type UserLifecycleListener = (userId: string) => void | Promise<void>;

export interface UserLifecycle {
  onCreated(listener: UserLifecycleListener): void;
  onDeleted(listener: UserLifecycleListener): void;
  emitCreated(userId: string): Promise<void>;
  emitDeleted(userId: string): Promise<void>;
}

export function createUserLifecycle(): UserLifecycle {
  const created = new Set<UserLifecycleListener>();
  const deleted = new Set<UserLifecycleListener>();

  async function fanOut(listeners: Set<UserLifecycleListener>, kind: "created" | "deleted", userId: string) {
    for (const l of listeners) {
      try {
        await l(userId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("listener-error", { kind, userId, reason });
      }
    }
  }

  return {
    onCreated(listener) {
      created.add(listener);
    },
    onDeleted(listener) {
      deleted.add(listener);
    },
    async emitCreated(userId) {
      await fanOut(created, "created", userId);
    },
    async emitDeleted(userId) {
      await fanOut(deleted, "deleted", userId);
    },
  };
}
