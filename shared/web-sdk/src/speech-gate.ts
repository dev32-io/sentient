// shared/web-sdk/src/speech-gate.ts
// ---------------------------------------------------------------------------
// SpeechGate — client-side mic latch.
//
// Replaces per-frame gating (a single speech-positive frame opened a fixed
// trailing-timer stream → transient noise became ghost STT turns; marginal
// frames were dropped → one utterance fragmented into many turns).
//
// Simple latch composed on top of AudioPreRollRing:
//   closed — push every frame into the ring as rejected (buffered pre-roll);
//            count sustained speech. A brief sub-threshold flicker is tolerated
//            (gapToleranceFrames); a longer gap resets the counter.
//   open   — sustained speech reached openDebounceMs: push the triggering frame
//            as accepted so the ring flushes the buffered onset, then forward
//            EVERY subsequent frame until close() or the maxOpenMs failsafe.
//
// Close is server-driven (caller invokes close() on connector.transcript.final),
// NOT a local hangover — so the ring is created with hangoverFrames: 0.
//
// Pure: the caller supplies the per-frame speech verdict and a monotonic nowMs.
// ---------------------------------------------------------------------------

import { createAudioPreRollRing } from "./audio-pre-roll-ring.ts";

export type SpeechGateState = "closed" | "open";

export interface SpeechGateConfig {
  readonly openDebounceMs: number;
  readonly frameDurationMs: number;
  readonly gapToleranceFrames: number;
  readonly preRollFrames: number;
  readonly maxOpenMs: number;
}

export interface SpeechGateResult {
  readonly forward: readonly Float32Array[];
  readonly opened: boolean;
}

export interface SpeechGate {
  process(frame: Float32Array, isSpeech: boolean, nowMs: number): SpeechGateResult;
  close(): void;
  state(): SpeechGateState;
}

export function createSpeechGate(config: SpeechGateConfig): SpeechGate {
  const ring = createAudioPreRollRing<Float32Array>({
    preRollFrames: config.preRollFrames,
    hangoverFrames: 0,
  });
  let state: SpeechGateState = "closed";
  let sustainedMs = 0;
  let gap = 0;
  let openedAtMs = 0;

  function reset(): void {
    state = "closed";
    sustainedMs = 0;
    gap = 0;
    openedAtMs = 0;
    ring.reset();
  }

  return {
    process(frame, isSpeech, nowMs) {
      if (state === "open") {
        if (nowMs - openedAtMs >= config.maxOpenMs) {
          reset();
          return { forward: [], opened: false };
        }
        return { forward: ring.push(frame, true), opened: false };
      }

      if (isSpeech) {
        sustainedMs += config.frameDurationMs;
        gap = 0;
      } else {
        gap += 1;
        if (gap > config.gapToleranceFrames) sustainedMs = 0;
      }

      if (sustainedMs >= config.openDebounceMs) {
        state = "open";
        openedAtMs = nowMs;
        return { forward: ring.push(frame, true), opened: true };
      }
      return { forward: ring.push(frame, false), opened: false };
    },
    close() {
      reset();
    },
    state() {
      return state;
    },
  };
}
