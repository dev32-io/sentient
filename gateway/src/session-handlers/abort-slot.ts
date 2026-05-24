import { getLog } from "../logging/logger.js";

export interface AbortSlot {
  register(id: string, controller: AbortController): void;
  complete(id: string): void;
  cancelCurrent(reason: string): string | null;
  currentId(): string | null;
  currentController(): AbortController | null;
  onComplete(listener: (id: string) => void): () => void;
}

/**
 * Single-slot registry for an AbortController. One producer registers its
 * controller with an id at start; it (or someone else) calls `complete` at
 * natural end, or `cancelCurrent` to abort mid-flight. `onComplete` fires
 * only on natural completion — never on cancel.
 */
export function createAbortSlot(name: string): AbortSlot {
  const log = getLog(["sentient", "session-handlers", "abort-slot", name]);
  let currentId: string | null = null;
  let controller: AbortController | null = null;
  const listeners = new Set<(id: string) => void>();

  return {
    register(id, ctrl) {
      if (currentId !== null) {
        log.warn("register-over-existing", { previousId: currentId, newId: id });
      }
      currentId = id;
      controller = ctrl;
      log.debug("registered", { id });
    },
    complete(id) {
      if (currentId !== id) {
        log.debug("complete-id-mismatch", { currentId, requestedId: id });
        return;
      }
      const completedId = currentId;
      currentId = null;
      controller = null;
      log.debug("completed", { id: completedId });
      for (const l of listeners) l(completedId);
    },
    cancelCurrent(reason) {
      if (currentId === null || controller === null) return null;
      const cancelledId = currentId;
      log.info("cancel", { id: cancelledId, reason });
      controller.abort(reason);
      currentId = null;
      controller = null;
      return cancelledId;
    },
    currentId() {
      return currentId;
    },
    currentController() {
      return controller;
    },
    onComplete(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
