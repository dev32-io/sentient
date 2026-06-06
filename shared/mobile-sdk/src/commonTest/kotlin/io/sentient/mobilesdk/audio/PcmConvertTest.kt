package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// PcmConvertTest — round-trip and correctness tests for PcmConvert.kt.
// Pins the Float↔Int16↔LE-bytes contracts used by the kopus audio pipeline.
// ---------------------------------------------------------------------------

class PcmConvertTest {

    // ---- Float ↔ Int16 round-trip ------------------------------------------

    @Test
    fun float_to_shorts_and_back_round_trips_within_tolerance() {
        // Samples covering the full range: -1.0, 0.0, +1.0, a mid value
        val samples = floatArrayOf(-1f, -0.5f, 0f, 0.5f, 1f)
        val shorts = floatToPcm16Shorts(samples)
        val recovered = pcm16ShortsToFloat(shorts)
        // Round-trip tolerance: 1/32768 ≈ 3.1e-5 per sample
        val tolerance = 1f / 32768f + 1e-6f
        for (i in samples.indices) {
            assertTrue(
                kotlin.math.abs(recovered[i] - samples[i]) <= tolerance,
                "Sample[$i]: expected ≈${samples[i]}, got ${recovered[i]}"
            )
        }
    }

    @Test
    fun float_to_shorts_clamps_above_one() {
        val shorts = floatToPcm16Shorts(floatArrayOf(2f))
        assertEquals(32767, shorts[0].toInt(), "Values > 1.0 must clamp to INT16_MAX")
    }

    @Test
    fun float_to_shorts_clamps_below_minus_one() {
        val shorts = floatToPcm16Shorts(floatArrayOf(-2f))
        assertEquals(-32768, shorts[0].toInt(), "Values < -1.0 must clamp to INT16_MIN")
    }

    @Test
    fun float_to_shorts_zero_is_zero() {
        val shorts = floatToPcm16Shorts(floatArrayOf(0f))
        assertEquals(0, shorts[0].toInt())
    }

    @Test
    fun pcm16_shorts_to_float_normalizes_known_values() {
        // 32767 → ~1.0 (within 1 ULP of 32767/32768); -32768 → -1.0 exactly
        val f = pcm16ShortsToFloat(shortArrayOf(32767, -32768, 0))
        assertTrue(kotlin.math.abs(f[0] - (32767f / 32768f)) < 1e-5f)
        assertEquals(-1f, f[1])
        assertEquals(0f, f[2])
    }

    // ---- ShortArray ↔ LE bytes round-trip ------------------------------------

    @Test
    fun shorts_to_le_bytes_and_back_exact() {
        val shorts = shortArrayOf(0x0102, -1, 0, 0x7FFF.toShort(), (-32768).toShort())
        val bytes = shortsToPcm16Le(shorts)
        val recovered = pcm16LeToShorts(bytes)
        for (i in shorts.indices) {
            assertEquals(shorts[i], recovered[i], "Short[$i] mismatch")
        }
    }

    @Test
    fun le_byte_order_correct_for_known_short() {
        // Short 0x0102: low byte = 0x02, high byte = 0x01 in little-endian
        val bytes = shortsToPcm16Le(shortArrayOf(0x0102))
        assertEquals(0x02.toByte(), bytes[0], "Low byte must be 0x02")
        assertEquals(0x01.toByte(), bytes[1], "High byte must be 0x01")
    }

    @Test
    fun le_bytes_to_shorts_byte_order_correct() {
        // Bytes [0x02, 0x01] → short 0x0102 = 258
        val shorts = pcm16LeToShorts(byteArrayOf(0x02, 0x01))
        assertEquals(0x0102.toShort(), shorts[0])
    }

    // ---- Empty input ---------------------------------------------------------

    @Test
    fun float_to_shorts_empty_input_returns_empty() {
        assertEquals(0, floatToPcm16Shorts(floatArrayOf()).size)
    }

    @Test
    fun shorts_to_float_empty_input_returns_empty() {
        assertEquals(0, pcm16ShortsToFloat(shortArrayOf()).size)
    }

    @Test
    fun le_bytes_to_shorts_empty_input_returns_empty() {
        assertEquals(0, pcm16LeToShorts(byteArrayOf()).size)
    }

    @Test
    fun shorts_to_le_bytes_empty_input_returns_empty() {
        assertEquals(0, shortsToPcm16Le(shortArrayOf()).size)
    }
}
