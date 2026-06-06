package io.sentient.mobilesdk.audio.opus

// ---------------------------------------------------------------------------
// LazyOpusDecoderPort — defers construction of the real (native-backed) decoder
// until the first opus frame actually arrives.
//
// The concrete OpusDownlinkDecoder allocates a kopus OpusDecoder in its
// constructor, which loads native libopus. That native code does NOT load under
// the host-JVM testDebugUnitTest target, so eagerly building the decoder at SDK
// construction time crashes every full-SDK host test. The pipeline only touches
// the decoder in opus mode (decode/reset), and opus mode only runs on a real
// device — so wrapping the factory in `lazy {}` keeps the native code untouched
// on the JVM while staying transparent to the pipeline. Only decode() forces
// construction; reset()/close() before the first decode are true no-ops (the
// pipeline always reset()s a fresh decoder on the next opus audio.start anyway).
// ---------------------------------------------------------------------------

class LazyOpusDecoderPort(
    private val factory: () -> OpusDecoderPort,
) : OpusDecoderPort {

    private val delegate: OpusDecoderPort by lazy(factory)

    /** True once the underlying decoder has been instantiated (first decode). */
    private var instantiated = false

    override fun decode(oggChunk: ByteArray): List<ByteArray> {
        instantiated = true
        return delegate.decode(oggChunk)
    }

    /** No-op before the first decode — resetting a not-yet-built decoder is meaningless. */
    override fun reset() {
        if (instantiated) delegate.reset()
    }

    /** Only forward to the native decoder if it was ever built — else nothing to release. */
    override fun close() {
        if (instantiated) delegate.close()
    }
}
