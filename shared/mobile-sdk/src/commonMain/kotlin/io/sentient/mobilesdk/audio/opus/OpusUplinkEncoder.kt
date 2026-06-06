package io.sentient.mobilesdk.audio.opus

import eu.buney.kopus.OpusApplication
import eu.buney.kopus.OpusEncoder
import eu.buney.kopus.encode
import eu.buney.kopus.setBitrate
import io.sentient.mobilesdk.log.createLogger

// ---------------------------------------------------------------------------
// OpusUplinkEncoder — thin kopus wrapper for the mic-uplink path.
//
// Mirrors gateway/webui/src/audio/opus-encoder.ts: 16 kHz mono, 20 ms frames,
// application=VOIP, 24 kbps, RAW opus packets (no OGG framing). One 320-sample
// PCM16 frame in → one raw opus packet out, ready to forward one-packet-per-WS
// -binary-frame to the gateway STT path.
//
// Pure commonMain over the kopus multiplatform dep — no platform imports. The
// native libopus code only runs on a real target (Android device / iOS sim or
// device); it does NOT load under the host JVM testDebugUnitTest target.
// ---------------------------------------------------------------------------

/** Uplink sample rate in Hz — must match the gateway STT contract (16 kHz). */
private const val SAMPLE_RATE_HZ = 16_000

/** Mono uplink — speech capture is single-channel. */
private const val CHANNELS = 1

/** Target bitrate in bits per second (24 kbps speech, per the web encoder). */
private const val BITRATE_BPS = 24_000

/** Samples per 20 ms frame at 16 kHz mono (16000 * 0.02). */
private const val FRAME_SAMPLES = 320

class OpusUplinkEncoder {

    private val log = createLogger("audio", "opus", "encoder")

    private val encoder = OpusEncoder(SAMPLE_RATE_HZ, CHANNELS, OpusApplication.Voip)
    private var closed = false

    init {
        val rc = encoder.setBitrate(BITRATE_BPS)
        log.info(
            "ready",
            mapOf(
                "sampleRate" to SAMPLE_RATE_HZ,
                "channels" to CHANNELS,
                "bitrate" to BITRATE_BPS,
                "frameSamples" to FRAME_SAMPLES,
                "setBitrateRc" to rc,
            ),
        )
    }

    /**
     * Encode one 20 ms frame ([FRAME_SAMPLES] samples @ 16 kHz mono) into a
     * single raw opus packet. Returns null for an empty/closed encoder or a
     * wrong-length frame (the caller frames upstream; this guards the boundary).
     */
    fun encode(frame: ShortArray): ByteArray? {
        if (closed) {
            log.warn("encode-after-close", mapOf("reason" to "encoder already closed"))
            return null
        }
        if (frame.isEmpty()) return null
        if (frame.size != FRAME_SAMPLES) {
            log.warn(
                "frame-size-mismatch",
                mapOf("reason" to "expected 20ms frame", "expected" to FRAME_SAMPLES, "got" to frame.size),
            )
            return null
        }
        val packet = encoder.encode(frame)
        log.debug("packet", mapOf("inSamples" to frame.size, "outBytes" to packet.size))
        return packet
    }

    /** Release the underlying libopus encoder. Idempotent. */
    fun close() {
        if (closed) return
        closed = true
        encoder.close()
        log.info("closed")
    }
}
