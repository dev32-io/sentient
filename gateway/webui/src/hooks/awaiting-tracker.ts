import { createLogger } from "@sentient/web-sdk";
import { AWAITING_GRACE_MS } from "../constants.ts";

const log = createLogger(["sentient", "webui", "awaiting-tracker"]);

/**
 * Tracks whether the Interrupt button should be visible as a bridge between
 * the moment the user hits Send and the moment audio playback takes over
 * (or the turn ends without audio).
 *
 * State transitions:
 *   - `arm()` on sendText — flag flips on.
 *   - `onCognitionIdle(audioPlaying)` — turn.completed arrived. If audio
 *     isn't already playing, start a grace timer; when it fires we disarm.
 *     Covers text-only replies.
 *   - `onCognitionActive()` — a turn is running again (thinking/acting) or
 *     a ReAct continuation started. Cancel any pending grace timer.
 *   - `onAudioStart()` — TTS began; audio-playing state takes over the
 *     "still speaking" visibility from here.
 *   - `onPlaybackEnded()` — playback drained, barge-in, or interrupt. Turn
 *     is fully over; disarm.
 */
export interface AwaitingTracker {
  isAwaiting(): boolean;
  arm(): void;
  onCognitionIdle(isAudioPlaying: boolean): void;
  onCognitionActive(): void;
  onAudioStart(): void;
  onPlaybackEnded(): void;
  dispose(): void;
}

export interface AwaitingTrackerOptions {
  /** Fired whenever `isAwaiting()` transitions (true→false or false→true). */
  onChange(): void;
  /** Override for tests. Defaults to AWAITING_GRACE_MS. */
  graceMs?: number;
}

export function createAwaitingTracker(options: AwaitingTrackerOptions): AwaitingTracker {
  const graceMs = options.graceMs ?? AWAITING_GRACE_MS;
  let armed = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelGraceTimer(): void {
    if (graceTimer === null) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  }

  function disarm(reason: string): void {
    cancelGraceTimer();
    if (!armed) return;
    armed = false;
    log.debug("disarm", { reason });
    options.onChange();
  }

  return {
    isAwaiting: () => armed,

    arm(): void {
      cancelGraceTimer();
      if (armed) return;
      armed = true;
      log.debug("arm");
      options.onChange();
    },

    onCognitionIdle(isAudioPlaying: boolean): void {
      if (!armed || graceTimer !== null) return;
      // If audio is already flowing, the audio-playing state owns visibility
      // from here — onPlaybackEnded will disarm us when it drains.
      if (isAudioPlaying) return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        disarm("grace-timeout");
      }, graceMs);
    },

    onCognitionActive(): void {
      // ReAct continuation or new cycle kicked off — cancel any in-flight
      // grace timer. The cycle is live again.
      cancelGraceTimer();
    },

    onAudioStart(): void {
      disarm("audio-start");
    },

    onPlaybackEnded(): void {
      disarm("playback-ended");
    },

    dispose(): void {
      cancelGraceTimer();
    },
  };
}
