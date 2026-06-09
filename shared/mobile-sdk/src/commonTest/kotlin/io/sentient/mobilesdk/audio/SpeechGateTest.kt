package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// SpeechGateTest — port of web-sdk speech-gate.test.ts FSM tests.
//
// Pins: closed-state sustained-speech counter, gap tolerance reset,
// debounce threshold, open flush, open passthrough, close/reopen, maxOpen failsafe.
//
// Counting mechanism: sustainedMs is ms-based (increments by frameDurationMs
// per speech frame); gap is frame-count-based (compared to gapToleranceFrames).
// See speech-gate.ts lines 75–80 for the authoritative logic.
//
// Config mirrors the TS test CFG:
//   openDebounceMs=200, frameDurationMs=10, gapToleranceFrames=3,
//   preRollFrames=24, maxOpenMs=20_000.
// ---------------------------------------------------------------------------

private val CFG = SpeechGateConfig(
    openDebounceMs = 200,
    frameDurationMs = 10,
    gapToleranceFrames = 3,
    preRollFrames = 24,
    maxOpenMs = 20_000,
)

private var counter = 0

private fun frame(): FloatArray {
    counter += 1
    return floatArrayOf(counter.toFloat())
}

private fun ids(frames: List<FloatArray>): List<Int> =
    frames.map { it[0].toInt() }

class SpeechGateTest {

    // Reset frame counter before each test via @BeforeTest is not available in
    // kotlin-test without a JVM runner. Use a fresh counter per test instead.

    // -----------------------------------------------------------------------
    // Stays closed while speech has not yet reached the debounce threshold
    // -----------------------------------------------------------------------

    @Test
    fun stays_closed_and_buffers_while_speech_has_not_yet_sustained() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        // 19 speech frames × 10ms = 190ms < 200ms openDebounceMs → still closed
        repeat(19) {
            now += 10
            val r = gate.process(frame(), isSpeech = true, nowMs = now)
            assertFalse(r.opened)
            assertEquals(emptyList(), r.forward)
        }
        assertEquals(SpeechGateState.CLOSED, gate.state())
    }

    // -----------------------------------------------------------------------
    // Opens on the 20th consecutive speech frame and flushes buffered onset
    // -----------------------------------------------------------------------

    @Test
    fun opens_on_frame_that_reaches_debounce_and_flushes_preroll() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        val sent = mutableListOf<FloatArray>()
        var opened = false
        // 200ms / 10ms = 20 frames; frame 20 triggers; frames 1–19 do not
        repeat(20) {
            now += 10
            val r = gate.process(frame(), isSpeech = true, nowMs = now)
            if (r.opened) opened = true
            sent.addAll(r.forward)
        }
        assertTrue(opened)
        assertEquals(SpeechGateState.OPEN, gate.state())
        // All 20 frames forwarded (pre-roll holds up to 24, gate had 20)
        assertEquals((1..20).toList(), ids(sent))
    }

    // -----------------------------------------------------------------------
    // Forwards every frame once open, including non-speech trailing silence
    // -----------------------------------------------------------------------

    @Test
    fun forwards_every_frame_once_open_including_non_speech() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        // Open the gate
        repeat(20) { now += 10; gate.process(frame(), isSpeech = true, nowMs = now) }
        assertEquals(SpeechGateState.OPEN, gate.state())

        // Speech frame forwarded
        now += 10
        val sp = frame()
        assertEquals(listOf(sp[0].toInt()), ids(gate.process(sp, isSpeech = true, nowMs = now).forward))

        // Silence frame forwarded too
        now += 10
        val sil = frame()
        assertEquals(listOf(sil[0].toInt()), ids(gate.process(sil, isSpeech = false, nowMs = now).forward))
    }

    // -----------------------------------------------------------------------
    // Never opens on a transient shorter than debounce (cough / knock)
    // -----------------------------------------------------------------------

    @Test
    fun never_opens_on_transient_shorter_than_debounce() {
        counter = 0
        val gate = createSpeechGate(CFG) // 200ms debounce, gapTolerance=3
        var now = 0L
        // 10 speech frames (100ms)
        repeat(10) {
            now += 10
            assertFalse(gate.process(frame(), isSpeech = true, nowMs = now).opened)
        }
        // 4 non-speech frames (> gapToleranceFrames=3) → sustainedMs resets
        repeat(4) { now += 10; gate.process(frame(), isSpeech = false, nowMs = now) }
        // 5 more speech frames (only 50ms fresh) → still closed
        repeat(5) {
            now += 10
            assertFalse(gate.process(frame(), isSpeech = true, nowMs = now).opened)
        }
        assertEquals(SpeechGateState.CLOSED, gate.state())
    }

    // -----------------------------------------------------------------------
    // Brief sub-threshold flicker is tolerated; gate still reaches open
    // -----------------------------------------------------------------------

    @Test
    fun tolerates_brief_flicker_and_still_reaches_open() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        var opened = false
        // 18 speech frames (180ms)
        repeat(18) { now += 10; if (gate.process(frame(), isSpeech = true, nowMs = now).opened) opened = true }
        // 1 non-speech flicker (gap=1 ≤ gapToleranceFrames=3, sustainedMs stays)
        now += 10; gate.process(frame(), isSpeech = false, nowMs = now)
        // 3 more speech frames (30ms, total sustained now covers ≥ 200ms)
        repeat(3) { now += 10; if (gate.process(frame(), isSpeech = true, nowMs = now).opened) opened = true }
        assertTrue(opened)
        assertEquals(SpeechGateState.OPEN, gate.state())
    }

    // -----------------------------------------------------------------------
    // close() resets an open gate and clears the ring
    // -----------------------------------------------------------------------

    @Test
    fun close_resets_open_gate_and_clears_ring() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        repeat(20) { now += 10; gate.process(frame(), isSpeech = true, nowMs = now) }
        assertEquals(SpeechGateState.OPEN, gate.state())
        gate.close()
        assertEquals(SpeechGateState.CLOSED, gate.state())
    }

    // -----------------------------------------------------------------------
    // Gate reopens for a fresh utterance after close()
    // -----------------------------------------------------------------------

    @Test
    fun reopens_for_fresh_utterance_after_close() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        repeat(20) { now += 10; gate.process(frame(), isSpeech = true, nowMs = now) }
        gate.close()
        var opened = false
        repeat(20) {
            now += 10
            if (gate.process(frame(), isSpeech = true, nowMs = now).opened) opened = true
        }
        assertTrue(opened)
        assertEquals(SpeechGateState.OPEN, gate.state())
    }

    // -----------------------------------------------------------------------
    // maxOpenMs failsafe force-closes and returns empty forward
    // -----------------------------------------------------------------------

    @Test
    fun force_closes_after_maxOpenMs_when_no_transcript_arrives() {
        counter = 0
        val gate = createSpeechGate(CFG)
        var now = 0L
        repeat(20) { now += 10; gate.process(frame(), isSpeech = true, nowMs = now) }
        assertEquals(SpeechGateState.OPEN, gate.state())
        // Jump time far beyond maxOpenMs=20_000
        val r = gate.process(frame(), isSpeech = true, nowMs = 100_000)
        assertEquals(emptyList(), r.forward)
        assertFalse(r.opened)
        assertEquals(SpeechGateState.CLOSED, gate.state())
    }
}
