import type { TaskMirror } from "../cerebrum/task-mirror.js";
import { getLog } from "../logging/logger.js";
import type { AbortSlot } from "./abort-slot.js";
import type { SessionAudioWire } from "./session-audio-wire.js";

export interface InterruptController {
  trigger(): void;
}

export interface InterruptControllerDeps {
  readonly cycleSlot: AbortSlot;
  readonly taskMirror: Pick<TaskMirror, "clearCycle">;
  readonly wire: SessionAudioWire;
  /**
   * Narrow interface to the AttentionGate. Called unconditionally on every
   * interrupt to drop any queued conversation signals so they don't fire a
   * new cycle after the interrupt completes. Ambient/sensor signals are
   * preserved inside the gate — only conversation-sourced salience is dropped.
   */
  readonly attentionGate: { clearPendingConversationSalience(): void };
}

/**
 * Interrupt gesture: user Stop button or Esc. Full hard stop.
 * Composition: cycle cancel + task cancel + wire playback.stop.
 * In the Hermes architecture, task cleanup is handled by clearCycle which
 * cancels orphaned running tasks for the aborted cycle.
 */
export function createInterruptController(deps: InterruptControllerDeps): InterruptController {
  const log = getLog(["sentient", "session-handlers", "interrupt"]);
  return {
    trigger(): void {
      const cycleId = deps.cycleSlot.currentId();
      log.info("trigger", {
        cycleId,
        reason: "user-interrupt",
        hadActiveCycle: cycleId !== null,
      });
      if (cycleId !== null) {
        deps.cycleSlot.cancelCurrent("interrupt");
        // Cancel all running tasks for this cycle — the Hermes event
        // translator won't emit completion events for an aborted cycle.
        deps.taskMirror.clearCycle(cycleId);
      }
      // Always clear pending conversation salience so a new message the user
      // types right after Stop doesn't pile up against a half-accumulated
      // pre-interrupt signal.
      deps.attentionGate.clearPendingConversationSalience();
      // Always emit playback.stop, even with no active cycle on the gateway.
      // Why: if browser-side audio playback is wedged (iOS Safari can leave a
      // suspended AudioContext + queued sources after a backgrounded tab) the
      // user pressing Stop is the only signal the SDK has to flush its queue.
      // Without this, the gateway is "idle" yet the bubble's speaking-wave
      // animation never clears, and the Stop button looks dead. The cycleId
      // is "" when there's no active cycle — the SDK's `onPlaybackStop` and
      // the connector's `playback.stop` handler both treat that as a generic
      // flush request, which is exactly what we want here.
      log.debug("wire.playback.stop", { cycleId: cycleId ?? "", reason: "interrupt" });
      deps.wire.sendPlaybackStop(cycleId ?? "", "interrupt", []);
    },
  };
}
