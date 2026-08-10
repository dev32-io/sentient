import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "user-lifecycle"]);

export type UserLifecycleListener = (userId: string) => void | Promise<void>;

/** Which fact about a user changed. `roleChanged` exists because a role change
 *  REVOKES that account's credentials (plan 2026-08-07-tool-permissions task
 *  2c) — the floor write alone only stops the next request, so a listener has
 *  to close the sockets that are already open. */
type UserLifecycleKind = "created" | "deleted" | "roleChanged";

export interface UserLifecycle {
  onCreated(listener: UserLifecycleListener): void;
  onDeleted(listener: UserLifecycleListener): void;
  onRoleChanged(listener: UserLifecycleListener): void;
  emitCreated(userId: string): Promise<void>;
  emitDeleted(userId: string): Promise<void>;
  emitRoleChanged(userId: string): Promise<void>;
}

export function createUserLifecycle(): UserLifecycle {
  const created = new Set<UserLifecycleListener>();
  const deleted = new Set<UserLifecycleListener>();
  const roleChanged = new Set<UserLifecycleListener>();

  async function fanOut(listeners: Set<UserLifecycleListener>, kind: UserLifecycleKind, userId: string) {
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
    onRoleChanged(listener) {
      roleChanged.add(listener);
    },
    async emitCreated(userId) {
      await fanOut(created, "created", userId);
    },
    async emitDeleted(userId) {
      await fanOut(deleted, "deleted", userId);
    },
    async emitRoleChanged(userId) {
      await fanOut(roleChanged, "roleChanged", userId);
    },
  };
}
