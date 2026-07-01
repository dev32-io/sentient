package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// FakeEncoder returns 1 packet per drained frame (no kopus → runs on the JVM host).
// OpusEncoderPort also declares close(); implement it as a no-op so this compiles.
private class FakeEncoder : OpusEncoderPort {
    override fun encode(pcm: ShortArray): List<ByteArray> = listOf(ByteArray(4) { 9 })
    override fun reset() {}
    override fun close() {}
}

class VoiceUplinkPipelineTest {
    @Test fun emitted_frames_are_encoded_and_sent() = runTest {
        val mic = FakeVoiceAudio()
        mic.configure(mic = true, playback = false) // micActive → micFrames hot
        val sent = mutableListOf<ByteArray>()
        val d = UnconfinedTestDispatcher(testScheduler)
        val pipe = VoiceUplinkPipeline(
            micFrames = mic.micFrames,
            encoder = FakeEncoder(),
            sendPacket = { sent.add(it) },
            onOnset = {},
            scope = this,
            dispatcher = d,
            framer = Framer(),
            onset = OnsetDetector(0.05, 1),
        )
        pipe.start()
        // 3 emits of exactly FRAME_SAMPLES_16K → 3 frames → 3 packets (1:1 encoder).
        repeat(3) { mic.emit(ShortArray(FRAME_SAMPLES_16K) { 100 }) }
        testScheduler.advanceUntilIdle()
        assertEquals(3, sent.size, "expected one encoded packet per 20ms frame")
        pipe.stop()
        // After stop() the collect job is cancelled — late emits produce no more packets.
        repeat(2) { mic.emit(ShortArray(FRAME_SAMPLES_16K) { 100 }) }
        testScheduler.advanceUntilIdle()
        assertEquals(3, sent.size, "collect job must be cancelled after stop()")
    }

    @Test fun stop_before_start_is_noop() = runTest {
        val mic = FakeVoiceAudio()
        mic.configure(mic = true, playback = false)
        val sent = mutableListOf<ByteArray>()
        val d = UnconfinedTestDispatcher(testScheduler)
        val pipe = VoiceUplinkPipeline(
            micFrames = mic.micFrames,
            encoder = FakeEncoder(),
            sendPacket = { sent.add(it) },
            onOnset = {},
            scope = this,
            dispatcher = d,
            framer = Framer(),
            onset = OnsetDetector(0.05, 1),
        )
        // stop() with no active job must not throw and leaves sent empty.
        pipe.stop()
        assertTrue(sent.isEmpty())
    }
}
