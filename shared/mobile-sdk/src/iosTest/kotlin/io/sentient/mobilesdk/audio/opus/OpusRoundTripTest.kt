package io.sentient.mobilesdk.audio.opus

import eu.buney.kopus.OpusDecoder
import eu.buney.kopus.decode
import io.sentient.mobilesdk.audio.computeRms
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// OpusRoundTripTest — sanity that the kopus native binding actually links and
// round-trips on the iOS simulator. This lives in iosTest (NOT commonTest)
// because libopus native code does not load under the host JVM test target.
//
// Pins two live contracts the host-JVM tests cannot reach:
//   1. A 20 ms 16 kHz mono frame encodes to a plausible raw opus packet, and that
//      raw packet decodes back to ~320 samples carrying real energy (the
//      encoder→decoder native path is wired end to end).
//   2. The RE-CHUNK contract (A5): the encoder accepts arbitrary-length PCM,
//      emits exactly one packet per full 320-sample frame, and holds the sub-frame
//      remainder for the next call — proving the iOS variable-length capture path
//      (Pcm16Converter tap buffers ≠ 320) is correctly re-framed for libopus,
//      which requires EXACTLY one valid frame per opus_encode call.
// The full OGG + pre-skip downlink path is proven by e2e, not here.
// ---------------------------------------------------------------------------

private const val SAMPLE_RATE_HZ = 16_000
private const val FRAME_SAMPLES = 320
private const val TONE_HZ = 440.0
private const val AMPLITUDE = 0.5

class OpusRoundTripTest {

    private fun tone(samples: Int): ShortArray = ShortArray(samples) { i ->
        val t = i.toDouble() / SAMPLE_RATE_HZ
        (sin(2.0 * PI * TONE_HZ * t) * AMPLITUDE * Short.MAX_VALUE).toInt().toShort()
    }

    @Test
    fun encodesAndDecodesA20msTone() {
        val pcm = tone(FRAME_SAMPLES)
        val encoder = OpusUplinkEncoder()
        val packets = try {
            encoder.encode(pcm)
        } finally {
            encoder.close()
        }
        assertEquals(1, packets.size, "one 20 ms frame → exactly one raw opus packet")
        assertTrue(packets[0].isNotEmpty(), "encoder must produce a non-empty raw opus packet")

        // Decode the RAW packet directly (no OGG) at the same 16 kHz mono.
        val decoder = OpusDecoder(SAMPLE_RATE_HZ, 1)
        val decoded = try {
            decoder.decode(packets[0], FRAME_SAMPLES)
        } finally {
            decoder.close()
        }
        assertEquals(FRAME_SAMPLES, decoded.size, "decode must yield one 20 ms frame, got ${decoded.size}")
        assertTrue(computeRms(decoded) > 0.05, "decoded frame must carry the tone's energy")
    }

    @Test
    fun reChunksArbitraryLengthPcmInto20msFrames() {
        // 800 samples = 2 full 320-sample frames + a 160-sample remainder. One
        // encode() call must emit EXACTLY 2 packets and hold the 160-sample tail.
        val encoder = OpusUplinkEncoder()
        try {
            val first = encoder.encode(tone(800))
            assertEquals(2, first.size, "800 samples → 2 full 20 ms frames, remainder held")
            first.forEach { assertTrue(it.isNotEmpty(), "each re-chunked packet is non-empty") }

            // 160 more samples completes the held 160-sample remainder into a 3rd
            // full frame (160 + 160 = 320) → exactly one more packet, no remainder.
            val second = encoder.encode(tone(160))
            assertEquals(1, second.size, "held remainder + 160 = one more full frame")

            // A sub-frame input alone (< 320) emits nothing — it only accumulates.
            val third = encoder.encode(tone(100))
            assertEquals(0, third.size, "sub-frame input accumulates, emits no packet")

            // reset() drops the sub-frame remainder: the next sub-frame input still
            // can't complete a frame on its own → still 0 packets (no leftover).
            encoder.reset()
            val afterReset = encoder.encode(tone(100))
            assertEquals(0, afterReset.size, "reset dropped remainder; 100 alone is still sub-frame")
        } finally {
            encoder.close()
        }
    }
}
