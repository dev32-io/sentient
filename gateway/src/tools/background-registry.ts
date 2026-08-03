// BackgroundRegistry (Plan 2 Task 4) — bookkeeping for in-flight background
// tool tasks (delegateTask and friends). ToolBroker is the ONLY caller: it
// checks `count()` against `config.tools.max_concurrent_background_tasks`
// BEFORE registering a new task (this module does not enforce the cap
// itself — it has no config, it only counts). `cancelAll` backs the
// interrupt path (spec §4.7): every registered task's cancel handle is
// invoked, background work included, unlike barge-in which leaves
// background tasks running.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "tools", "background-registry"]);

export interface BackgroundRegistry {
  /** Number of background tasks currently registered (not yet completed). */
  count(): number;
  /**
   * When the MOST RECENTLY registered still-running task was registered; null
   * when none is. Read by the session retention predicate
   * (runtime/session-retention.ts), which needs an AGE rather than a count: a
   * worker that dies without reporting would otherwise hold its session
   * resident forever. The newest is the youngest, so "the newest is older than
   * the threshold" is exactly "every registered task is".
   */
  newestStartedAtMs(): number | null;
  /** Registers a running task's cancel handle, keyed by taskId. */
  register(taskId: string, cancel: () => void): void;
  /** Marks a task done, freeing its slot. No-op if the taskId is unknown
   *  (already completed, or never registered). */
  complete(taskId: string): void;
  /** Invokes every registered cancel handle and clears the registry. A
   *  throwing handle is logged and does not stop the remaining cancels. */
  cancelAll(): void;
}

interface RunningTask {
  cancel: () => void;
  /** Wall-clock registration time — the retention predicate's age input. */
  startedAtMs: number;
}

export function createBackgroundRegistry(): BackgroundRegistry {
  const tasks = new Map<string, RunningTask>();

  return {
    count(): number {
      return tasks.size;
    },

    newestStartedAtMs(): number | null {
      let newest: number | null = null;
      for (const task of tasks.values()) {
        if (newest === null || task.startedAtMs > newest) newest = task.startedAtMs;
      }
      return newest;
    },

    register(taskId: string, cancel: () => void): void {
      tasks.set(taskId, { cancel, startedAtMs: Date.now() });
      log.debug("background-registry.registered", { taskId, count: tasks.size });
    },

    complete(taskId: string): void {
      const existed = tasks.delete(taskId);
      log.debug("background-registry.completed", { taskId, existed, count: tasks.size });
    },

    cancelAll(): void {
      const taskIds = [...tasks.keys()];
      for (const [taskId, task] of tasks) {
        try {
          task.cancel();
        } catch (err) {
          log.warn("background-registry.cancel-failed", {
            taskId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      tasks.clear();
      log.info("background-registry.cancel-all", { taskIds, count: taskIds.length });
    },
  };
}
