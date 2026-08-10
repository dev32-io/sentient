// ---------------------------------------------------------------------------
// EchoGate — client-side mic echo suppressor.
//
// PROBLEM
// -------
// When the assistant speaks through the device speakers, the microphone picks
// up that audio as "user speech" and sends it to STT as a phantom turn. The
// gateway already ramps STT energy thresholds around TTS playback, but those
// ramps rely on server-side estimates of "when playback actually ends" —
// estimates that lie under network jitter, large-playback tails, or any
// change in client-side buffering. The client has perfect timing info (it
// owns the WebAudio / AVAudioEngine / AudioTrack) so the authoritative
// "assistant is speaking right now" signal belongs here.
//
// DESIGN
// ------
// A pure state machine with three states:
//
//   baseline  — no assistant audio. Low threshold ⇒ user speech passes easily.
//   playback  — assistant audio is scheduled or actively playing. High
//               threshold ⇒ typical echo leaks fail; loud speech (barge-in)
//               still passes.
//   tail      — assistant playback has drained (adapter.onDrain fired). The
//               sink may still be emitting residual audio for a short
//               period (DAC buffer, speaker, WebRTC loopback latency). Stay
//               at the elevated threshold for `tailHoldMs`, then fall back
//               to baseline.
//
// Transitions:
//   baseline  — onPlaybackStart  →  playback
//   playback  — onPlaybackDrain  →  tail  (starts tail timer)
//   playback  — onPlaybackCancel →  baseline  (barge-in / interrupt)
//   tail      — onPlaybackStart  →  playback  (new reply arrived)
//   tail      — onPlaybackCancel →  baseline
//   tail      — (timer expires)  →  baseline
//
// acceptFrame(pcm) computes RMS of the frame, normalized to [0,1], and
// compares against the current state's threshold. Frames at or above the
// threshold return true (forward to STT); below, false (drop).
//
// PLATFORM PORTING
// ----------------
// This module is pure TypeScript with zero browser / DOM dependencies:
//
//   • Int16Array is a TypedArray — ES2015, available in Node, Bun,
//     React Native (with a polyfill), and can be trivially replaced with
//     `short*` or `[Int16]` on Kotlin / Swift.
//   • Clock is injected; no `Date.now` / `performance.now`. A native port
//     supplies platform monotonic time.
//   • Timer is injected as a function pair (`schedule` / `cancel`). A
//     native port supplies the platform's scheduler (Handler.postDelayed,
//     DispatchQueue.asyncAfter, etc).
//
// A native port mirrors the state machine verbatim and reuses the same
// three thresholds and the same tail hold. The signal contract is:
//
//   * onPlaybackStart — fire when the first TTS audio frame has been
//     handed off to the output sink for this reply.
//   * onPlaybackDrain — fire when the sink reports "all previously
//     enqueued audio has physically played" (drain event from the
//     audio-playback adapter).
//   * onPlaybackCancel — fire when playback is cut mid-stream (barge-in,
//     user interrupt).
//
// ---------------------------------------------------------------------------

export type EchoGateState = "baseline" | "playback" | "tail";

export interface EchoGateConfig {
  /** RMS threshold (0..1) while no assistant audio is active. Typical: 0.03. */
  readonly baselineThreshold: number;
  /** RMS threshold (0..1) during playback / tail. Typical: 0.2. */
  readonly playbackThreshold: number;
  /**
   * Ms to hold the elevated threshold after `onPlaybackDrain`. Covers DAC
   * buffer + WebRTC loopback latency + speaker diaphragm settle. Typical:
   * 500-1000ms.
   */
  readonly tailHoldMs: number;
}

export interface EchoGateSnapshot {
  readonly state: EchoGateState;
  readonly threshold: number;
}

/** Injectable scheduler — lets tests run deterministically without fake timers. */
export interface EchoGateScheduler {
  /** Schedule a callback after `ms`. Returns a handle. */
  schedule(ms: number, fn: () => void): EchoGateTimerHandle;
  /** Cancel a previously scheduled callback. No-op if already fired. */
  cancel(handle: EchoGateTimerHandle): void;
}
export type EchoGateTimerHandle = unknown;

