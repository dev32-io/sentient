package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.voice.io.FakeMicSource
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertTrue

// FakeEncoder returns 1 packet per drained frame (no kopus → runs on the JVM host).
// OpusEncoderPort also declares close(); implement it as a no-op so this compiles.
private class FakeEncoder : OpusEncoderPort {
    override fun encode(pcm: ShortArray): List<ByteArray> = listOf(ByteArray(4) { 9 })
    override fun reset() {}
    override fun close() {}
}

class VoiceUplinkPipelineTest {
    @Test fun frames_become_packets_sent_1_to_1() = runTest {
        val mic = FakeMicSource()
        val sent = mutableListOf<ByteArray>()
        val d = UnconfinedTestDispatcher(testScheduler)
        val pipe = VoiceUplinkPipeline(
            mic = mic, encoder = FakeEncoder(), sendPacket = { sent.add(it) }, onOnset = {},
            scope = this, dispatcher = d, framer = Framer(4), onset = OnsetDetector(0.05, 1),
        )
        pipe.start()
        mic.start()
        mic.emit(ShortArray(8) { 8000 }) // 8 samples → 2 frames of 4 → 2 packets
        testScheduler.advanceUntilIdle()
        assertTrue(sent.size == 2)
        pipe.stop()
    }

    @Test fun mic_channel_drops_newest_not_oldest_under_flood() = runTest {
        val mic = FakeMicSource(channelCapacity = 2)
        mic.start()
        val ok = (1..5).map { mic.emit(shortArrayOf(it.toShort(), 0, 0, 0)) }
        // first 2 buffered, rest dropped-newest while unconsumed
        assertTrue(ok.take(2).all { it } && ok.drop(2).any { !it })
    }
}
