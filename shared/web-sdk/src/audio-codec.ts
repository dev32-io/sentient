const INT16_MAX = 0x7fff;
const INT16_MIN_MAGNITUDE = 0x8000;

/** Decode PCM16 (Int16 ArrayBuffer) to Float32 [-1.0, ~1.0) */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / INT16_MIN_MAGNITUDE;
  }
  return float32;
}

/** Encode Float32 [-1.0, 1.0] to PCM16 (Uint8Array containing Int16 data) */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    int16[i] = s < 0 ? s * INT16_MIN_MAGNITUDE : s * INT16_MAX;
  }
  return new Uint8Array(int16.buffer);
}
