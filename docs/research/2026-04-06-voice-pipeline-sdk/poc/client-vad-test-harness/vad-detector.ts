/**
 * Client-Side VAD Detector — Pluggable Interface + Energy-Based Default
 *
 * Replicates the real problem: the existing capture-worklet.ts produces
 * Int16 PCM batches (512 samples @ 48kHz = 10.6ms). We need a VAD layer
 * that processes these batches and emits speech_start/speech_end events
 * WITHOUT any browser APIs — pure logic, fully testable.
 *
 * This PoC isolates the detection logic from Web Audio / AudioWorklet
 * so it can be tested with synthetic audio inputs.
 */

// ─── Pluggable Detector Interface ────────────────────────────────────

export interface VadDetectorConfig {
  /** Silence duration (ms) before emitting speech_end. Default: 700 */
  silenceTimeoutMs: number;
  /** Minimum speech duration (ms) before confirming. Default: 32 */
  minSpeechDurationMs: number;
  /** Energy threshold (0-1 RMS scale). Default: 0.01 */
  energyThreshold: number;
  /** Sample rate of incoming audio. Default: 48000 */
  sampleRate: number;
  /** Samples per batch (matches capture worklet). Default: 512 */
  batchSize: number;
}

export const DEFAULT_CONFIG: VadDetectorConfig = {
  silenceTimeoutMs: 700,
  minSpeechDurationMs: 32,
  energyThreshold: 0.01,
  sampleRate: 48000,
  batchSize: 512,
};

export type VadDetectorEvent =
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "energy"; rms: number; isSpeech: boolean };

export interface VadDetector {
  /** Process a batch of audio samples. Returns events produced. */
  processBatch(samples: Float32Array): VadDetectorEvent[];

  /** Reset detector state (e.g., on mode switch) */
  reset(): void;

  /** Current detection state */
  readonly isSpeaking: boolean;
}

// ─── Energy-Based VAD (Default) ──────────────────────────────────────

/**
 * Simple RMS energy detector. Runs in O(n) per batch, zero dependencies.
 * Designed to replicate what would run inside AudioWorklet.
 *
 * Detection logic:
 * - Onset: N consecutive high-energy batches (debounce against coughs)
 * - Offset: M ms of consecutive low-energy batches (silence timeout)
 */
export class EnergyVadDetector implements VadDetector {
  private config: VadDetectorConfig;
  private speaking = false;
  private consecutiveHighFrames = 0;
  private consecutiveLowFrames = 0;

  /** How many consecutive high-energy frames needed for onset */
  private readonly onsetFrames: number;
  /** How many consecutive low-energy frames needed for offset */
  private readonly offsetFrames: number;
  /** Duration of one batch in ms */
  private readonly batchDurationMs: number;

  constructor(config: Partial<VadDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.batchDurationMs =
      (this.config.batchSize / this.config.sampleRate) * 1000;
    this.onsetFrames = Math.max(
      1,
      Math.ceil(this.config.minSpeechDurationMs / this.batchDurationMs)
    );
    this.offsetFrames = Math.max(
      1,
      Math.ceil(this.config.silenceTimeoutMs / this.batchDurationMs)
    );
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  processBatch(samples: Float32Array): VadDetectorEvent[] {
    const rms = computeRMS(samples);
    const isHigh = rms >= this.config.energyThreshold;
    const events: VadDetectorEvent[] = [];

    // Always emit energy level (useful for visualization/testing)
    events.push({ type: "energy", rms, isSpeech: isHigh });

    if (isHigh) {
      this.consecutiveLowFrames = 0;
      this.consecutiveHighFrames++;

      if (!this.speaking && this.consecutiveHighFrames >= this.onsetFrames) {
        this.speaking = true;
        events.push({ type: "speech_start" });
      }
    } else {
      this.consecutiveHighFrames = 0;
      this.consecutiveLowFrames++;

      if (this.speaking && this.consecutiveLowFrames >= this.offsetFrames) {
        this.speaking = false;
        events.push({ type: "speech_end" });
      }
    }

    return events;
  }

  reset(): void {
    this.speaking = false;
    this.consecutiveHighFrames = 0;
    this.consecutiveLowFrames = 0;
  }
}

// ─── Bandpass-Filtered Energy VAD ────────────────────────────────────

/**
 * Voice-band filtered RMS. Applies a simple band-pass filter (300-3400 Hz)
 * in software before computing RMS. This approximates BiquadFilterNode
 * from WebAudio but runs as pure math — no browser APIs needed.
 *
 * Uses a 2nd-order IIR butterworth bandpass for voice frequencies.
 */
export class BandpassEnergyVadDetector implements VadDetector {
  private inner: EnergyVadDetector;
  private filter: BandpassFilter;

