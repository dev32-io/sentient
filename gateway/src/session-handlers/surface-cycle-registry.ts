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
}

export function createSurfaceCycleRegistry(): SurfaceCycleRegistry {
  const slots = new Map<string, SurfaceSlot>();

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
    },

    activeCycleId(surfaceKey) {
      return slots.get(surfaceKey)?.cycleId ?? null;
    },

    currentController(surfaceKey) {
      return slots.get(surfaceKey)?.controller ?? null;
    },
  };
}
