package io.sentient.mobilesdk.audio.opus

// ---------------------------------------------------------------------------
// OpusDecoderPort — the downlink decode boundary the AudioPipeline depends on.
//
// The concrete OpusDownlinkDecoder wraps kopus, whose native libopus code does
// NOT load under the host-JVM testDebugUnitTest target. The pipeline therefore
// depends on THIS port (data in → PCM16-LE byte frames out), so commonTest can
// substitute a pure fake and pin the opus-mode wiring contract without touching
// native code. See OpusDownlinkDecoder for the real implementation.
// ---------------------------------------------------------------------------

interface OpusDecoderPort {

    /**
     * Push one OGG-Opus chunk; return every PCM16-LE byte frame it produced,
     * in order (one per opus audio packet that survived pre-skip).
     */
    fun decode(oggChunk: ByteArray): List<ByteArray>

    /** Reset demuxer + decoder + pre-skip state — call between TTS cycles. */
    fun reset()

    /** Release the underlying native decoder. Idempotent. */
    fun close()
}
