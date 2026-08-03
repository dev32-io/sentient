// The disposal policy the session registry runs (session-model spec §5).
//
// It is the `SessionDisposalPolicy` hook task 5 left, substituted — the
// registry is not rewritten. What changes is the ANSWER to "the last window
// left, now what": "dispose" becomes "dispose only once nothing observable is
// still working, and not before a grace window has passed".
//
// THREE THINGS THIS FSM EXISTS TO GET RIGHT, each of them a way the naive
// version fails:
//
//   1. THE TIMER STARTS ON THE TRANSITION, not on every check. Re-arming on
//      each evaluation pushes disposal out indefinitely for a session that is
//      polled — the grace window would never actually elapse.
//   2. DISPOSAL RE-DERIVES AT FIRE TIME, under the same synchronous step as
//      the teardown. A generation stamp alone is not enough: it catches work
//      that moved through the registry (an attach bumps it) and misses work
//      that did not — a background task registered during the grace window
//      cancels nothing and moves no stamp. A check that passed at time T is
//      not a check that passes at T+ε.
//   3. A SESSION HELD ONLY BY WORK IS RE-DERIVED ON A TIMER. Work COMPLETING
//      is not a registry event, and the registry's only events are attach and
//      detach — neither of which is going to happen for a session nobody is
//      watching. `SessionRegistry.reevaluate` makes the common case prompt;
//      this timer is what bounds the uncommon one (a worker that dies without
//      reporting) instead of leaving it resident for the life of the process.
//
// Generation stamps: every timer transition bumps a per-session counter and the
// armed callback captures it. A callback whose stamp no longer matches is one
// the world moved past — it returns without touching anything. That is belt to
// the re-derivation's braces: `clearTimeout` already prevents a cancelled
// real timer from firing, but the stamp says so structurally, and an injected
// scheduler (or a future queued-microtask shape) has no such guarantee.

import { getLog } from "../logging/logger.js";
import type { SessionDisposalInput, SessionDisposalPolicy } from "../session-handlers/session-registry.js";
import type { BackgroundTaskWatchdog, RetentionReason } from "./session-retention.js";
import { computeRetentionReasons, createBackgroundTaskWatchdog, describeRetention } from "./session-retention.js";

const log = getLog(["sentient", "runtime", "session-retention-policy"]);

/** Why a timer was armed. `disposal` tears the session down when it fires;
 *  `recheck` only re-derives. */
export type RetentionTimerKind = "disposal" | "recheck";

export interface RetentionTimerMeta {
  readonly sessionId: string;
  readonly kind: RetentionTimerKind;
  /** The session's generation at arm time; the callback carries it back. */
  readonly generation: number;
}

/** An armed timer. `cancel()` is idempotent and must prevent the callback. */
export interface RetentionTimer {
  cancel(): void;
}

export type ScheduleRetentionTimer = (fire: () => void, delayMs: number, meta: RetentionTimerMeta) => RetentionTimer;

export interface SessionRetentionPolicyOptions {
  /**
   * Grace between a session ceasing to be retained and its teardown
   * (`session.retention_ms`). A window that comes back inside it rejoins the
   * live session instead of rebuilding one.
   */
  retentionMs: number;
  /** How often a session held ONLY by work is re-derived
   *  (`session.retention_recheck_interval_ms`). */
  recheckIntervalMs: number;
  /** When a still-registered background task is treated as lost
   *  (`session.lost_task_threshold_ms`). */
  lostTaskThresholdMs: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable scheduler — the timer is an FSM worth testing without
   *  wall-clock sleeps, and "the timer fired while a connection was attaching"
   *  is not expressible against a real `setTimeout`. Defaults to
   *  `setTimeout`/`clearTimeout`. */
  schedule?: ScheduleRetentionTimer;
}

interface TrackedSession {
  /** Bumped on every timer transition — see this file's header. */
  generation: number;
  timer: RetentionTimer | null;
  timerKind: RetentionTimerKind | null;
  watchdog: BackgroundTaskWatchdog;
  /**
   * The most recent input the registry handed us for this session. Its `work`
   * and `subscriberCount` GETTERS are what a firing timer re-reads, and its
   * `dispose` is identity-guarded by the registry, so holding it across time is
   * safe: a stale one reads live state and tears down nothing.
   */
  input: SessionDisposalInput;
}

function defaultSchedule(fire: () => void, delayMs: number): RetentionTimer {
  const handle = setTimeout(fire, delayMs);
  return { cancel: () => clearTimeout(handle) };
}

