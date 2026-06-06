package io.sentient.mobilesdk.audio.opus

import eu.buney.kopus.OpusApplication
import eu.buney.kopus.OpusEncoder
import eu.buney.kopus.encode
import eu.buney.kopus.setBitrate
import io.sentient.mobilesdk.log.createLogger

// ---------------------------------------------------------------------------
// OpusUplinkEncoder — re-chunking kopus wrapper for the mic-uplink path.
//
// Mirrors gateway/webui/src/audio/opus-encoder.ts: 16 kHz mono, 20 ms frames,
// application=VOIP, 24 kbps, RAW opus packets (no OGG framing). The gateway STT
// socket expects one raw opus packet per WS-binary frame on ?audioFormat=opus.
//
// RE-CHUNKING: libopus opus_encode requires EXACTLY one valid frame per call —
// at 16 kHz that is a 20 ms frame = [FRAME_SAMPLES] samples. It does NOT buffer
// internally. The capture/gate/pre-roll path forwards VARIABLE-length PCM frames
// (Android emits 320-sample frames reliably; iOS Pcm16Converter over AVAudioEngine
// tap buffers emits arbitrary lengths). So this encoder accumulates incoming PCM,
// drains one packet per full 320-sample frame, and holds the sub-frame remainder
// for the next call. A <320 remainder is DROPPED on reset/close (a sub-20 ms tail
// is negligible for STT — no zero-padding, which would inject silence energy).
//
// Pure commonMain over the kopus multiplatform dep — no platform imports. The
// native libopus code only runs on a real target (Android device / iOS sim or
// device); it does NOT load under the host JVM testDebugUnitTest target — the
// pump depends on OpusEncoderPort + LazyOpusEncoderPort so host tests stay clean.
// ---------------------------------------------------------------------------

/** Uplink sample rate in Hz — must match the gateway STT contract (16 kHz). */
private const val SAMPLE_RATE_HZ = 16_000

/** Mono uplink — speech capture is single-channel. */
private const val CHANNELS = 1

/** Target bitrate in bits per second (24 kbps speech, per the web encoder). */
private const val BITRATE_BPS = 24_000

/** Samples per 20 ms frame at 16 kHz mono (16000 * 0.02) — libopus' required frame size. */
private const val FRAME_SAMPLES = 320

class OpusUplinkEncoder : OpusEncoderPort {

    private val log = createLogger("audio", "opus", "encoder")

    private val encoder = OpusEncoder(SAMPLE_RATE_HZ, CHANNELS, OpusApplication.Voip)
    private var closed = false

    /** Sub-frame PCM carried over between encode() calls (always < FRAME_SAMPLES). */
    private var remainder = ShortArray(0)

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
     * Append [pcm] to the carried remainder and drain one raw opus packet per
     * full [FRAME_SAMPLES] frame; keep the sub-frame tail for the next call.
     * Returns the packets in order (possibly empty when not yet a full frame).
     */
    override fun encode(pcm: ShortArray): List<ByteArray> {
        if (closed) {
            log.warn("encode-after-close", mapOf("reason" to "encoder already closed"))
            return emptyList()
        }
        if (pcm.isEmpty() && remainder.isEmpty()) return emptyList()
        val buffer = if (remainder.isEmpty()) pcm else remainder + pcm
        val packets = drainFrames(buffer)
        val consumed = packets.size * FRAME_SAMPLES
        remainder = buffer.copyOfRange(consumed, buffer.size)
        log.debug(
            "encode",
            mapOf(
                "framesIn" to pcm.size,
                "packetsOut" to packets.size,
                "bytes" to packets.sumOf { it.size },
                "remainder" to remainder.size,
            ),
        )
        return packets
    }

    /** Encode every full 320-sample frame in [buffer] into a raw opus packet, in order. */
    private fun drainFrames(buffer: ShortArray): List<ByteArray> {
        val full = buffer.size / FRAME_SAMPLES
        if (full == 0) return emptyList()
        val packets = ArrayList<ByteArray>(full)
        var offset = 0
        repeat(full) {
            val frame = buffer.copyOfRange(offset, offset + FRAME_SAMPLES)
            packets.add(encoder.encode(frame))
            offset += FRAME_SAMPLES
        }
        return packets
    }

    /** Clear the carried remainder — call per mic session. Drops a sub-frame tail. */
    override fun reset() {
        if (remainder.isNotEmpty()) {
            log.debug("reset", mapOf("droppedRemainder" to remainder.size))
        }
        remainder = ShortArray(0)
    }

    /** Release the underlying libopus encoder. Idempotent. Drops any remainder. */
    override fun close() {
        if (closed) return
        closed = true
        remainder = ShortArray(0)
        encoder.close()
        log.info("closed")
    }
}
