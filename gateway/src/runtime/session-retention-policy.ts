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
//
// THE CALLBACKS ARE DETACHED, SO THEY CATCH THEIR OWN THROWS. Teardown
// (`input.dispose()` -> `permissions.denyAll()` -> `runtime.dispose()` ->
// `voice.cancelAudio()` + `store.close()` -> `replayRegistry.release()`) used to
// run synchronously inside the WS close path, where a throw failed one
// connection. It now runs from a bare timer with nothing between it and the
// process, and an uncaught exception there is a `launchd` KeepAlive restart —
// EVERY user's live session dropped because one session's teardown threw. Same
// reasoning, same shape as `session-runtime.ts`'s `settle()`, which wraps its
// own detached continuation for exactly this.
//
// RESIDENCY IS CAPPED, because derived retention removed the bound that used to
// exist implicitly. Under "the last one out disposes", resident sessions were
// bounded by live attachments (`max_sessions`, `per_user_max_sessions`). Now a
// session stays resident for `retention_ms` after nothing holds it, and
// `conversation.activate` builds a full session per target — so walking the
// past-chats drawer leaves one resident session per chat visited, each with its
// own `bun:sqlite` handle, `ToolBroker` (with warmed MCP definitions), voice and
// journal. `session.max_idle_resident_sessions` bounds that pool. Only the
// NOT-RETAINED pool is capped, and eviction runs the ordinary `fireDisposal`,
// which re-derives first — so the cap is structurally unable to cut work. The
// alternative considered and rejected was a shorter grace for a residency that
// never did any work: it shrinks the common case but leaves "bounded by what?"
// unanswered, which is the actual gap.

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
  /**
   * Cap on sessions kept resident while NOTHING holds them
   * (`session.max_idle_resident_sessions`). Retained sessions are never
   * counted and never evicted — their own inputs bound them (attachments by
   * `max_sessions`, background work by `tools.max_concurrent_background_tasks`).
   */
  maxIdleResidentSessions: number;
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
  /** When this session last stopped being retained; null while something holds
   *  it. The eviction order under the residency cap — the session that has been
   *  idle longest is closest to its own deadline anyway. */
  notRetainedSinceMs: number | null;
}

function defaultSchedule(fire: () => void, delayMs: number): RetentionTimer {
  const handle = setTimeout(fire, delayMs);
  return { cancel: () => clearTimeout(handle) };
}

export function createSessionRetentionPolicy(options: SessionRetentionPolicyOptions): SessionDisposalPolicy {
  const { retentionMs, recheckIntervalMs, lostTaskThresholdMs, maxIdleResidentSessions } = options;
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
    session.notRetainedSinceMs = null;
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
    session.notRetainedSinceMs = now();
    armTimer(session, "disposal", retentionMs, []);
    enforceResidencyCap();
  }

  /**
   * Hold the idle-residency pool under its cap, oldest-idle first.
   *
   * Only sessions in the grace window are candidates, and each is evicted by
   * running its own `fireDisposal` — which re-derives before it tears anything
   * down. So a session that acquired work since it went idle declines the
   * eviction exactly as it would decline its own timer, and the cap is
   * structurally unable to cut work.
   */
  function enforceResidencyCap(): void {
    const idle = [...tracked.values()]
      .filter((candidate) => candidate.timerKind === "disposal" && candidate.notRetainedSinceMs !== null)
      .sort((a, b) => (a.notRetainedSinceMs ?? 0) - (b.notRetainedSinceMs ?? 0));
    const excess = idle.length - maxIdleResidentSessions;
    if (excess <= 0) return;
    log.info("session-retention.residency-cap", {
      idleResident: idle.length,
      maxIdleResidentSessions,
      evicting: excess,
      reason:
        "more sessions are resident with nothing holding them than the cap allows — releasing the oldest idle first",
    });
    for (const victim of idle.slice(0, excess)) {
      fireDisposal(victim, victim.generation);
    }
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

  /**
   * The ONE boundary where this policy's work is detached — a timer callback
   * has nothing between it and the process, and an uncaught exception under
   * `launchd` KeepAlive restarts the gateway, dropping every OTHER user's live
   * session. Per .claude/rules/error-handling.md the catch belongs here and only
   * here; the bodies below are expected not to throw, which keeps this a
   * backstop that REPORTS an unexpected teardown failure rather than a blanket
   * that hides routine ones. Mirrors `session-runtime.ts`'s `settle()`.
   */
  function guarded(sessionId: string, phase: string, body: () => void): void {
    try {
      body();
    } catch (err) {
      log.error("session-retention.timer-threw", {
        sessionId,
        phase,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function fireRecheck(session: TrackedSession, generation: number): void {
    guarded(session.input.sessionId, "recheck", () => {
      if (session.generation !== generation) return;
      session.timer = null;
      session.timerKind = null;
      derive(session, "recheck-timer");
    });
  }

  function fireDisposal(session: TrackedSession, generation: number): void {
    guarded(session.input.sessionId, "disposal", () => disposeIfStillIdle(session, generation));
  }

  function disposeIfStillIdle(session: TrackedSession, generation: number): void {
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
        notRetainedSinceMs: null,
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
