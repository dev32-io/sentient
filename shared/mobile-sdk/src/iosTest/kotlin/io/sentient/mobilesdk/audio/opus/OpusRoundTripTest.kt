package io.sentient.mobilesdk.audio.opus

import eu.buney.kopus.OpusDecoder
import eu.buney.kopus.decode
import io.sentient.mobilesdk.audio.computeRms
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// OpusRoundTripTest — sanity that the kopus native binding actually links and
// round-trips on the iOS simulator. This lives in iosTest (NOT commonTest)
// because libopus native code does not load under the host JVM test target.
//
// It pins the live contract: a 20 ms 16 kHz mono frame encodes to a plausible
// raw opus packet, and that raw packet decodes back to ~320 samples carrying
// real energy (proving the encoder→decoder native path is wired end to end).
// The full OGG + pre-skip downlink path is proven by e2e, not here.
// ---------------------------------------------------------------------------

private const val SAMPLE_RATE_HZ = 16_000
private const val FRAME_SAMPLES = 320
private const val TONE_HZ = 440.0
private const val AMPLITUDE = 0.5

class OpusRoundTripTest {

    @Test
    fun encodesAndDecodesA20msTone() {
        val pcm = ShortArray(FRAME_SAMPLES) { i ->
            val t = i.toDouble() / SAMPLE_RATE_HZ
            (sin(2.0 * PI * TONE_HZ * t) * AMPLITUDE * Short.MAX_VALUE).toInt().toShort()
        }

        val encoder = OpusUplinkEncoder()
        val packet = try {
            encoder.encode(pcm)
        } finally {
            encoder.close()
        }
        assertTrue(packet != null && packet.isNotEmpty(), "encoder must produce a non-empty raw opus packet")

        // Decode the RAW packet directly (no OGG) at the same 16 kHz mono.
        val decoder = OpusDecoder(SAMPLE_RATE_HZ, 1)
        val decoded = try {
            decoder.decode(packet, FRAME_SAMPLES)
        } finally {
            decoder.close()
        }
        assertTrue(decoded.size == FRAME_SAMPLES, "decode must yield one 20 ms frame, got ${decoded.size}")
        assertTrue(computeRms(decoded) > 0.05, "decoded frame must carry the tone's energy")
    }
}
