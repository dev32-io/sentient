// ---------------------------------------------------------------------------
// IdleDetector — pure state machine tracking client-side user presence.
//
// PROBLEM
// -------
// The web SDK keeps a WebSocket open whenever the user might speak. Left
// unchecked, a tab in a background window holds the socket open (and a
// PersonSession warm on the gateway) forever. We want the client to close
// the WS after ~1 hour of no interaction so the gateway can release the
// session — without losing the session during normal silence within a
// conversation. A pure state machine captures that policy cleanly; timer
// plumbing and DOM listeners live above this module (Task 1.2 / 1.3).
//
// DESIGN
// ------
// Three states:
//
//   active   — most recent reset is within `warningThresholdMs` of "now".
//   warning  — `warningThresholdMs` elapsed but `idleThresholdMs` has not.
//              Reserved for future "about to disconnect" UI signalling;
//              today it is just an instrumentation hook.
//   idle     — `idleThresholdMs` elapsed since last reset. Consumers use
//              this to close the WebSocket.
//
// Events:
//
//   interaction   — DOM input or other direct user signal. Resets the timer.
//   cycle.start   — a cognitive cycle started (assistant is thinking).
//                   Resets the timer AND flips a level-based suppression
//                   flag so the detector cannot enter idle while the cycle
//                   is in flight, regardless of tick cadence.
//   cycle.end     — the cycle finished / aborted. Clears the flag and
//                   treats the end itself as activity (resets the timer).
//   tts.start     — TTS playback started. Same flag semantics as cycle.start.
//   tts.end       — TTS playback ended. Same as cycle.end.
//   tick          — advance time. The caller passes the current monotonic
//                   clock reading (`nowMs`) and the machine compares it
//                   against the last reset to decide the new state. Ticks
//                   that would transition the machine to `idle` are
//                   clamped to `warning` while any suppression flag is set.
//
// We accept `nowMs` (absolute monotonic timestamp) rather than elapsed
// deltas. This keeps the arithmetic simple ("now - lastResetAt"), avoids
// drift when multiple tickers fire, and makes replay trivial in tests.
//
// Ticks that go backwards in time (nowMs < lastResetAt) are ignored —
// monotonicity is a precondition callers are expected to honour, but we
// still fail safe rather than transitioning on garbage.
//
// LEVEL-BASED SUPPRESSION (Task 1.4)
// ----------------------------------
// Two activity flags (`cycleActive`, `ttsActive`) plus one consumer-driven
// counter (`demandStayCount`) block the `idle` transition. While any of
// them is set, ticks across the idle threshold classify as `warning`
// rather than `idle`. The flags are level-driven: `cycle.start` /
// `cycle.end` and `tts.start` / `tts.end` come in pairs from the wiring
// layer. `demandStayCount` is incremented by `acquireDemandStay()` (the
// public SDK escape hatch) and decremented by the returned release fn;
// it's a counter so nested / parallel demands all must release.
//
// PRECONDITION — INITIAL lastResetAtMs
// ------------------------------------
// The internal anchor `lastResetAtMs` starts at 0, i.e. the machine behaves
// as if a reset happened at t=0. If the caller's monotonic clock does not
// start at 0 (e.g. `performance.now()` returns a large launch-relative
// value), the first `tick` before any presence-event will classify as
// `idle`. The wiring layer (Task 1.2) is expected to fire a reset event at
// construction, or otherwise keep the first tick within the warning
// threshold of t=0.
//
// PLATFORM PORTING
// ----------------
// Zero DOM, zero `Date.now()`, zero timer APIs — a native port reuses this
// module verbatim, feeding it readings from `SystemClock.uptimeMillis()` /
// `CACurrentMediaTime()`. The DOM listener layer is not portable; re-author
// it per platform (Android `ActivityLifecycleCallbacks`, iOS
// `UIApplication` notifications, etc). The future wiring into
// `SentientSDKConfig` (see connector-types.ts) happens in Task 1.3 — the
// SDK will forward its `idleThresholdMs` down into `createIdleDetector`.
//
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.ts";

/** Minimum viable idle threshold. Below this, tests can't observe warnings distinctly and production misfires on GC pauses. */
export const MINIMUM_IDLE_THRESHOLD_MS = 30_000;

/** Default fraction of the idle threshold at which we enter the `warning` state. */
export const DEFAULT_WARNING_FRACTION = 0.9;

export type IdleDetectorState = "active" | "warning" | "idle";

export type IdleDetectorEvent =
  | { readonly kind: "interaction"; readonly nowMs: number }
  | { readonly kind: "cycle.start"; readonly nowMs: number }
  | { readonly kind: "cycle.end"; readonly nowMs: number }
  | { readonly kind: "tts.start"; readonly nowMs: number }
  | { readonly kind: "tts.end"; readonly nowMs: number }
  | { readonly kind: "tick"; readonly nowMs: number };

export interface IdleDetectorConfig {
  /** Ms of inactivity after which the client should disconnect. Must be >= {@link MINIMUM_IDLE_THRESHOLD_MS}. */
  readonly idleThresholdMs: number;
  /** Ms of inactivity after which the detector enters `warning`. Defaults to 90% of `idleThresholdMs`. Must be in [0, idleThresholdMs). */
  readonly warningThresholdMs?: number;
}

export interface IdleDetectorSnapshot {
  readonly state: IdleDetectorState;
  readonly idleThresholdMs: number;
  readonly warningThresholdMs: number;
  /** Monotonic `nowMs` the machine last reset at. 0 at construction. */
  readonly lastResetAtMs: number;
  /** Level-based suppression: a cognitive cycle is in flight. */
  readonly cycleActive: boolean;
  /** Level-based suppression: TTS is actively playing. */
  readonly ttsActive: boolean;
  /** Consumer-driven suppression counter (see {@link IdleDetector.acquireDemandStay}). */
  readonly demandStayCount: number;
}