export function createSessionRetentionPolicy(options: SessionRetentionPolicyOptions): SessionDisposalPolicy {
  const { retentionMs, recheckIntervalMs, lostTaskThresholdMs } = options;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;

  const tracked = new Map<string, TrackedSession>();

  function clearTimer(session: TrackedSession, reason: string): void {
    if (session.timer === null) return;
    const kind = session.timerKind;
    session.timer.cancel();
    session.timer = null;
    session.timerKind = null;
    // Bumped so a callback that is ALREADY queued behind this cancel lands on
    // a stamp that no longer matches.
    session.generation += 1;
    log.debug("session-retention.timer-cancelled", {
      sessionId: session.input.sessionId,
      kind,
      generation: session.generation,
      reason,
    });
  }

  function armTimer(
    session: TrackedSession,
    kind: RetentionTimerKind,
    delayMs: number,
    reasons: readonly RetentionReason[],
  ): void {
    session.generation += 1;
    const generation = session.generation;
    const meta: RetentionTimerMeta = { sessionId: session.input.sessionId, kind, generation };
    session.timerKind = kind;
    session.timer = schedule(
      () => (kind === "disposal" ? fireDisposal(session, generation) : fireRecheck(session, generation)),
      delayMs,
      meta,
    );
    // `reasons` is on the INFO line, not just the DEBUG derivation: "why is
    // this session still resident" has to be answerable from the default log
    // level, or the only two symptoms — never released, released too early —
    // are indistinguishable in a bug report.
    log.info("session-retention.timer-armed", {
      sessionId: session.input.sessionId,
      kind,
      delayMs,
      generation,
      reasons,
      reason:
        kind === "disposal"
          ? "nothing holds this session — disposing after the retention grace unless work or a window returns"
          : `held by work with no window attached (${describeRetention(reasons)}) — work completing is not a registry event, so re-derive on a timer`,
    });
  }

  /** Retained: keep the handles and decide what, if anything, has to tick. */
  function holdResident(session: TrackedSession, reasons: readonly RetentionReason[]): void {
    if (reasons.includes("hasSubscribers")) {
      // A watched session needs no timer at all: `hasSubscribers` cannot lapse
      // without a detach, and a detach re-enters this policy.
      clearTimer(session, "a window is attached — nothing to reclaim");
      return;
    }
    if (session.timerKind === "recheck") return; // already ticking
    clearTimer(session, "work resumed before the retention grace elapsed");
    armTimer(session, "recheck", recheckIntervalMs, reasons);
  }

  /** Not retained: start the grace window, once. */
  function armDisposal(session: TrackedSession): void {
    // THE TRANSITION, not every check — see this file's header, point 1.
    if (session.timerKind === "disposal") return;
    clearTimer(session, "this session stopped being retained");
    armTimer(session, "disposal", retentionMs, []);
  }

  function derive(session: TrackedSession, trigger: string): void {
    const observation = session.watchdog.observe(session.input.work, session.input.subscriberCount > 0);
    const reasons = computeRetentionReasons(observation.inputs);
    log.debug("session-retention.derived", {
      sessionId: session.input.sessionId,
      trigger,
      subscribers: session.input.subscriberCount,
      retained: reasons.length > 0,
      reasons,
      reason: describeRetention(reasons),
    });
    if (reasons.length === 0) {
      armDisposal(session);
      return;
    }
    holdResident(session, reasons);
  }

  function fireRecheck(session: TrackedSession, generation: number): void {
    if (session.generation !== generation) return;
    session.timer = null;
    session.timerKind = null;
    derive(session, "recheck-timer");
  }

  function fireDisposal(session: TrackedSession, generation: number): void {
    const sessionId = session.input.sessionId;
    if (session.generation !== generation) {
      log.debug("session-retention.disposal-superseded", {
        sessionId,
        generation,
        current: session.generation,
        reason: "this timer was cancelled or re-armed before it fired — ignoring it",
      });
      return;
    }
    session.timer = null;
    session.timerKind = null;

    // RE-DERIVED HERE, in the same synchronous step as the teardown below —
    // see this file's header, point 2.
    const observation = session.watchdog.observe(session.input.work, session.input.subscriberCount > 0);
    const reasons = computeRetentionReasons(observation.inputs);
    if (reasons.length > 0) {
      log.info("session-retention.disposal-declined", {
        sessionId,
        generation,
        subscribers: session.input.subscriberCount,
        reasons,
        reason: `retention grace elapsed but work is still in flight (${describeRetention(reasons)}) — keeping this session resident`,
      });
      holdResident(session, reasons);
      return;
    }

    tracked.delete(sessionId);
    log.info("session-retention.disposing", {
      sessionId,
      generation,
      retentionMs,
      trackedSessions: tracked.size,
      reason: "the retention grace elapsed and nothing holds this session",
    });
    session.input.dispose();
  }

  return (input: SessionDisposalInput): void => {
    const existing = tracked.get(input.sessionId);
    if (existing === undefined) {
      const session: TrackedSession = {
        generation: 0,
        timer: null,
        timerKind: null,
        watchdog: createBackgroundTaskWatchdog({
          sessionId: input.sessionId,
          thresholdMs: lostTaskThresholdMs,
          now,
        }),
        input,
      };
      tracked.set(input.sessionId, session);
      derive(session, "first-evaluation");
      return;
    }
    // The registry hands a FRESH input on every evaluation; keeping the latest
    // is what makes a timer armed under an old one read current state.
    existing.input = input;
    derive(existing, "evaluation");
  };
}
