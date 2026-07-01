package io.sentient.mobilesdk.audio.opus

// ---------------------------------------------------------------------------
// OpusEncoderPort — the mic-uplink encode boundary the VoiceUplinkPipeline depends on.
//
// The concrete OpusUplinkEncoder wraps kopus, whose native libopus code does
// NOT load under the host-JVM testDebugUnitTest target. The pipeline therefore
// depends on THIS port (arbitrary-length PCM16 ShortArray in → zero or more raw
// opus packets out), so commonTest can substitute a pure fake and pin the
// encode/send wiring contract without touching native code. See
// OpusUplinkEncoder for the real (re-chunking) implementation.
// ---------------------------------------------------------------------------

interface OpusEncoderPort {

    /**
     * Append arbitrary-length [pcm] (16 kHz mono PCM16 samples) to the internal
     * accumulator and return every full 20 ms (320-sample) frame it now drains,
     * each as one raw opus packet, in order. The sub-frame remainder is held for
     * the next call.
     */
    fun encode(pcm: ShortArray): List<ByteArray>

    /** Clear the accumulator (drop any sub-frame remainder) — call per mic session. */
    fun reset()

    /** Release the underlying native encoder. Idempotent. */
    fun close()
}
