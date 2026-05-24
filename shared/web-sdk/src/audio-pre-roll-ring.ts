// ---------------------------------------------------------------------------
// AudioPreRollRing — capture-side pre-roll + hangover buffer.
//
// PROBLEM
// -------
// The client-side EchoGate drops mic frames whose RMS falls below a baseline
// threshold (room noise, between-word silence, very quiet onset/offset
// phonemes). When real speech begins, its leading 1-2 frames are often
// quieter than the threshold (vowel ramp-up, partial frame of silence
// before the syllable starts) and get dropped — the STT never sees them,
// so transcripts miss the head of the utterance. Symmetrically, trailing
// low-energy phonemes drop off the tail. Worse, mid-sentence dips below
// the threshold cause the gateway's silence-carrier to engage, which makes
// Silero VAD fire end-of-speech and Smart-Turn cut the turn — one utterance
// becomes several transcripts.
//
// DESIGN
// ------
// A small ring placed between the EchoGate decision and the WS send. Every
// captured frame is run through the gate as today, but instead of dropping
// rejected frames outright we buffer the last N of them (pre-roll). When the
// gate flips from reject → accept, the buffered pre-roll is flushed ahead
// of the accepted frame so STT sees the quiet onset. When the gate flips
// from accept → reject, we keep emitting for M more frames (hangover) so
// the quiet tail is preserved.
//
// State machine (pure, no clocks):
//
//     idle (last frame rejected, ring filling)
//       — accept → flush ring, emit frame, → active
//       — reject → push to ring (trim), emit nothing
//
//     active (last frame accepted, hangover counter armed)
//       — accept → emit frame, re-arm hangover, stay active
//       — reject → emit frame, decrement hangover; → idle when counter hits 0
//
// PLATFORM PORTING
// ----------------
// Pure TypeScript, zero browser deps. Same porting story as EchoGate.
// ---------------------------------------------------------------------------

export interface AudioPreRollRingConfig {
  /**
   * Number of below-threshold frames to retain ahead of the next accepted
   * frame. At ~80 ms per frame, 5 ≈ 400 ms of leading context — enough to
   * cover a slow vowel ramp-up or a quiet leading consonant.
   */
  readonly preRollFrames: number;
  /**
   * Number of below-threshold frames to keep emitting after an accepted
   * streak. Covers trailing low-energy phonemes and inter-word dips so
   * the gateway's silence carrier does not engage mid-sentence. At
   * ~80 ms per frame, 4 ≈ 320 ms of hangover.
   */
  readonly hangoverFrames: number;
}

export interface AudioPreRollRing {
  /**
   * Feed one captured frame with the EchoGate's accept/reject verdict.
   * Returns the frames that should be forwarded to STT in order — may be
   * empty (silence is being buffered) or contain multiple frames (the
   * pre-roll flush on a reject→accept transition).
   */
  push(frame: ArrayBuffer, accepted: boolean): readonly ArrayBuffer[];
  /** Drop the ring and reset to idle. Use on session boundaries. */
  reset(): void;
}

export function createAudioPreRollRing(config: AudioPreRollRingConfig): AudioPreRollRing {
  if (config.preRollFrames < 0) {
    throw new Error(`AudioPreRollRing: preRollFrames must be >= 0, got ${config.preRollFrames}`);
  }
  if (config.hangoverFrames < 0) {
    throw new Error(`AudioPreRollRing: hangoverFrames must be >= 0, got ${config.hangoverFrames}`);
  }

  const ring: ArrayBuffer[] = [];
  let active = false;
  let hangoverRemaining = 0;

  return {
    push(frame, accepted) {
      if (accepted) {
        if (!active) {
          const flush = ring.length > 0 ? ring.slice() : [];
          ring.length = 0;
          flush.push(frame);
          active = true;
          hangoverRemaining = config.hangoverFrames;
          return flush;
        }
        hangoverRemaining = config.hangoverFrames;
        return [frame];
      }

      if (active) {
        if (hangoverRemaining > 0) {
          hangoverRemaining--;
          if (hangoverRemaining === 0) active = false;
          return [frame];
        }
        active = false;
      }

      if (config.preRollFrames === 0) return [];
      ring.push(frame);
      while (ring.length > config.preRollFrames) ring.shift();
      return [];
    },
    reset() {
      ring.length = 0;
      active = false;
      hangoverRemaining = 0;
    },
  };
}
