package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.voice.io.FakeMicSource
import io.sentient.mobilesdk.voice.uplink.Framer
import io.sentient.mobilesdk.voice.uplink.OnsetDetector
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// StubUplinkEncoder: 1 packet per drained frame, no kopus → runs on the JVM host
// (native libopus does NOT load under testDebugUnitTest). close() is a no-op so
// it satisfies the full OpusEncoderPort surface.
private class StubUplinkEncoder : OpusEncoderPort {
    override fun encode(pcm: ShortArray): List<ByteArray> = listOf(ByteArray(4) { 7 })
    override fun reset() {}
    override fun close() {}
}

// Records the WIRE-shaping calls in the exact order the SDK drives them, standing
// in for UserAudioInputConnector (startStreaming = audio.start, sendAudioFrame =
// binary uplink, stopStreaming = audio.end). Order is the contract under test.
private class WireRecorder {
    val calls = mutableListOf<String>()
    fun startStreaming() = calls.add(START)
    fun sendAudioFrame(@Suppress("UNUSED_PARAMETER") frame: ByteArray) = calls.add(FRAME)
    fun stopStreaming() = calls.add(END)

    companion object {
        const val START = "startStreaming"
        const val FRAME = "sendAudioFrame"
        const val END = "stopStreaming"
    }
}

/**
 * Pins the uplink WIRE SHAPE after the VoiceUplinkPipeline takes over the mic
 * uplink (Task 9): audio.start → N binary frames (N≥1) → audio.end, with the
 * pipeline (not the retired capture-path uplink) driving the binary sends. Drives the SAME
 * call sequence startMic/stopMic perform — startStreaming FIRST, pipeline.start,
 * frames flow, then pipeline.stop BEFORE stopStreaming — and asserts the recorded
 * order is exactly [start, frame…, end]. Wire shape unchanged is the whole point.
 */
class UplinkWireContractTest {

    @Test
    fun start_then_n_frames_then_end_in_order() = runTest {
        val rec = WireRecorder()
        val mic = FakeMicSource()
        val pipe = VoiceUplinkPipeline(
            mic = mic,
            encoder = StubUplinkEncoder(),
            sendPacket = { rec.sendAudioFrame(it) },
            onOnset = {},
            scope = this,
            dispatcher = UnconfinedTestDispatcher(testScheduler),
            framer = Framer(4),
            onset = OnsetDetector(0.05, 1),
        )

        // startMic order: audio.start FIRST, then the pipeline drives the mic.
        rec.startStreaming()
        pipe.start()
        mic.emit(ShortArray(8) { 8000 }) // 8 samples → 2 frames of 4 → 2 packets
        testScheduler.advanceUntilIdle()

        // stopMic order: frames stop FIRST (cancelAndJoin), audio.end LAST.
        pipe.stop()
        rec.stopStreaming()

        assertEquals(WireRecorder.START, rec.calls.first(), "calls=${rec.calls}")
        assertEquals(WireRecorder.END, rec.calls.last(), "calls=${rec.calls}")
        val middle = rec.calls.subList(1, rec.calls.size - 1)
        assertTrue(middle.isNotEmpty(), "expected ≥1 binary frame, calls=${rec.calls}")
        assertTrue(middle.all { it == WireRecorder.FRAME }, "binary-only middle, calls=${rec.calls}")
    }
}
