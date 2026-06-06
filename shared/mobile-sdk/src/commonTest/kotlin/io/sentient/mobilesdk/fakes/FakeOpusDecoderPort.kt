package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.audio.opus.OpusDecoderPort

/**
 * Pure-Kotlin OpusDecoderPort double for commonTest. The real OpusDownlinkDecoder
 * wraps kopus/libopus native code that does NOT load under testDebugUnitTest, so
 * the pipeline depends on the port and tests substitute this fake.
 *
 * decode(chunk) returns whatever frames [script] maps for that exact chunk's
 * content (default: empty). reset/close calls are counted, and every chunk it was
 * asked to decode is recorded in [decodedChunks], in order.
 */
class FakeOpusDecoderPort(
    private val script: (ByteArray) -> List<ByteArray> = { emptyList() },
) : OpusDecoderPort {

    val decodedChunks = mutableListOf<ByteArray>()
    var resetCount = 0
        private set
    var closeCount = 0
        private set

    override fun decode(oggChunk: ByteArray): List<ByteArray> {
        decodedChunks += oggChunk
        return script(oggChunk)
    }

    override fun reset() { resetCount += 1 }

    override fun close() { closeCount += 1 }
}
