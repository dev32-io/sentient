// ---------------------------------------------------------------------------
// AudioPipelineTest — KEEPER (per .claude/rules/testing.md): pins E3 DOWNLINK
// invariants that would only surface in E5/E6 real-audio smoke — late + expensive.
//
// The mic UPLINK (continuous-minus-echo capture → gate → encode) moved to the
// voice/ package (VoiceAudio.micFrames → VoiceUplinkPipeline); AudioPipeline is
// now downlink-only. This file pins the downlink playback + FSM contracts NOT
// already covered by AudioPipelineDownlinkTest:
//
//   - audio.start marks speaking (isSpeaking latch) + LAZY-ARMS the engine; frames that
//     arrive before the arm settles buffer, then flush once armed (no clipped onset).
//   - a binary frame reaches the player via playFrame once armed.
//   - playback.stop (barge-in / interrupt) flushes the player (flushPlayback) + routes
//     the FSM ASSISTANT_SPEAKING → INTERRUPTING.
//   - TEXT path: TTS still flips isSpeaking even though the FSM stays INACTIVE
//     (voiceMode OFF) — the isSpeaking/FSM decoupling (webui isAudioPlaying).
//
// Drives a FakeVoiceAudio via an armPlayback lambda that configures it (mirrors the real
// SdkVoice.armPlayback → engine.configure(playback=true)) + a real AudioFsm under runTest
// virtual time. No hardware, no real clock.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineTest {

    // ── Fakes ───────────────────────────────────────────────────────────────────

    /**
     * Build a pipeline whose lazy-arm actually configures [sink] for playback — mirrors
     * production (SdkVoice.armPlayback → VoiceAudio.configure(playback=true)). The arm
     * runs on [scope] (the test scheduler), so a test must advanceUntilIdle() before
     * asserting a frame reached the player.
     */
    private fun pipeline(
        sink: FakeVoiceAudio?,
        scope: CoroutineScope,
        fsm: AudioFsm = AudioFsm(),
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
    ): AudioPipeline = AudioPipeline(
        playback = sink,
        opusDecoder = FakeOpusDecoderPort(),
        fsm = fsm,
        scope = scope,
        outputSampleRate = 24000,
        onStateChanged = onStateChanged,
        armPlayback = { sink?.configure(mic = false, playback = true); true },
        disarmPlayback = { },
    )

    // ── DOWNLINK: playback + isSpeaking ───────────────────────────────────────────

    @Test
    fun audioStart_marks_speaking_and_lazy_arms_then_delivers_frame() = runTest {
        var speaking = false
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this, onStateChanged = { sp, _ -> speaking = sp })
        p.onAudioStart("c1")
        assertTrue(speaking, "isSpeaking=true synchronously on audio.start")
        // Frame arrives before the async arm settles → buffered, not dropped.
        p.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        assertEquals(0, sink.playedFrames.size, "frame buffered until the engine is armed")
        advanceUntilIdle() // run the arm job → configure(playback=true) → flush buffered
        assertEquals(1, sink.playedFrames.size, "buffered frame flushed to playFrame once armed")
    }

    @Test
    fun audioFrame_isFed_to_playFrame_after_arm() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)
        p.onAudioStart("c1")
        advanceUntilIdle() // arm settles
        p.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        assertEquals(1, sink.playedFrames.size, "frame delivered via playFrame once armed")
    }

    @Test
    fun playbackStop_flushes_playback_and_routes_to_interrupting() = runTest {
        val states = mutableListOf<AudioState>()
        val sink = FakeVoiceAudio()
        // Voice-mode barge-in: FSM already in ASSISTANT_SPEAKING when playback.stop lands.
        val p = pipeline(
            sink, this,
            fsm = AudioFsm(AudioState.ASSISTANT_SPEAKING),
            onStateChanged = { _, s -> states += s },
        )
        p.onAudioStart("c1")
        advanceUntilIdle()
        p.onPlaybackStop("barge-in", "c1")
        assertEquals(1, sink.flushCount, "playback flushed (flushPlayback) on barge-in")
        assertEquals(AudioState.INTERRUPTING, states.last(), "FSM → interrupting on playback.stop")
    }

    @Test
    fun text_path_audio_marks_speaking_even_with_fsm_inactive() = runTest {
        // TEXT path: voiceMode OFF → FSM stays INACTIVE, but TTS still plays so
        // isSpeaking must flip (mirrors webui isAudioPlaying). Pins the decoupling.
        var speaking = false
        var lastState = AudioState.LISTENING
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this, onStateChanged = { sp, s -> speaking = sp; lastState = s })
        p.onAudioStart("c1")
        assertTrue(speaking, "isSpeaking=true on text-path audio.start")
        assertEquals(AudioState.INACTIVE, lastState, "FSM stays INACTIVE on the text path")
        advanceUntilIdle() // arm settles
        p.onAudioDone("c1")
        // Held past audio.done while the player drains its tail (mirrors webui isAudioPlaying);
        // clears once the player reports idle + the settle elapses.
        assertTrue(speaking, "isSpeaking held after text-path audio.done while the tail plays")
        advanceUntilIdle()
        assertTrue(!speaking, "isSpeaking clears once the text-path player physically drained")
    }
}