/** Default scheduler backed by setTimeout/clearTimeout for production use. */
export const defaultEchoGateScheduler: EchoGateScheduler = {
  schedule(ms, fn) {
    return setTimeout(fn, ms);
  },
  cancel(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

export interface EchoGate {
  /**
   * Compute RMS of `pcm` (Int16 mono frame) and compare against the current
   * threshold. Returns true if the frame should be forwarded to STT.
   */
  acceptFrame(pcm: Int16Array): boolean;
  /** Assistant audio just started playing for this turn. */
  onPlaybackStart(turnId: string): void;
  /** Output sink finished draining all scheduled audio. */
  onPlaybackDrain(turnId: string): void;
  /** Playback cancelled mid-stream (barge-in, interrupt). */
  onPlaybackCancel(turnId: string): void;
  /** Current state snapshot (for logging / diagnostics). */
  snapshot(): EchoGateSnapshot;
  /** Subscribe to state transitions. Returns unsubscribe. */
  onStateChange(listener: (snap: EchoGateSnapshot) => void): () => void;
  /** Tear down pending timers. Idempotent. */
  dispose(): void;
}

export interface EchoGateDeps {
  readonly scheduler?: EchoGateScheduler;
}

export function createEchoGate(config: EchoGateConfig, deps: EchoGateDeps = {}): EchoGate {
  if (config.baselineThreshold < 0 || config.baselineThreshold > 1) {
    throw new Error(`EchoGate: baselineThreshold must be in [0,1], got ${config.baselineThreshold}`);
  }
  if (config.playbackThreshold < 0 || config.playbackThreshold > 1) {
    throw new Error(`EchoGate: playbackThreshold must be in [0,1], got ${config.playbackThreshold}`);
  }
  if (config.tailHoldMs < 0) {
    throw new Error(`EchoGate: tailHoldMs must be >= 0, got ${config.tailHoldMs}`);
  }

  const scheduler = deps.scheduler ?? defaultEchoGateScheduler;
  const listeners = new Set<(snap: EchoGateSnapshot) => void>();

  let state: EchoGateState = "baseline";
  let tailHandle: EchoGateTimerHandle | null = null;

  function thresholdFor(s: EchoGateState): number {
    return s === "baseline" ? config.baselineThreshold : config.playbackThreshold;
  }

  function snapshot(): EchoGateSnapshot {
    return { state, threshold: thresholdFor(state) };
  }

  function setState(next: EchoGateState): void {
    if (state === next) return;
    state = next;
    const snap = snapshot();
    for (const l of listeners) l(snap);
  }

  function clearTailTimer(): void {
    if (tailHandle !== null) {
      scheduler.cancel(tailHandle);
      tailHandle = null;
    }
  }

  function startTailTimer(): void {
    clearTailTimer();
    if (config.tailHoldMs === 0) {
      setState("baseline");
      return;
    }
    tailHandle = scheduler.schedule(config.tailHoldMs, () => {
      tailHandle = null;
      // Only transition if we're still in tail. If something moved us to
      // playback or baseline meanwhile, this timer is stale — ignore.
      if (state === "tail") setState("baseline");
    });
  }

  return {
    acceptFrame(pcm) {
      if (pcm.length === 0) return false;
      const rms = computeRms(pcm);
      return rms >= thresholdFor(state);
    },
    onPlaybackStart(_turnId) {
      clearTailTimer();
      setState("playback");
    },
    onPlaybackDrain(_turnId) {
      if (state !== "playback") return; // late or duplicate drain
      setState("tail");
      startTailTimer();
    },
    onPlaybackCancel(_turnId) {
      clearTailTimer();
      setState("baseline");
    },
    snapshot,
    onStateChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearTailTimer();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// RMS — root-mean-square energy of a PCM16 frame, normalized to [0,1].
// Pure function so it ports directly to any platform.
// ---------------------------------------------------------------------------

/** Max amplitude of a signed 16-bit sample. */
const PCM16_SCALE = 32768;

export function computeRms(pcm: Int16Array): number {
  const n = pcm.length;
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is in bounds [0,n)
    const v = pcm[i]! / PCM16_SCALE;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / n);
}
