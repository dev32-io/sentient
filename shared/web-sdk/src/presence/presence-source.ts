// ---------------------------------------------------------------------------
// PresenceSource — DOM + SDK signal aggregator for the idle detector.
//
// The IdleDetector is a pure state machine. This module translates real-world
// signals into its event vocabulary and keeps its clock advancing.
//
// Signals:
//   pointerdown / keydown / focus (window)         → interaction
//   visibilitychange (document), state==='visible' → interaction
//                                  state==='hidden' → no-op (absence, not a signal)
//   blur (window)                                   → subscribed but no-op
//                                                     (reserved for future "left"
//                                                     signal; blur is the opposite
//                                                     of presence, so it must NOT
//                                                     reset the idle timer here).
//   notifyCycleStart() / notifyCycleEnd()           → cycle.start / cycle.end
//   notifyTtsStart()   / notifyTtsEnd()             → tts.start   / tts.end
//                                                     (level-based — the detector
//                                                     sets a suppression flag
//                                                     between start and end so
//                                                     idle cannot fire during a
//                                                     quiet stretch in the middle
//                                                     of a cycle / TTS stream.)
//   notifyMicOnset()                                → interaction (user-originated)
//   periodic ticker                                 → tick
//
// Shape. We pass a callback `onSignal(kind)` rather than a direct IdleDetector
// reference — the source doesn't own the detector's lifecycle, and this matches
// the echo-gate convention (inject behaviours, not concretes). Task 1.3 will
// own the detector and supply a thin forwarding callback.
//
// DOM target split. `visibilitychange` fires on `document`, everything else on
// `window` (per MDN / WHATWG). Both targets are injectable so tests can pass
// shape-only mocks and non-browser runtimes can supply platform equivalents.
//
// Scheduler + clock. Same pattern as echo-gate: `schedule(ms, fn) → handle` /
// `cancel(handle)` and a `now()` reader. The ticker chains one-shot timeouts
// (not setInterval) so cancellation is deterministic under the fake scheduler.
//
// Dispose is idempotent; removes every listener by reference, cancels the
// pending tick, and flips `disposed` so post-dispose notify*/emits are no-ops.
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.ts";
import type { IdleDetectorEvent } from "./idle-detector.ts";

/**
 * Event kinds forwarded to the idle detector. Anchored to
 * `IdleDetectorEvent["kind"]` so the two modules share a single source of
 * truth — adding a kind in one place is a compile error at the other.
 */
export type PresenceEventKind = IdleDetectorEvent["kind"];

/** Injectable scheduler — lets tests run deterministically without fake timers. */
export interface PresenceScheduler {
  schedule(ms: number, fn: () => void): PresenceTimerHandle;
  cancel(handle: PresenceTimerHandle): void;
}
export type PresenceTimerHandle = unknown;