export interface IdleDetector {
  /** Feed an event. Returns the post-event state. */
  handle(event: IdleDetectorEvent): IdleDetectorState;
  /** Current snapshot — immutable copy safe to pass to listeners / UI. */
  snapshot(): IdleDetectorSnapshot;
  /** Subscribe to state transitions. Returns an unsubscribe callback. */
  onStateChange(listener: (snap: IdleDetectorSnapshot) => void): () => void;
  /**
   * Consumer escape hatch. Increments an internal counter; while the counter
   * is > 0 the detector cannot enter `idle` (ticks clamp to `warning`). The
   * returned function decrements the counter exactly once — further calls are
   * safe no-ops. Nested / parallel demands all must release for suppression
   * to lift.
   */
  acquireDemandStay(): () => void;
}

const log = createLogger(["sentient", "presence", "idle-detector"]);

export function createIdleDetector(config: IdleDetectorConfig): IdleDetector {
  validateConfig(config);

  const idleThresholdMs = config.idleThresholdMs;
  const warningThresholdMs = config.warningThresholdMs ?? Math.floor(idleThresholdMs * DEFAULT_WARNING_FRACTION);

  const listeners = new Set<(snap: IdleDetectorSnapshot) => void>();

  let state: IdleDetectorState = "active";
  let lastResetAtMs = 0;
  let cycleActive = false;
  let ttsActive = false;
  let demandStayCount = 0;

  function snapshot(): IdleDetectorSnapshot {
    return {
      state,
      idleThresholdMs,
      warningThresholdMs,
      lastResetAtMs,
      cycleActive,
      ttsActive,
      demandStayCount,
    };
  }

  function isSuppressed(): boolean {
    return cycleActive || ttsActive || demandStayCount > 0;
  }

  function setState(next: IdleDetectorState, nowMs: number): void {
    if (state === next) return;
    const prev = state;
    state = next;
    log.debug("state transition", { from: prev, to: next, nowMs, lastResetAtMs });
    const snap = snapshot();
    for (const l of listeners) l(snap);
  }

  function reset(nowMs: number): void {
    lastResetAtMs = nowMs;
    setState("active", nowMs);
  }

  function advance(nowMs: number): void {
    if (nowMs < lastResetAtMs) {
      // Non-monotonic input — refuse to retroactively drive the machine.
      log.debug("ignoring non-monotonic tick", { nowMs, lastResetAtMs });
      return;
    }
    const elapsed = nowMs - lastResetAtMs;
    const natural = classifyElapsed(elapsed, warningThresholdMs, idleThresholdMs);
    const effective = suppressIdle(natural);
    if (effective !== natural) {
      log.debug("suppressed-tick-ignored", { nowMs, elapsed, cycleActive, ttsActive, demandStayCount });
    }
    setState(effective, nowMs);
  }

  function suppressIdle(natural: IdleDetectorState): IdleDetectorState {
    if (natural !== "idle") return natural;
    if (!isSuppressed()) return natural;
    return "warning";
  }

  function applyEvent(event: IdleDetectorEvent): void {
    switch (event.kind) {
      case "tick":
        advance(event.nowMs);
        return;
      case "cycle.start":
        log.debug("cycle-start", { nowMs: event.nowMs });
        cycleActive = true;
        reset(event.nowMs);
        return;
      case "cycle.end":
        log.debug("cycle-end", { nowMs: event.nowMs });
        cycleActive = false;
        reset(event.nowMs);
        return;
      case "tts.start":
        log.debug("tts-start", { nowMs: event.nowMs });
        ttsActive = true;
        reset(event.nowMs);
        return;
      case "tts.end":
        log.debug("tts-end", { nowMs: event.nowMs });
        ttsActive = false;
        reset(event.nowMs);
        return;
      case "interaction":
        reset(event.nowMs);
        return;
    }
  }

  return {
    handle(event) {
      applyEvent(event);
      return state;
    },
    snapshot,
    onStateChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquireDemandStay() {
      demandStayCount++;
      log.debug("demand-stay", { demandStayCount });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        demandStayCount--;
        log.debug("demand-release", { demandStayCount });
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — extracted to keep createIdleDetector short and the classification
// rule trivially auditable.
// ---------------------------------------------------------------------------

function validateConfig(config: IdleDetectorConfig): void {
  if (config.idleThresholdMs < MINIMUM_IDLE_THRESHOLD_MS) {
    throw new Error(
      `IdleDetector: idleThresholdMs must be >= ${MINIMUM_IDLE_THRESHOLD_MS}, got ${config.idleThresholdMs}`,
    );
  }
  if (config.warningThresholdMs !== undefined) {
    if (config.warningThresholdMs < 0) {
      throw new Error(`IdleDetector: warningThresholdMs must be >= 0, got ${config.warningThresholdMs}`);
    }
    if (config.warningThresholdMs >= config.idleThresholdMs) {
      throw new Error(
        `IdleDetector: warningThresholdMs (${config.warningThresholdMs}) must be < idleThresholdMs (${config.idleThresholdMs})`,
      );
    }
  }
}

function classifyElapsed(elapsed: number, warningThresholdMs: number, idleThresholdMs: number): IdleDetectorState {
  if (elapsed >= idleThresholdMs) return "idle";
  if (elapsed >= warningThresholdMs) return "warning";
  return "active";
}