  constructor(config: Partial<VadDetectorConfig> = {}) {
    this.inner = new EnergyVadDetector(config);
    const sampleRate = config.sampleRate ?? DEFAULT_CONFIG.sampleRate;
    this.filter = new BandpassFilter(300, 3400, sampleRate);
  }

  get isSpeaking(): boolean {
    return this.inner.isSpeaking;
  }

  processBatch(samples: Float32Array): VadDetectorEvent[] {
    const filtered = this.filter.process(samples);
    return this.inner.processBatch(filtered);
  }

  reset(): void {
    this.inner.reset();
    this.filter.reset();
  }
}

// ─── Mock ML VAD (simulates Silero-like behavior) ────────────────────

/**
 * Mock ML detector for testing. Accepts a probability function that
 * the test controls — simulates what Silero ONNX would return.
 */
export class MockMlVadDetector implements VadDetector {
  private config: VadDetectorConfig;
  private speaking = false;
  private consecutiveHighFrames = 0;
  private consecutiveLowFrames = 0;
  private readonly onsetFrames: number;
  private readonly offsetFrames: number;
  private readonly batchDurationMs: number;

  /** Injected probability function — test controls this */
  private probabilityFn: (samples: Float32Array) => number;
  /** Threshold for speech probability */
  private readonly mlThreshold: number;

  constructor(
    probabilityFn: (samples: Float32Array) => number,
    mlThreshold: number = 0.5,
    config: Partial<VadDetectorConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.probabilityFn = probabilityFn;
    this.mlThreshold = mlThreshold;
    this.batchDurationMs =
      (this.config.batchSize / this.config.sampleRate) * 1000;
    this.onsetFrames = Math.max(
      1,
      Math.ceil(this.config.minSpeechDurationMs / this.batchDurationMs)
    );
    this.offsetFrames = Math.max(
      1,
      Math.ceil(this.config.silenceTimeoutMs / this.batchDurationMs)
    );
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  processBatch(samples: Float32Array): VadDetectorEvent[] {
    const prob = this.probabilityFn(samples);
    const isHigh = prob >= this.mlThreshold;
    const events: VadDetectorEvent[] = [];

    events.push({ type: "energy", rms: prob, isSpeech: isHigh });

    if (isHigh) {
      this.consecutiveLowFrames = 0;
      this.consecutiveHighFrames++;
      if (!this.speaking && this.consecutiveHighFrames >= this.onsetFrames) {
        this.speaking = true;
        events.push({ type: "speech_start" });
      }
    } else {
      this.consecutiveHighFrames = 0;
      this.consecutiveLowFrames++;
      if (this.speaking && this.consecutiveLowFrames >= this.offsetFrames) {
        this.speaking = false;
        events.push({ type: "speech_end" });
      }
    }

    return events;
  }

  /** Replace the probability function at runtime (for dynamic test scenarios) */
  setProbabilityFn(fn: (samples: Float32Array) => number): void {
    this.probabilityFn = fn;
  }

  reset(): void {
    this.speaking = false;
    this.consecutiveHighFrames = 0;
    this.consecutiveLowFrames = 0;
  }
}

// ─── Pure Utilities ──────────────────────────────────────────────────

/** Compute RMS energy of a Float32 audio buffer. Pure function. */
export function computeRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Simple 2nd-order IIR bandpass filter.
 * Stateful (maintains filter memory), but deterministic given same input sequence.
 */
class BandpassFilter {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;

  constructor(lowFreq: number, highFreq: number, sampleRate: number) {
    // Compute bandpass coefficients (simplified Butterworth)
    const f0 = Math.sqrt(lowFreq * highFreq);
    const bw = highFreq - lowFreq;
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const alpha = Math.sin(w0) * Math.sinh((Math.LN2 / 2) * (bw / f0) * (w0 / Math.sin(w0)));

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha;

    // Normalize
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y =
        this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 -
        this.a1 * this.y1 - this.a2 * this.y2;

      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      output[i] = y;
    }
    return output;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}
