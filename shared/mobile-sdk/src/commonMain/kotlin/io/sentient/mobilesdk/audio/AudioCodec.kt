package io.sentient.mobilesdk.audio

// ---------------------------------------------------------------------------
// AudioCodec — PCM16 ↔ Float32 conversion + RMS energy.
//
// Port of shared/web-sdk/src/audio-codec.ts (pcm16ToFloat32, float32ToPcm16)
// and shared/web-sdk/src/echo-gate.ts (computeRms).
//
// Math is a faithful transcription — scale factors and clamping match the TS
// source exactly:
//   • Decode: divide by INT16_MIN_MAGNITUDE (32768) → range [-1.0, ~1.0)
//   • Encode: negative samples use 32768 as multiplier, positive use 32767,
//             then clamp ∈ [-1,1] before scaling.
//   • RMS:    normalise each sample by PCM16_SCALE (32768) before squaring.
// ---------------------------------------------------------------------------

/** Maximum value of a signed 16-bit integer (2^15 - 1). */
private const val INT16_MAX = 32767

/** Magnitude of the most-negative signed 16-bit integer (2^15). */
private const val INT16_MIN_MAGNITUDE = 32768

/** Normalization divisor for RMS (same as INT16_MIN_MAGNITUDE). */
private const val PCM16_SCALE = 32768.0

/**
 * Decode little-endian PCM16 bytes to normalized Float32 samples in [-1.0, ~1.0).
 *
 * Mirrors web-sdk `pcm16ToFloat32`: each Int16 sample is divided by 32768.
 */
fun pcm16ToFloat32(bytes: ByteArray): FloatArray {
    val n = bytes.size / 2
    val out = FloatArray(n)
    for (i in 0 until n) {
        val lo = bytes[i * 2].toInt() and 0xFF
        val hi = bytes[i * 2 + 1].toInt()
        val sample = (hi shl 8) or lo
        out[i] = sample / INT16_MIN_MAGNITUDE.toFloat()
    }
    return out
}

/**
 * Encode Float32 samples in [-1.0, 1.0] to little-endian PCM16 bytes.
 *
 * Mirrors web-sdk `float32ToPcm16`: clamp to [-1,1], then scale negative
 * samples by 32768 and positive by 32767 (matching the asymmetric Int16 range).
 */
fun float32ToPcm16(samples: FloatArray): ByteArray {
    val out = ByteArray(samples.size * 2)
    for (i in samples.indices) {
        val s = samples[i].coerceIn(-1f, 1f)
        val v = if (s < 0) (s * INT16_MIN_MAGNITUDE).toInt() else (s * INT16_MAX).toInt()
        out[i * 2] = (v and 0xFF).toByte()
        out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }
    return out
}

/**
 * Compute the RMS energy of a PCM16 frame, normalized to [0.0, 1.0].
 *
 * Mirrors web-sdk `computeRms` (echo-gate.ts): divide each sample by 32768
 * before squaring, then take sqrt of the mean.
 */
fun computeRms(pcm: ShortArray): Double {
    if (pcm.isEmpty()) return 0.0
    var sumSq = 0.0
    for (s in pcm) {
        val v = s / PCM16_SCALE
        sumSq += v * v
    }
    return kotlin.math.sqrt(sumSq / pcm.size)
}
