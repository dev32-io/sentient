import type { TaskMirror } from "../cerebrum/task-mirror.js";
import { getLog } from "../logging/logger.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface BargeInController {
  trigger(): void;
  dispose(): void;
}

export interface BargeInControllerDeps {
  readonly taskMirror: Pick<TaskMirror, "snapshot" | "clearCycle">;
  readonly wire: SessionAudioWire;
  readonly currentCycleId: () => string | null;
  /** Cancels the in-flight TTS run (if any). Hermes cycle keeps running. */
  readonly cancelTts: () => void;
}

/**
 * Barge-in gesture: user speech during TTS. Sends playback.stop with the
 * current cycleId so the client stops audio. Task cancellation is handled
 * by the Hermes dispatch abort path (cycleSlot.cancelCurrent) rather than
 * directly here — barge-in aborts the cycle, and the event translator
 * cleans up running tasks via clearCycle.
 */
export function createBargeInController(deps: BargeInControllerDeps): BargeInController {
  const log = getLog(["sentient", "session-handlers", "barge-in"]);
  let disposed = false;

  return {
    trigger(): void {
      if (disposed) {
        log.debug("skip-disposed", { reason: "controller disposed" });
        return;
      }

      const cycleId = deps.currentCycleId();
      if (!cycleId) {
        log.debug("skip-no-cycle", { reason: "no active cycle — nothing to barge" });
        return;
      }

      log.info("trigger", { cycleId });
      deps.cancelTts();
      log.debug("wire.playback.stop", { cycleId, reason: "barge-in" });
      deps.wire.sendPlaybackStop(cycleId, "barge-in", []);
    },
    dispose(): void {
      disposed = true;
    },
  };
}
