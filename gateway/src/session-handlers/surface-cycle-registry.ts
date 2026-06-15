import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "session-handlers", "surface-cycle-registry"]);

export interface CycleLease {
  readonly owner: boolean;
  readonly activeCycleId: string;
}

interface SurfaceSlot {
  cycleId: string;
  controller: AbortController;
}

export interface SurfaceCycleRegistry {
  acquire(surfaceKey: string, cycleId: string, controller: AbortController): CycleLease;
  complete(surfaceKey: string, cycleId: string): void;
  activeCycleId(surfaceKey: string): string | null;
  currentController(surfaceKey: string): AbortController | null;
  /**
   * Resolve when the surface's in-flight cycle next completes (non-stale
   * `complete`). A refused cycle awaits this to queue behind the incumbent
   * rather than spin-redispatching. Each call returns a fresh one-shot Promise.
   */
  whenReleased(surfaceKey: string): Promise<void>;
}

export function createSurfaceCycleRegistry(): SurfaceCycleRegistry {
  const slots = new Map<string, SurfaceSlot>();
  const waiters = new Map<string, Array<() => void>>();

  return {
    acquire(surfaceKey, cycleId, controller) {
      const existing = slots.get(surfaceKey);
      if (existing) {
        log.debug("acquire.busy", { surfaceKey, activeCycleId: existing.cycleId, requested: cycleId });
        return { owner: false, activeCycleId: existing.cycleId };
      }
      slots.set(surfaceKey, { cycleId, controller });
      log.debug("acquire.owner", { surfaceKey, cycleId });
      return { owner: true, activeCycleId: cycleId };
    },

    complete(surfaceKey, cycleId) {
      const existing = slots.get(surfaceKey);
      if (!existing || existing.cycleId !== cycleId) {
        log.debug("complete.stale", { surfaceKey, requested: cycleId, active: existing?.cycleId ?? null });
        return;
      }
      slots.delete(surfaceKey);
      log.debug("complete", { surfaceKey, cycleId });
      // Lease freed — wake every waiter queued behind this surface so they can
      // re-attempt acquire. Stale completes (above) deliberately do NOT wake
      // waiters: the slot is still held by the adopted cycle.
      const w = waiters.get(surfaceKey);
      if (w) {
        waiters.delete(surfaceKey);
        for (const r of w) r();
      }
    },

    whenReleased(surfaceKey) {
      return new Promise<void>((resolve) => {
        const arr = waiters.get(surfaceKey) ?? [];
        arr.push(resolve);
        waiters.set(surfaceKey, arr);
      });
    },

    activeCycleId(surfaceKey) {
      return slots.get(surfaceKey)?.cycleId ?? null;
    },

    currentController(surfaceKey) {
      return slots.get(surfaceKey)?.controller ?? null;
    },
  };
}
