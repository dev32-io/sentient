/**
 * Synthetic Audio Generator — Mock/Synthetic Audio Inputs for VAD Testing
 *
 * Generates Float32Array batches that simulate real audio scenarios without
 * any browser or hardware dependency. Every function is pure and deterministic.
 *
 * These generators replicate patterns seen in the real capture-worklet.ts
 * (512 samples @ 48kHz per batch) but work outside any audio context.
 */

const DEFAULT_BATCH_SIZE = 512;
const DEFAULT_SAMPLE_RATE = 48000;

// ─── Basic Signal Generators ─────────────────────────────────────────

/** Generate silence (all zeros). RMS = 0. */
export function silence(batchSize = DEFAULT_BATCH_SIZE): Float32Array {
  return new Float32Array(batchSize);
}

/** Generate low-level background noise. RMS ~ amplitude * 0.707 */
export function noise(
  amplitude: number,
  batchSize = DEFAULT_BATCH_SIZE
): Float32Array {
  const samples = new Float32Array(batchSize);
  // Use deterministic pseudo-random for reproducible tests
  let seed = 42;
  for (let i = 0; i < batchSize; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Map to [-amplitude, +amplitude]
    samples[i] = ((seed / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return samples;
}

/** Generate a sine tone at given frequency. RMS = amplitude / sqrt(2) */
export function tone(
  frequency: number,
  amplitude: number,
  startPhase = 0,
  sampleRate = DEFAULT_SAMPLE_RATE,
  batchSize = DEFAULT_BATCH_SIZE
): Float32Array {
  const samples = new Float32Array(batchSize);
  for (let i = 0; i < batchSize; i++) {
    samples[i] =
      amplitude *
      Math.sin(2 * Math.PI * frequency * (i / sampleRate) + startPhase);
  }
  return samples;
}

/**
 * Generate a "speech-like" signal: voice-band frequency mix with
 * slight amplitude modulation (simulates syllable cadence).
 * Fundamental ~ 150Hz (male voice) with harmonics at 300, 450, 600 Hz.
 */
export function speechLike(
  amplitude: number,
  startPhase = 0,
  sampleRate = DEFAULT_SAMPLE_RATE,
  batchSize = DEFAULT_BATCH_SIZE
): Float32Array {
  const samples = new Float32Array(batchSize);
  const fundamental = 150;
  // Amplitude modulation at ~4 Hz (syllable rate)
  const modFreq = 4;

  for (let i = 0; i < batchSize; i++) {
    const t = i / sampleRate;
    const mod = 0.7 + 0.3 * Math.sin(2 * Math.PI * modFreq * t + startPhase);
    const voice =
      0.5 * Math.sin(2 * Math.PI * fundamental * t + startPhase) +
      0.3 * Math.sin(2 * Math.PI * (fundamental * 2) * t + startPhase) +
      0.15 * Math.sin(2 * Math.PI * (fundamental * 3) * t + startPhase) +
      0.05 * Math.sin(2 * Math.PI * (fundamental * 4) * t + startPhase);

    samples[i] = amplitude * mod * voice;
  }
  return samples;
}

/**
 * Generate a cough-like transient: short broadband burst that
 * decays quickly. High energy but short duration (1-2 frames).
 */
export function coughBurst(
  amplitude: number,
  batchSize = DEFAULT_BATCH_SIZE
): Float32Array {
  const samples = new Float32Array(batchSize);
  let seed = 12345;
  for (let i = 0; i < batchSize; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Exponential decay envelope: peaks at start, decays to ~10% by end
    const envelope = Math.exp((-3 * i) / batchSize);
    samples[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1) * envelope;
  }
  return samples;
}

/**
 * Generate low-frequency rumble (fan/HVAC noise).
 * 60 Hz hum + 120 Hz harmonic. Below voice band.
 */
export function lowFreqRumble(
  amplitude: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  batchSize = DEFAULT_BATCH_SIZE
): Float32Array {
  const samples = new Float32Array(batchSize);
  for (let i = 0; i < batchSize; i++) {
    const t = i / sampleRate;
    samples[i] =
      amplitude *
      (0.7 * Math.sin(2 * Math.PI * 60 * t) +
        0.3 * Math.sin(2 * Math.PI * 120 * t));
  }
  return samples;
}

// ─── Sequence Generators ─────────────────────────────────────────────

/**
 * Generate a sequence of batches simulating a scenario.
 * Each entry: [generatorFn, numberOfBatches]
 */
export type ScenarioSegment = [() => Float32Array, number];

export function generateScenario(segments: ScenarioSegment[]): Float32Array[] {
  const batches: Float32Array[] = [];
  for (const [generator, count] of segments) {
    for (let i = 0; i < count; i++) {
      batches.push(generator());
    }
  }
  return batches;
}

// ─── Pre-built Scenarios ─────────────────────────────────────────────

/**
 * Quiet room → user speaks → silence → done.
 * ~100 batches = ~1.06 seconds total.
 */
export function scenarioSimpleSpeech(): Float32Array[] {
  return generateScenario([
    [silence, 10], // 106ms silence
    [() => speechLike(0.3), 50], // 530ms speech
    [silence, 80], // 853ms trailing silence (> 700ms timeout = 66 frames)
  ]);
}

/**
 * Cough during silence — should NOT trigger speech_start if debounce works.
 * Single high-energy frame surrounded by silence.
 */
export function scenarioCoughFalseAlarm(): Float32Array[] {
  return generateScenario([
    [silence, 10],
    [() => coughBurst(0.5), 1], // single cough burst
    [silence, 10],
  ]);
}

/**
 * Background noise (low level) → speech on top of noise → noise only.
 * Tests threshold discrimination.
 */
export function scenarioSpeechOverNoise(): Float32Array[] {
  const noiseFloor = 0.005; // below default threshold (0.01)
  const speechLevel = 0.3;
  return generateScenario([
    [() => noise(noiseFloor), 10],
    [() => addSignals(speechLike(speechLevel), noise(noiseFloor)), 50],
    [() => noise(noiseFloor), 80], // long trailing noise
  ]);
}

/**
 * Mid-sentence pause: speech → brief silence → speech resumes.
 * Tests that silence timeout (700ms) is NOT triggered by short pause.
 */
export function scenarioMidSentencePause(): Float32Array[] {
  return generateScenario([
    [silence, 5],
    [() => speechLike(0.3), 30], // 318ms speech
    [silence, 30], // 318ms pause (< 700ms timeout)
    [() => speechLike(0.3), 30], // resume speech
    [silence, 80], // 848ms final silence (> 700ms → speech_end)
  ]);
}

/**
 * Double utterance: speak, full silence timeout, speak again.
 * Should produce two speech_start/speech_end pairs.
 */
export function scenarioDoubleUtterance(): Float32Array[] {
  return generateScenario([
    [silence, 5],
    [() => speechLike(0.3), 30], // first utterance
    [silence, 80], // 848ms silence → speech_end
    [() => speechLike(0.3), 30], // second utterance
    [silence, 80], // 848ms silence → speech_end
  ]);
}

/**
 * Low-frequency rumble (HVAC/fan) — should NOT trigger energy VAD
 * if bandpass filter is working. Will trigger unfiltered energy VAD.
 */
export function scenarioLowFreqInterference(): Float32Array[] {
  return generateScenario([
    [() => lowFreqRumble(0.1), 30], // 318ms of 60Hz hum at significant amplitude
  ]);
}

/**
 * Whisper: very low amplitude speech-like signal.
 * Tests sensitivity to quiet speech. May be below energy threshold.
 */
export function scenarioWhisper(): Float32Array[] {
  return generateScenario([
    [silence, 5],
    [() => speechLike(0.005), 50], // whisper at 0.005 amplitude
    [silence, 80],
  ]);
}

// ─── Utility ─────────────────────────────────────────────────────────

/** Add two signals sample-by-sample. */
export function addSignals(a: Float32Array, b: Float32Array): Float32Array {
  const len = Math.min(a.length, b.length);
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = a[i] + b[i];
  }
  return result;
}
