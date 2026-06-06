package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort

/**
 * Pure-Kotlin OpusEncoderPort double for commonTest. The real OpusUplinkEncoder
 * wraps kopus/libopus native code that does NOT load under testDebugUnitTest, so
 * the pump depends on the port and tests substitute this fake.
 *
 * encode(pcm) returns whatever packets [script] maps for that exact PCM's content
 * (default: one synthetic packet per call), and records every ShortArray it was
 * asked to encode in [encoded], in order. reset/close calls are counted.
 */
class FakeOpusEncoderPort(
    private val script: (ShortArray) -> List<ByteArray> = { listOf(byteArrayOf(it.size.toByte())) },
) : OpusEncoderPort {

    val encoded = mutableListOf<ShortArray>()
    var resetCount = 0
        private set
    var closeCount = 0
        private set

    override fun encode(pcm: ShortArray): List<ByteArray> {
        encoded += pcm
        return script(pcm)
    }

    override fun reset() { resetCount += 1 }

    override fun close() { closeCount += 1 }
}
