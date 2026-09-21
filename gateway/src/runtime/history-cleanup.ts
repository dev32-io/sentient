import type { HistoryConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import { type DreamClock, msUntilNextHour } from "../memory/dreamer/scheduler.js";

const log = getLog(["sentient", "history", "cleanup"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HistoryCleanupDeps {
  config: HistoryConfig;
  /** Account enumeration comes from UserStore, never filesystem discovery. */
  listUsers(): Promise<string[]>;
  /** null cutoff means retry accepted file deletions only; never expire history. */
  cleanupUser(userId: string, cutoff: number | null, batchSize: number): Promise<void>;
  clock?: DreamClock;
}

/** Independent of dream success/enablement. No model calls and no retention grace. */
export function createHistoryCleanup(deps: HistoryCleanupDeps) {
  const clock: DreamClock = deps.clock ?? {
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let started = false;
  let generation = 0;
  let timer: unknown = null;
  let pending: Promise<void> = Promise.resolve();

  async function sweep(epoch: number): Promise<void> {
    const cutoff =
      deps.config.retention_days === 0 ? null : clock.now().getTime() - deps.config.retention_days * DAY_MS;
    let users: string[];
    try {
      users = await deps.listUsers();
    } catch {
      log.error("history-cleanup.list-failed", { reason: "account-enumeration-failed" });
      return;
    }
    for (const userId of users) {
      if (!started || generation !== epoch) return;
      try {
        await deps.cleanupUser(userId, cutoff, deps.config.batch_size);
      } catch {
        // External/store diagnostics may contain content or filesystem paths.
        log.error("history-cleanup.user-failed", { userId, reason: "cleanup-failed" });
      }
    }
  }

  function schedule(epoch: number): void {
    if (!started || generation !== epoch) return;
    timer = clock.setTimeout(
      () => {
        timer = null;
        run(epoch);
      },
      msUntilNextHour(clock.now(), deps.config.cleanup_hour),
    );
  }

  function run(epoch: number): void {
    // A stop/start during an in-flight account cleanup must not overlap passes.
    pending = pending.then(() => sweep(epoch)).finally(() => schedule(epoch));
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      generation += 1;
      // Idempotent catch-up scans persisted state; no dream checkpoint dependency.
      run(generation);
    },
    stop(): void {
      started = false;
      generation += 1;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    idle(): Promise<void> {
      return pending;
    },
  };
}
