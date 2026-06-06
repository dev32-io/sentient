package io.sentient.mobilesdk.audio.opus

import eu.buney.kopus.OPUS_RESET_STATE
import eu.buney.kopus.OpusDecoder
import io.sentient.mobilesdk.audio.shortsToPcm16Le
import io.sentient.mobilesdk.log.createLogger

// ---------------------------------------------------------------------------
// OpusDownlinkDecoder — thin kopus wrapper for the TTS downlink path.
//
// Mirrors gateway/webui/src/audio/opus-decoder.ts: OGG-Opus chunks (Fish Audio
// TTS) in → 48 kHz mono PCM16 LE bytes out. libopus always decodes to a fixed
// internal rate; we run it at 48 kHz (the opus canonical rate) and let the
// playback adapter resample. State is stateful across chunks and reset between
// cycles.
//
// Composition: owns an OggOpusDemuxer (OGG page → raw opus packet) + a kopus
// OpusDecoder. Per RFC 7845 the first preSkip samples of the decoded stream are
// encoder pre-roll and MUST be dropped from the very start of output; preSkip
// comes from the demuxer's parsed OpusHead and may not be known until the first
// audio packet is decoded, so we re-arm the skip counter lazily.
//
// Pure commonMain over the kopus multiplatform dep — no platform imports. The
// native libopus code does NOT load under the host JVM testDebugUnitTest target.
// ---------------------------------------------------------------------------

/** Downlink decode sample rate in Hz — libopus canonical 48 kHz. */
private const val SAMPLE_RATE_HZ = 48_000

/** Mono downlink — TTS output is single-channel. */
private const val CHANNELS = 1

/** Max opus frame duration is 120 ms; 48000 * 0.12 = 5760 samples per channel. */
private const val MAX_FRAME_SAMPLES = 5_760

class OpusDownlinkDecoder : OpusDecoderPort {

    private val log = createLogger("audio", "opus", "decoder")

    private val demuxer = OggOpusDemuxer()
    private val decoder = OpusDecoder(SAMPLE_RATE_HZ, CHANNELS)
    private val scratch = ShortArray(MAX_FRAME_SAMPLES)

    /** Remaining encoder pre-roll samples to drop; -1 until preSkip is known. */
    private var samplesToSkip = -1
    private var closed = false

    /**
     * Push one OGG-Opus chunk; return every decoded PCM16-LE byte frame it
     * produced (one per opus audio packet that survived pre-skip), in order.
     */
    override fun decode(oggChunk: ByteArray): List<ByteArray> {
        if (closed || oggChunk.isEmpty()) return emptyList()
        val packets = demuxer.push(oggChunk)
        if (packets.isEmpty()) return emptyList()
        armSkipIfNeeded()
        val frames = mutableListOf<ByteArray>()
        var dropped = 0
        for (packet in packets) {
            val decoded = decodePacket(packet) ?: continue
            val kept = applyPreSkip(decoded)
            dropped += decoded.size - kept.size
            if (kept.isNotEmpty()) frames.add(shortsToPcm16Le(kept))
        }
        log.debug(
            "decode",
            mapOf("packetsIn" to packets.size, "framesOut" to frames.size, "preSkipDropped" to dropped),
        )
        return frames
    }

    /** Reset demuxer + decoder + pre-skip counter — call between TTS cycles. */
    override fun reset() {
        demuxer.reset()
        decoder.ctl(OPUS_RESET_STATE, 0)
        samplesToSkip = -1
        log.info("reset")
    }

    /** Release the underlying libopus decoder. Idempotent. */
    override fun close() {
        if (closed) return
        closed = true
        decoder.close()
        log.info("closed")
    }

    /** Pick up preSkip from the demuxer once OpusHead has been parsed. */
    private fun armSkipIfNeeded() {
        if (samplesToSkip >= 0) return
        if (demuxer.preSkip <= 0) {
            samplesToSkip = 0
            return
        }
        samplesToSkip = demuxer.preSkip
        log.debug("preskip-armed", mapOf("preSkip" to demuxer.preSkip))
    }

    /** Decode one raw opus packet into a freshly-sized ShortArray, or null on error. */
    private fun decodePacket(packet: ByteArray): ShortArray? {
        val n = decoder.decode(
            inData = packet,
            inDataOffset = 0,
            len = packet.size,
            outPcm = scratch,
            outPcmOffset = 0,
            frameSize = MAX_FRAME_SAMPLES,
            decodeFec = false,
        )
        if (n <= 0) {
            log.warn("decode-error", mapOf("reason" to "kopus returned <= 0", "rc" to n, "packetBytes" to packet.size))
            return null
        }
        return scratch.copyOfRange(0, n)
    }

    /** Drop leading encoder pre-roll samples; return the surviving tail. */
    private fun applyPreSkip(decoded: ShortArray): ShortArray {
        if (samplesToSkip <= 0) return decoded
        val drop = minOf(samplesToSkip, decoded.size)
        samplesToSkip -= drop
        return if (drop >= decoded.size) ShortArray(0) else decoded.copyOfRange(drop, decoded.size)
    }
}
