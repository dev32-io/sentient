// What keeps a session resident (session-model spec §5).
//
// DERIVED ON EVERY EVALUATION, NEVER STORED. Nothing here remembers whether
// work is happening; each term is re-read from the thing that owns it — the
// runtime's turn, the broker's foreground call and background registry, the
// session's permission broker. The alternative — one `workInFlight` boolean —
// would be set and cleared at six sites and would eventually leak one, which
// fails in both directions: a set that is never cleared pins a session for the
// life of the process, and a clear that fires early drops one mid-work.
//
// IT RETURNS REASONS, NOT A BOOLEAN. "Why is this session still resident" has
// to be answerable from a log line, or the disposal timer is undebuggable: a
// session that never goes away and a session that goes away too early look
// identical from the outside, and both are single-term bugs.
//
// THE DEFECT THIS CLOSES IS LIVE. `SessionRuntime.dispose()` leaves registered
// background tasks running — NOTHING cancels one, not even interrupt
// (tools/delegate-task.ts) — but it closes the bun:sqlite handle, so the
// completion of a task it left alive can never land. Before this predicate,
// closing the last window on a session ORPHANED a running delegated task: the
// worker finished, its result hit a disposed runtime, and
// `session-runtime.submit.disposed` dropped it.
// `hasUnfinishedBackgroundTask` is a defect gate, not a comfort feature — and
// with no cancel path anywhere, residency is now the WHOLE mechanism standing
// between a delegated task and a lost result.
//
// THE BACKGROUND TERM IS A TIMESTAMP, NOT A BOOLEAN, on the way in. Derivation
// fires on state-change events, and a worker that dies without emitting a
// completion would leave a boolean true forever — the timer would never start
// and the session would never be reclaimed. So the predicate is fed the moment
// the NEWEST still-registered task was registered, and a task older than a
// bounded threshold is treated as LOST: dropped from the predicate and WARNed.
// The newest is the youngest, so "the newest is past the threshold" means every
// registered task is, which is exactly when dropping the term is safe.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "runtime", "session-retention"]);

export type RetentionReason =
  | "hasSubscribers"
  | "isTurnInFlight"
  | "hasPendingForegroundTool"
  | "hasUnfinishedBackgroundTask"
  | "hasOutstandingPrompt"
  | "hasAuxiliaryTaskInFlight";

/**
 * The six terms, as booleans. Named as questions (clean-code rule) because
 * each one is literally the question "does this hold the session".
 */
export type SessionLivenessInputs = {
  readonly [Term in RetentionReason]: boolean;
};

/**
 * What the SESSION can be asked about its own work. Every member is read at
 * access time — the composition root wires them as getters over the runtime,
 * the tool broker and the permission broker — so a reading taken when a
 * disposal timer was armed is never the reading that decides the disposal.
 *
 * `hasSubscribers` is deliberately absent: it belongs to the registry's
 * subscriber set, not to the session's work.
 */
export interface SessionWorkSignals {
  /** A ReAct turn is running (`SessionRuntime.running`). */
  readonly isTurnInFlight: boolean;
  /** A foreground tool call is awaiting its result inside the loop. */
  readonly hasPendingForegroundTool: boolean;
  /** A permission prompt is open and unanswered. */
  readonly hasOutstandingPrompt: boolean;
  /**
   * An auxiliary task (spec §6) is running for this session — session titling
   * today; tags, follow-up suggestions and summarisation as they land.
   *
   * THE ONLY TERM THAT CAN HOLD A SESSION WITH NO TURN RUNNING. An auxiliary
   * task starts from a turn's SETTLE continuation, so `isTurnInFlight` is
   * already false by the time it registers: without this term, the last window
   * closing in the ~1s between the reply and the title disposes the runtime,
   * closes the store handle, and the title lands nowhere.
   */
  readonly hasAuxiliaryTaskInFlight: boolean;
  /**
   * When the MOST RECENTLY registered still-running background task was
   * registered; null when none is. A timestamp rather than a boolean so a task
   * that stops reporting can be bounded in time — see this file's header.
   */
  readonly newestBackgroundTaskStartedAtMs: number | null;
}

/**
 * Every term, in the order reasons are reported, mapped to the copy that
 * explains it in a log line.
 *
 * Declared as a `Record` rather than an array so the compiler REFUSES an
 * incomplete map: a `RetentionReason` nobody listed here would silently never
 * hold a session.
 */
const RETENTION_TERMS: Record<RetentionReason, string> = {
  hasSubscribers: "a window is attached to this session",
  isTurnInFlight: "a ReAct turn is running",
  hasPendingForegroundTool: "a foreground tool call is awaiting its result",
  hasUnfinishedBackgroundTask: "a background task has not reported completion",
  hasOutstandingPrompt: "a permission prompt is open and unanswered",
  hasAuxiliaryTaskInFlight: "an auxiliary task is running",
};

/** Insertion order IS the report order (string keys, ES2015 ordering). */
const TERM_NAMES = Object.keys(RETENTION_TERMS) as RetentionReason[];

