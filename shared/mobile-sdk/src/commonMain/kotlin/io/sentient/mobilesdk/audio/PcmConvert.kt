package io.sentient.mobilesdk.audio

// ---------------------------------------------------------------------------
// PcmConvert — bridges between Float32 samples, Int16 ShortArrays, and
// little-endian PCM16 byte buffers required by the kopus encode/decode API.
//
// kopus encode takes Int16 ShortArray; decode yields PCM that the pipeline
// serializes to LE bytes. These helpers are the bridges.
//
// Math agrees exactly with AudioCodec.kt (pcm16ToFloat32 / float32ToPcm16):
//   - Float → Int16: clamp to [-1, 1], scale negative by 32768, positive by 32767.
//   - Int16 → Float: divide by 32768 → range [-1.0, ~1.0).
//   - LE byte order: low byte at even index, high byte at odd index.
// ---------------------------------------------------------------------------

/** Magnitude of the most-negative signed 16-bit integer (2^15). Used as the decode divisor. */
private const val PCM_INT16_MIN_MAGNITUDE = 32768

/** Maximum value of a signed 16-bit integer (2^15 - 1). Used as the positive encode multiplier. */
private const val PCM_INT16_MAX = 32767

/**
 * Convert normalized Float32 samples in [-1.0, 1.0] to Int16 ShortArray.
 *
 * Matches AudioCodec.float32ToPcm16: negative samples scale by 32768,
 * positive by 32767 (asymmetric Int16 range). Input clamped to [-1, 1].
 */
fun floatToPcm16Shorts(samples: FloatArray): ShortArray {
    val out = ShortArray(samples.size)
    for (i in samples.indices) {
        val s = samples[i].coerceIn(-1f, 1f)
        val v = if (s < 0) (s * PCM_INT16_MIN_MAGNITUDE).toInt() else (s * PCM_INT16_MAX).toInt()
        out[i] = v.toShort()
    }
    return out
}

/**
 * Convert Int16 ShortArray to normalized Float32 samples in [-1.0, ~1.0).
 *
 * Matches AudioCodec.pcm16ToFloat32: divide each Int16 value by 32768.
 */
fun pcm16ShortsToFloat(shorts: ShortArray): FloatArray {
    val out = FloatArray(shorts.size)
    for (i in shorts.indices) {
        out[i] = shorts[i].toFloat() / PCM_INT16_MIN_MAGNITUDE
    }
    return out
}

/**
 * Unpack little-endian PCM16 bytes into a ShortArray.
 *
 * Each pair of bytes is read as (hi << 8) | lo, matching AudioCodec.pcm16ToFloat32
 * byte ordering. Input length must be even; trailing odd byte is ignored.
 */
fun pcm16LeToShorts(bytes: ByteArray): ShortArray {
    val n = bytes.size / 2
    val out = ShortArray(n)
    for (i in 0 until n) {
        val lo = bytes[i * 2].toInt() and 0xFF
        val hi = bytes[i * 2 + 1].toInt()
        out[i] = ((hi shl 8) or lo).toShort()
    }
    return out
}

/**
 * Pack a ShortArray into little-endian PCM16 bytes.
 *
 * Low byte at even index, high byte at odd index — matching the wire format
 * consumed by the gateway and AudioCodec.float32ToPcm16.
 */
fun shortsToPcm16Le(shorts: ShortArray): ByteArray {
    val out = ByteArray(shorts.size * 2)
    for (i in shorts.indices) {
        val v = shorts[i].toInt()
        out[i * 2] = (v and 0xFF).toByte()
        out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }
    return out
}
