// ---------------------------------------------------------------------------
// PresenceCoordinator — owns the presence wiring for the SentientSDK and
// translates WS message types into notify* calls. Also tracks the
// "idle-closed" flag so the SDK can decide whether to reconnect on presence
// return (only reconnect if we closed because of idle, not because the
// consumer called disconnect()).
//
// Level-based wiring: the coordinator maps turn/TTS message pairs to explicit
// start/end signals. The detector owns a suppression flag for each pair and
// cannot enter idle while either flag is set — so a long stretch of silence
// between TTS frames mid-reply no longer risks an idle-close. Binary audio
// frames are intentionally NOT notified here: the `turn.audio.start` /
// `turn.audio.done` start/end pair plus level-based suppression already holds
// the idle timer for the entire TTS stream, and per-frame notifies would just
// be noise.
//
// Keeps `sentient-sdk.ts` focused on WS/status coordination and under the
// 300-line clean-code budget.
// ---------------------------------------------------------------------------

import type {
  IdlePresenceConfig,
  PresenceWiring,
  PresenceWiringFactory,
  PresenceWiringHooks,
} from "../connector-types.ts";
import { createLogger } from "../logger.ts";
import { createPresenceWiring } from "./presence-wiring.ts";

/** WS message types that mark the start / end of an assistant turn (2.0 wire). */
const TURN_START_TYPES = new Set<string>(["turn.started"]);
const TURN_END_TYPES = new Set<string>(["turn.completed", "turn.aborted"]);
/** WS message types that mark the start / end of TTS playback (2.0 wire). */
const TTS_START_TYPES = new Set<string>(["turn.audio.start"]);
const TTS_END_TYPES = new Set<string>(["turn.audio.done"]);

export interface PresenceCoordinatorHooks {
  /** SDK should close the WS with idle-timeout semantics. */
  onIdleClose(): void;
  /** SDK should reconnect. Called only when coordinator believes we were idle-closed. */
  onReconnect(): void;
}

export interface PresenceCoordinator {
  /** Forward a WS JSON message type into the detector (routes to turn/TTS start/end). */
  notifyForType(type: string): void;
  /**
   * Consumer escape hatch — forces the detector to stay out of idle until the
   * returned function is called. Safe to call before or after the WS is open;
   * multiple parallel demands all must release before suppression lifts.
   */
  acquireDemandStay(): () => void;
  /** Mark the coordinator as having issued an idle-driven close; guards reconnect. */
  markIdleClosed(): void;
  /** Clear the idle-closed flag. Called on successful connect / consumer disconnect. */
  clearIdleClosed(): void;
  /** True when the last close was presence-driven and the SDK should reconnect on presence return. */
  isIdleClosed(): boolean;
  /** Release DOM listeners and timers. */
  dispose(): void;
}

const log = createLogger(["sentient", "presence", "coordinator"]);

export function createPresenceCoordinator(
  config: IdlePresenceConfig,
  hooks: PresenceCoordinatorHooks,
  factory?: PresenceWiringFactory,
): PresenceCoordinator {
  let idleClosed = false;
  let disposed = false;
  let wiring: PresenceWiring | null = null;

  const wiringHooks: PresenceWiringHooks = {
    onIdle: () => {
      if (disposed) return;
      log.debug("onIdle → SDK close");
      idleClosed = true;
      hooks.onIdleClose();
    },
    onPresenceReturn: () => {
      if (disposed) return;
      if (!idleClosed) {
        log.debug("presence return ignored — not idle-closed");
        return;
      }
      log.debug("onPresenceReturn → SDK reconnect");
      idleClosed = false;
      hooks.onReconnect();
    },
  };

  const buildFactory: PresenceWiringFactory = factory ?? defaultFactory;
  wiring = buildFactory(config, wiringHooks);

  return {
    notifyForType(type) {
      if (disposed || wiring === null) return;
      if (TURN_START_TYPES.has(type)) {
        wiring.notifyCycleStart();
        return;
      }
      if (TURN_END_TYPES.has(type)) {
        wiring.notifyCycleEnd();
        return;
      }
      if (TTS_START_TYPES.has(type)) {
        wiring.notifyTtsStart();
        return;
      }
      if (TTS_END_TYPES.has(type)) {
        wiring.notifyTtsEnd();
      }
    },
    acquireDemandStay() {
      if (disposed || wiring === null) return noopRelease;
      return wiring.acquireDemandStay();
    },
    markIdleClosed() {
      idleClosed = true;
    },
    clearIdleClosed() {
      idleClosed = false;
    },
    isIdleClosed() {
      return idleClosed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      log.debug("dispose");
      wiring?.dispose();
      wiring = null;
    },
  };
}

const noopRelease = (): void => {};

const defaultFactory: PresenceWiringFactory = (cfg, hooks) => {
  const detector =
    cfg.warningThresholdMs === undefined
      ? { idleThresholdMs: cfg.idleThresholdMs }
      : { idleThresholdMs: cfg.idleThresholdMs, warningThresholdMs: cfg.warningThresholdMs };
  return createPresenceWiring({
    detector,
    presence: { tickIntervalMs: cfg.tickIntervalMs },
    onIdle: hooks.onIdle,
    onPresenceReturn: hooks.onPresenceReturn,
  });
};
