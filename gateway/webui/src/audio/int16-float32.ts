/**
 * Int16 PCM ↔ Float32 conversion using the same asymmetric scaling the
 * capture worklet (`capture-worklet.ts`) uses on the way OUT. Keeping the
 * forward + reverse identical guarantees a round-trip stays bit-exact aside
 * from the lossy Int16 quantization step.
 *
 *   forward (Float32 → Int16):
 *     sample < 0  →  sample * INT16_MIN_MAGNITUDE  (= sample * 0x8000)
 *     sample >= 0 →  sample * INT16_MAX            (= sample * 0x7fff)
 *
 *   reverse (Int16 → Float32):
 *     int16 < 0   →  int16 / INT16_MIN_MAGNITUDE
 *     int16 >= 0  →  int16 / INT16_MAX
 *
 * The asymmetry is intentional — signed-16 range is [-32768, 32767], so
 * dividing both halves by 32767 would map -32768 to -1.00003 (clipping
 * beyond [-1, 1] which AudioData / AudioEncoder reject).
 */

/** Maximum positive value of a signed 16-bit integer. */
const INT16_MAX = 0x7fff;

/** Magnitude of the minimum value of a signed 16-bit integer. */
const INT16_MIN_MAGNITUDE = 0x8000;

/**
 * Convert Int16 PCM samples to Float32 in [-1, 1].
 *
 * Allocates a fresh Float32Array — caller is free to retain it (e.g. queue
 * pending frames before the opus encoder is ready).
 */
export function int16ToFloat32(int16: Int16Array): Float32Array {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    const sample = int16[i] ?? 0;
    out[i] = sample < 0 ? sample / INT16_MIN_MAGNITUDE : sample / INT16_MAX;
  }
  return out;
}
