// Dreamer scheduler (memory-system spec §8) — the app-lifetime clock that fires
// the nightly per-user consolidation and, at boot, catches up any user whose
// last run is stale. It owns TIMING and SEQUENCING only; the per-user work is
// the S3a transaction (dream-transaction.ts), injected as four function seams.
//
// THREE PROPERTIES THIS FILE HOLDS:
//   1. FIRES ONCE PER DAY at `cfg.dreamer.hour` LOCAL time. The next fire is
//      recomputed from the clock after each pass, so a missed slot (process
//      asleep past the hour) is picked up by the boot catch-up, not double-fired.
//   2. PER-USER SEQUENTIAL, and passes never overlap. One shared promise chain
//      serialises everything: a nightly fire that lands mid-catch-up queues
//      behind it; within a pass, each user's dream awaits the previous one's
//      resolution. Two dreams for one user (or two users) never run at once —
//      the provider budget and the single-writer index both assume it.
//   3. CLOCK IS INJECTED end to end (now + setTimeout + clearTimeout), so tests
//      drive time with zero real timers.
//
// A toggled-off user is SKIPPED but its mark still advances — that branch is
// `skipAndAdvance`, chosen here by reading `dreamingEnabledFor`. No memory
// content is logged (global constraint): userIds, counts and outcomes only.

import type { OrchestratorConfig } from "@sentient/config";
import { getLog } from "../../logging/logger.js";
import type { DreamOutcome } from "./dream-transaction.js";

const log = getLog(["sentient", "memory", "dreamer", "scheduler"]);

// ---------------------------------------------------------------------------
// Injected clock
// ---------------------------------------------------------------------------

/** Opaque timer handle — a `number` (browser) or `Timeout` (node); the scheduler
 *  only ever hands it back to `clearTimeout`. */
export type DreamTimer = unknown;

/** The clock the scheduler runs on. Prod passes the host clock (real `Date` +
 *  `setTimeout`); tests pass a fake so no wall-clock time passes. */
export interface DreamClock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): DreamTimer;
  clearTimeout(timer: DreamTimer): void;
}

// ---------------------------------------------------------------------------
// Deps + surface
// ---------------------------------------------------------------------------

export interface DreamSchedulerDeps {
  /** The ENABLED-path transaction for one user (map → write → flush → advance). */
  runDreamFor(userId: string): Promise<DreamOutcome>;
  /** The DISABLED-path transaction: advance the mark without running. */
  skipAndAdvance(userId: string): Promise<DreamOutcome>;
  /** Whether a stale mark warrants a boot catch-up run for this user. */
  catchUpDueFor(userId: string): Promise<boolean>;
  /** Every user the gateway knows about (profile/user store surface). */
  listUsers(): Promise<string[]>;
  /** This user's `dreaming` toggle, read at decision time (no snapshot). */
  dreamingEnabledFor(userId: string): Promise<boolean>;
  /** `orchestrator.memory` — `cfg.dreamer.hour` is the only field read here. */
  cfg: OrchestratorConfig["memory"];
  clock: DreamClock;
}

export interface DreamScheduler {
  /** Arm the nightly timer and kick a boot catch-up pass. Idempotent — a second
   *  call is a no-op while already started. */
  start(): void;
  /** Disarm the nightly timer. In-flight work is left to settle. */
  stop(): void;
  /** Resolves when all currently-queued work has settled — the graceful-shutdown
   *  and test-synchronisation seam. */
  idle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure timing helper
// ---------------------------------------------------------------------------

/** Milliseconds from `now` until the next `hour:00:00` in LOCAL time. Today when
 *  `now` is before the hour, tomorrow otherwise (so a fire AT the hour schedules
 *  the following day, never a zero-delay loop). */
export function msUntilNextHour(now: Date, hour: number): number {
  const next = new Date(now.getTime());
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1); // roll to tomorrow's slot
  }
  return next.getTime() - now.getTime();
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function createDreamScheduler(deps: DreamSchedulerDeps): DreamScheduler {
  const { clock } = deps;
  let timer: DreamTimer | null = null;
  let started = false;
  let stopped = false;
  // The single serialisation point (property 2). Every unit of work chains onto
  // this; `.then(fn, fn)` runs the next unit whether or not the last threw, so
  // one failing user never wedges the chain.
  let chain: Promise<void> = Promise.resolve();

  function enqueue(unit: () => Promise<void>): Promise<void> {
    chain = chain.then(unit, unit);
    return chain;
  }

  /** One user's turn: read the toggle, run the enabled or the skip-advance path.
   *  On catch-up, gate on the mark's staleness first. Never throws — a failure
   *  is logged and swallowed so the pass continues to the next user. */
  async function processUser(userId: string, isCatchUp: boolean): Promise<void> {
    try {
      if (isCatchUp && !(await deps.catchUpDueFor(userId))) {
        log.debug("dreamer.catchup.not-due", { userId });
        return;
      }
      const enabled = await deps.dreamingEnabledFor(userId);
      const outcome = enabled ? await deps.runDreamFor(userId) : await deps.skipAndAdvance(userId);
      log.info("dreamer.user.done", { userId, enabled, result: outcome.result, catchUp: isCatchUp });
    } catch (err) {
      // A poisoned user must not sink the whole pass (error-handling rule).
      log.error("dreamer.user.error", { userId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /** One sweep over every user, strictly sequential. */
  async function runPass(isCatchUp: boolean): Promise<void> {
    let users: string[];
    try {
      users = await deps.listUsers();
    } catch (err) {
      log.error("dreamer.pass.list-failed", { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    log.info("dreamer.pass.start", { users: users.length, catchUp: isCatchUp });
    for (const userId of users) {
      await processUser(userId, isCatchUp);
    }
    log.info("dreamer.pass.done", { users: users.length, catchUp: isCatchUp });
  }

  function scheduleNextNightly(): void {
    if (stopped) return;
    const ms = msUntilNextHour(clock.now(), deps.cfg.dreamer.hour);
    log.info("dreamer.nightly.scheduled", { hour: deps.cfg.dreamer.hour, in_ms: ms });
    timer = clock.setTimeout(() => {
      // Reschedule from the fired-at clock reading, then queue the pass. The
      // reschedule uses the CURRENT clock, so the next fire is a full day out.
      scheduleNextNightly();
      void enqueue(() => runPass(false));
    }, ms);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      scheduleNextNightly();
      // Boot catch-up (spec §8) — queued on the same chain, so if the nightly
      // timer happens to fire during it, that pass waits its turn.
      void enqueue(() => runPass(true));
      log.info("dreamer.scheduler.started", { hour: deps.cfg.dreamer.hour });
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      log.info("dreamer.scheduler.stopped", {});
    },
    idle(): Promise<void> {
      return chain;
    },
  };
}