/** Every term currently holding [inputs], in declaration order. Empty means
 *  nothing observable is keeping this session alive. */
export function computeRetentionReasons(inputs: SessionLivenessInputs): RetentionReason[] {
  return TERM_NAMES.filter((term) => inputs[term]);
}

/** Whether anything at all holds this session. `reasons.length > 0`, named so
 *  call sites read as the question they are asking. */
export function isRetained(inputs: SessionLivenessInputs): boolean {
  return computeRetentionReasons(inputs).length > 0;
}

/**
 * One line answering "why is this session still resident", for the log. Takes
 * the whole reason list rather than one reason so a caller never has to index
 * into an array it just proved non-empty.
 */
export function describeRetention(reasons: readonly RetentionReason[]): string {
  if (reasons.length === 0) return "nothing observable holds this session";
  return reasons.map((reason) => RETENTION_TERMS[reason]).join("; ");
}

/**
 * The session's work as the predicate's six booleans, with NO staleness
 * correction — a registered background task holds, however old it is.
 *
 * The one place the mapping lives. `createBackgroundTaskWatchdog` is this
 * function plus the correction, so the two can never drift into disagreeing
 * about what a term means.
 */
export function livenessInputsOf(work: SessionWorkSignals, hasSubscribers: boolean): SessionLivenessInputs {
  return {
    hasSubscribers,
    isTurnInFlight: work.isTurnInFlight,
    hasPendingForegroundTool: work.hasPendingForegroundTool,
    hasUnfinishedBackgroundTask: work.newestBackgroundTaskStartedAtMs !== null,
    hasOutstandingPrompt: work.hasOutstandingPrompt,
    hasAuxiliaryTaskInFlight: work.hasAuxiliaryTaskInFlight,
  };
}

// ---------------------------------------------------------------------------
// The lost-task watchdog
// ---------------------------------------------------------------------------

/** A background task old enough that it cannot still be legitimately running. */
export interface LostBackgroundTask {
  /** How long the NEWEST still-registered task has been registered. */
  readonly ageMs: number;
  readonly thresholdMs: number;
  /** Model-free operator copy naming what was dropped and why. */
  readonly reason: string;
}

export interface LivenessObservation {
  /** The six booleans the predicate reads, after the staleness correction. */
  readonly inputs: SessionLivenessInputs;
  /** Non-null on the evaluations where the background term was DROPPED. */
  readonly lostBackgroundTask: LostBackgroundTask | null;
}

export interface BackgroundTaskWatchdog {
  /** Turn one reading of the session's work into the predicate's inputs,
   *  dropping a background term that has gone stale. */
  observe(work: SessionWorkSignals, hasSubscribers: boolean): LivenessObservation;
}

export interface BackgroundTaskWatchdogDeps {
  sessionId: string;
  /**
   * How long a background task may stay registered before it is treated as
   * lost. MUST exceed the longest a task can legitimately run — for
   * `delegateTask` that is `orchestrator.delegation.hermes_timeout_ms`, after
   * which the runner itself kills the child and settles. Anything still
   * registered past this threshold is a bookkeeping leak, not work.
   */
  thresholdMs: number;
  /** Injectable clock — this is an FSM worth testing without wall-clock
   *  sleeps. Defaults to `Date.now`. */
  now?: () => number;
}

export function createBackgroundTaskWatchdog(deps: BackgroundTaskWatchdogDeps): BackgroundTaskWatchdog {
  const { sessionId, thresholdMs } = deps;
  const now = deps.now ?? (() => Date.now());
  // The registration stamp already WARNed about. Re-derivation runs on a timer,
  // so without this a lost task would log once per re-check forever; with it,
  // a genuinely new task (a different stamp) still warns on its own.
  let warnedForStartedAtMs: number | null = null;

  return {
    observe(work: SessionWorkSignals, hasSubscribers: boolean): LivenessObservation {
      const startedAtMs = work.newestBackgroundTaskStartedAtMs;
      const ageMs = startedAtMs === null ? null : now() - startedAtMs;
      const isLost = ageMs !== null && ageMs >= thresholdMs;

      let lostBackgroundTask: LostBackgroundTask | null = null;
      if (isLost && ageMs !== null) {
        lostBackgroundTask = {
          ageMs,
          thresholdMs,
          reason:
            "background task lost — nothing has reported completion within the threshold, so it no longer holds this session resident",
        };
        if (warnedForStartedAtMs !== startedAtMs) {
          warnedForStartedAtMs = startedAtMs;
          log.warn("session-retention.background-task-lost", {
            sessionId,
            ageMs,
            thresholdMs,
            reason: lostBackgroundTask.reason,
          });
        }
      } else if (!isLost) {
        warnedForStartedAtMs = null;
      }

      const base = livenessInputsOf(work, hasSubscribers);
      return {
        inputs: isLost ? { ...base, hasUnfinishedBackgroundTask: false } : base,
        lostBackgroundTask,
      };
    },
  };
}
