// ---------------------------------------------------------------------------
// PresenceWiring — glue between PresenceSource and IdleDetector.
//
// The IdleDetector is a pure state machine; the PresenceSource is a DOM
// signal aggregator. Neither knows about the other. This module owns both,
// routes signals into the detector (forwarding the ticker's `tick` to
// `detector.handle` with the monotonic clock), and translates detector state
// transitions into two high-level callbacks that `SentientSDK` cares about:
//
//   onIdle            — detector just entered `idle`. SDK should close WS.
//   onPresenceReturn  — detector just exited `idle` (reset). SDK should
//                       reconnect IF it was previously idle-closed.
//
// Why we observe detector transitions rather than signals directly:
// "presence returns" is not the same as "interaction event". A user can wiggle
// the mouse while still within the active window — no reconnect needed. The
// detector's `idle → active` edge is the unambiguous signal.
//
// Why onPresenceReturn AND onIdle in this one module: the SDK should not have
// to track "were we idle?" itself — that's a property of the state machine
// and belongs next to it. Keeps `sentient-sdk.ts` under 300 lines.
//
// Testability: the module accepts pre-built detector + source instances via
// factory callbacks so the SDK can inject test doubles without reaching into
// this file. The factories are called exactly once during `createPresenceWiring`.
// ---------------------------------------------------------------------------

import type { IdlePresenceConfig } from "../connector-types.ts";
import { createLogger } from "../logger.ts";
import {
  type IdleDetector,
  type IdleDetectorConfig,
  type IdleDetectorState,
  createIdleDetector,
} from "./idle-detector.ts";
import {
  type PresenceEventKind,
  type PresenceSource,
  type PresenceSourceConfig,
  createPresenceSource,
} from "./presence-source.ts";

/** Subset of `PresenceSourceConfig` that the wiring controls — the rest is caller-supplied. */
export interface PresenceWiringPresenceOptions extends Omit<PresenceSourceConfig, "onSignal"> {}

export interface PresenceWiringConfig {
  /** Idle detector config — forwarded to `createIdleDetector`. */
  readonly detector: IdleDetectorConfig;
  /** Presence source config — forwarded to `createPresenceSource`. `onSignal` is supplied by this module. */
  readonly presence: PresenceWiringPresenceOptions;
  /** Called on each `idle → active` detector transition (user returned). */
  readonly onPresenceReturn: () => void;
  /** Called on each `* → idle` detector transition (detector timed out). */
  readonly onIdle: () => void;
  /**
   * Factory for the detector. Defaults to `createIdleDetector`. Injectable
   * for tests that want to assert on the exact event stream the wiring
   * forwards.
   */
  readonly createDetector?: (config: IdleDetectorConfig) => IdleDetector;
  /**
   * Factory for the presence source. Defaults to `createPresenceSource`.
   * Injectable so tests (and eventually non-browser runtimes) can skip DOM
   * entirely.
   */
  readonly createSource?: (config: PresenceSourceConfig) => PresenceSource;
}

/**
 * Minimal contract the SDK needs from its presence-wiring dependency. The
 * production implementation (`createPresenceWiring` below) owns an IdleDetector
 * + PresenceSource and exposes only these notification hooks. Kept next to the
 * factory and its hook/factory sibling types so the shape and its consumers
 * stay in one place.
 */
export interface PresenceWiring {
  /** Forward a cognitive-cycle start into the detector (sets cycleActive flag). */
  notifyCycleStart(): void;
  /** Forward a cognitive-cycle end into the detector (clears cycleActive flag). */
  notifyCycleEnd(): void;
  /** Forward a TTS-playback start into the detector (sets ttsActive flag). */
  notifyTtsStart(): void;
  /** Forward a TTS-playback end into the detector (clears ttsActive flag). */
  notifyTtsEnd(): void;
  /** Forward a mic-onset signal into the detector. */
  notifyMicOnset(): void;
  /**
   * Consumer escape hatch — forces the detector to stay out of idle until the
   * returned function is called. Multiple demands all must release for
   * suppression to lift. Idempotent: the returned release fn is safe to call
   * more than once.
   */
  acquireDemandStay(): () => void;
  /** Release DOM listeners, stop the ticker, drop detector transition listeners. */
  dispose(): void;
}

/** Hooks the SDK provides to the wiring so wiring can drive WS lifecycle. */
export interface PresenceWiringHooks {
  onIdle(): void;
  onPresenceReturn(): void;
}

/** Factory type for injection — the SDK builds a wiring via this signature. */
export type PresenceWiringFactory = (config: IdlePresenceConfig, hooks: PresenceWiringHooks) => PresenceWiring;

const log = createLogger(["sentient", "presence", "wiring"]);

export function createPresenceWiring(config: PresenceWiringConfig): PresenceWiring {
  const detector = (config.createDetector ?? createIdleDetector)(config.detector);
  const now = config.presence.now ?? (() => Date.now());

  // Seed `lastResetAtMs` to construction time. The detector's documented
  // precondition (idle-detector.ts header, "PRECONDITION — INITIAL
  // lastResetAtMs") puts the burden on the wiring: without this seed, the
  // first 30s tick under a typical `Date.now()` clock classifies as idle
  // because elapsed = nowMs - 0 = nowMs, which is wildly past any threshold.
  // A construction-time `interaction` reset anchors the timer to "now".
  detector.handle({ kind: "interaction", nowMs: now() });

  let disposed = false;
  let lastState: IdleDetectorState = detector.snapshot().state;

  const source = (config.createSource ?? createPresenceSource)({
    ...config.presence,
    onSignal: (kind: PresenceEventKind) => {
      if (disposed) return;
      log.debug("signal routed", { kind });
      detector.handle({ kind, nowMs: now() });
    },
  });

  const unsubscribe = detector.onStateChange((snap) => {
    const prev = lastState;
    const next = snap.state;
    lastState = next;
    if (prev === next) return;
    if (next === "idle") {
      log.debug("entered idle — invoking onIdle");
      config.onIdle();
      return;
    }
    if (prev === "idle") {
      log.debug("left idle — invoking onPresenceReturn");
      config.onPresenceReturn();
    }
  });

  return {
    notifyCycleStart() {
      source.notifyCycleStart();
    },
    notifyCycleEnd() {
      source.notifyCycleEnd();
    },
    notifyTtsStart() {
      source.notifyTtsStart();
    },
    notifyTtsEnd() {
      source.notifyTtsEnd();
    },
    notifyMicOnset() {
      source.notifyMicOnset();
    },
    acquireDemandStay() {
      return detector.acquireDemandStay();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      log.debug("dispose");
      unsubscribe();
      source.dispose();
    },
  };
}
