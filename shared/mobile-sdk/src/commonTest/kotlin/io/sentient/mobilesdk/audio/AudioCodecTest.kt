package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// Test helpers — little-endian short ↔ byte conversions
// ---------------------------------------------------------------------------

/** Pack a ShortArray into a ByteArray in little-endian order. */
fun shortsToLeBytes(shorts: ShortArray): ByteArray {
    val out = ByteArray(shorts.size * 2)
    for (i in shorts.indices) {
        val v = shorts[i].toInt()
        out[i * 2] = (v and 0xFF).toByte()
        out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }
    return out
}

/** Unpack a little-endian ByteArray into a ShortArray. */
fun leBytesToShorts(bytes: ByteArray): ShortArray {
    val n = bytes.size / 2
    val out = ShortArray(n)
    for (i in 0 until n) {
        val lo = bytes[i * 2].toInt() and 0xFF
        val hi = bytes[i * 2 + 1].toInt()
        out[i] = ((hi shl 8) or lo).toShort()
    }
    return out
}

// ---------------------------------------------------------------------------
// AudioCodec parity tests — port of audio-codec.test.ts
// Pins the PCM16 format contract and parity with web-sdk audio-codec.ts.
// ---------------------------------------------------------------------------

class AudioCodecTest {

    @Test
    fun pcm16_to_float_normalizes() {
        // 0 → 0.0; 16384 ≈ 0.5; -16384 ≈ -0.5
        val bytes = shortsToLeBytes(shortArrayOf(0, 16384, -16384))
        val f = pcm16ToFloat32(bytes)
        assertEquals(0f, f[0])
        assertTrue(kotlin.math.abs(f[1] - 0.5f) < 1e-3f)
        assertTrue(kotlin.math.abs(f[2] + 0.5f) < 1e-3f)
    }

    @Test
    fun float_to_pcm16_clamps() {
        // Values > 1.0 and < -1.0 must clamp to INT16_MAX / INT16_MIN
        val out = float32ToPcm16(floatArrayOf(2.0f, -2.0f))
        val s = leBytesToShorts(out)
        assertEquals(32767, s[0].toInt())
        assertEquals(-32768, s[1].toInt())
    }

    @Test
    fun rms_of_silence_is_zero() {
        assertEquals(0.0, computeRms(ShortArray(64)))
    }
}
