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
// device — so deferring construction keeps the native code untouched on the JVM
// while staying transparent to the pipeline. Only decode() forces construction;
// reset()/close() before the first decode are true no-ops.
//
// RECREATE-AFTER-CLOSE: close() frees the native decoder AND drops the reference,
// so a later decode() builds a FRESH decoder. Without this, a transient teardown
// (reconnect) would leave a permanently-closed decoder: decode() would silently
// return empty (TTS goes dead) and reset() would abort on the freed native
// decoder. The decoder must survive a reconnect — see DecoderLifecycleTest.
// ---------------------------------------------------------------------------

class LazyOpusDecoderPort(
    private val factory: () -> OpusDecoderPort,
) : OpusDecoderPort {

    /** The live decoder, or null before the first decode / after a close(). */
    private var delegate: OpusDecoderPort? = null

    private fun live(): OpusDecoderPort = delegate ?: factory().also { delegate = it }

    override fun decode(oggChunk: ByteArray): List<ByteArray> = live().decode(oggChunk)

    /** Reset the live decoder if one exists; no-op before the first decode / after close. */
    override fun reset() {
        delegate?.reset()
    }

    /**
     * Free the native decoder AND drop the reference, so the next decode() rebuilds
     * a fresh one. A transient disconnect that closes the decoder must not leave it
     * permanently dead — the rebuild restores TTS on the next reconnect.
     */
    override fun close() {
        delegate?.close()
        delegate = null
    }
}