/** Default scheduler backed by setTimeout/clearTimeout for production use. */
export const defaultPresenceScheduler: PresenceScheduler = {
  schedule(ms, fn) {
    return setTimeout(fn, ms);
  },
  cancel(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

export interface PresenceSourceConfig {
  /** Called once per real-world signal with the event kind for the idle detector. */
  readonly onSignal: (kind: PresenceEventKind) => void;
  /** Period of the internal ticker. Must be > 0. Typical: 1_000 ms. */
  readonly tickIntervalMs: number;
  /** Monotonic-ish clock reader. Defaults to `() => Date.now()`. */
  readonly now?: () => number;
  /** EventTarget for pointer / key / focus / blur. Defaults to `globalThis.window`. */
  readonly windowTarget?: EventTarget;
  /** EventTarget for `visibilitychange`. Defaults to `globalThis.document`. */
  readonly documentTarget?: EventTarget;
  /** Returns the current document visibility. Defaults to reading `document.visibilityState`. */
  readonly visibilityState?: () => DocumentVisibilityState;
  /** Injectable scheduler. Defaults to setTimeout/clearTimeout. */
  readonly scheduler?: PresenceScheduler;
}

export interface PresenceSource {
  notifyCycleStart(): void;
  notifyCycleEnd(): void;
  notifyTtsStart(): void;
  notifyTtsEnd(): void;
  notifyMicOnset(): void;
  dispose(): void;
}

const log = createLogger(["sentient", "presence", "presence-source"]);

/** DOM event name for the window-focus signal. */
const EVT_FOCUS = "focus";
/** DOM event name for the window-blur signal (subscribed but intentionally ignored). */
const EVT_BLUR = "blur";
/** DOM event name for pointer-press input. */
const EVT_POINTERDOWN = "pointerdown";
/** DOM event name for keyboard input. */
const EVT_KEYDOWN = "keydown";
/** DOM event name for document visibility transitions. */
const EVT_VISIBILITYCHANGE = "visibilitychange";

export function createPresenceSource(config: PresenceSourceConfig): PresenceSource {
  if (!(config.tickIntervalMs > 0)) {
    throw new Error(`PresenceSource: tickIntervalMs must be > 0, got ${config.tickIntervalMs}`);
  }

  const windowTarget = resolveWindowTarget(config.windowTarget);
  const documentTarget = resolveDocumentTarget(config.documentTarget);
  const visibilityState = config.visibilityState ?? defaultVisibilityState;
  const scheduler = config.scheduler ?? defaultPresenceScheduler;
  const now = config.now ?? (() => Date.now());

  let disposed = false;
  let tickHandle: PresenceTimerHandle | null = null;

  function emit(kind: PresenceEventKind): void {
    if (disposed) return;
    log.debug("signal fired", { kind });
    config.onSignal(kind);
  }

  const onInteractionDom = (event: Event): void => {
    if (disposed) return;
    log.debug("dom interaction", { type: event.type });
    emit("interaction");
  };

  const onBlurDom = (event: Event): void => {
    // Intentional no-op at this layer. See module header.
    log.debug("dom blur ignored", { type: event.type });
  };

  const onVisibilityChange = (): void => {
    if (disposed) return;
    const state = visibilityState();
    log.debug("visibilitychange", { state });
    if (state === "visible") emit("interaction");
  };

  const dispatchTick = (): void => {
    if (disposed) return;
    tickHandle = null;
    const nowMs = now();
    log.debug("tick", { nowMs });
    emit("tick");
    scheduleNextTick();
  };

  function scheduleNextTick(): void {
    if (disposed) return;
    tickHandle = scheduler.schedule(config.tickIntervalMs, dispatchTick);
  }

  // --- Subscribe ---------------------------------------------------------
  log.debug("subscribing", { tickIntervalMs: config.tickIntervalMs });
  windowTarget.addEventListener(EVT_POINTERDOWN, onInteractionDom);
  windowTarget.addEventListener(EVT_KEYDOWN, onInteractionDom);
  windowTarget.addEventListener(EVT_FOCUS, onInteractionDom);
  windowTarget.addEventListener(EVT_BLUR, onBlurDom);
  documentTarget.addEventListener(EVT_VISIBILITYCHANGE, onVisibilityChange);
  scheduleNextTick();

  return {
    notifyCycleStart() {
      emit("cycle.start");
    },
    notifyCycleEnd() {
      emit("cycle.end");
    },
    notifyTtsStart() {
      emit("tts.start");
    },
    notifyTtsEnd() {
      emit("tts.end");
    },
    notifyMicOnset() {
      emit("interaction");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      log.debug("dispose");
      windowTarget.removeEventListener(EVT_POINTERDOWN, onInteractionDom);
      windowTarget.removeEventListener(EVT_KEYDOWN, onInteractionDom);
      windowTarget.removeEventListener(EVT_FOCUS, onInteractionDom);
      windowTarget.removeEventListener(EVT_BLUR, onBlurDom);
      documentTarget.removeEventListener(EVT_VISIBILITYCHANGE, onVisibilityChange);
      if (tickHandle !== null) {
        scheduler.cancel(tickHandle);
        tickHandle = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults — resolved lazily so this module can be imported in non-browser
// runtimes (tests, tooling) without throwing at load time. A missing target
// in production is a programmer error, so we throw loudly there.
// ---------------------------------------------------------------------------

function resolveWindowTarget(explicit: EventTarget | undefined): EventTarget {
  if (explicit) return explicit;
  const win = (globalThis as { window?: EventTarget }).window;
  if (!win) {
    throw new Error("PresenceSource: no windowTarget supplied and globalThis.window is undefined");
  }
  return win;
}

function resolveDocumentTarget(explicit: EventTarget | undefined): EventTarget {
  if (explicit) return explicit;
  const doc = (globalThis as { document?: EventTarget }).document;
  if (!doc) {
    throw new Error("PresenceSource: no documentTarget supplied and globalThis.document is undefined");
  }
  return doc;
}

function defaultVisibilityState(): DocumentVisibilityState {
  const doc = (globalThis as { document?: { visibilityState?: DocumentVisibilityState } }).document;
  return doc?.visibilityState ?? "visible";
}
