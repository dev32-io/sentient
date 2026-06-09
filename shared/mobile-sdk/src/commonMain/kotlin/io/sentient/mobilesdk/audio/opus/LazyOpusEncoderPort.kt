package io.sentient.mobilesdk.audio.opus

// ---------------------------------------------------------------------------
// LazyOpusEncoderPort — defers construction of the real (native-backed) encoder
// until the first mic frame actually arrives.
//
// The concrete OpusUplinkEncoder allocates a kopus OpusEncoder in its
// constructor, which loads native libopus. That native code does NOT load under
// the host-JVM testDebugUnitTest target, so eagerly building the encoder at SDK
// construction time crashes every full-SDK host test. The pump only touches the
// encoder once mic capture forwards a frame, and capture only runs on a real
// device — so wrapping the factory in `lazy {}` keeps the native code untouched
// on the JVM while staying transparent to the pump. Only encode() forces
// construction; reset()/close() before the first encode are true no-ops (the
// pump always reset()s a fresh encoder on the next mic-session start anyway).
// ---------------------------------------------------------------------------

class LazyOpusEncoderPort(
    private val factory: () -> OpusEncoderPort,
) : OpusEncoderPort {

    private val delegate: OpusEncoderPort by lazy(factory)

    /** True once the underlying encoder has been instantiated (first encode). */
    private var instantiated = false

    override fun encode(pcm: ShortArray): List<ByteArray> {
        instantiated = true
        return delegate.encode(pcm)
    }

    /** No-op before the first encode — resetting a not-yet-built encoder is meaningless. */
    override fun reset() {
        if (instantiated) delegate.reset()
    }

    /** Only forward to the native encoder if it was ever built — else nothing to release. */
    override fun close() {
        if (instantiated) delegate.close()
    }
}
