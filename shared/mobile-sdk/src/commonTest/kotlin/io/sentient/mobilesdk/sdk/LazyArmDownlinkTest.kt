// ---------------------------------------------------------------------------
// LazyArmDownlinkTest — KEEPER (per .claude/rules/testing.md): pins the lazy-arm
// downlink contract — the regression behind the "mic works, TTS silent" bug.
//
// The downlink engine is LAZY-ARMED on connector.audio.start (mirrors web-sdk's
// arm-on-audio.start model), NOT pre-armed at connect from the preference flag. A
// fresh connect with the engine at (mic=false, playback=false) must still deliver
// the first TTS frame: onAudioStart drives armPlayback() → the engine reaches
// playback-active, buffered frames flush to playFrame. Nothing calls setTtsEnabled
// and no session.preferences.changed is needed — arming follows the actual audio.
//
// This is the test that would have caught the silent-TTS regression: without lazy
// arming, playFrame's `if (!playbackActive) return` dropped every frame because
// nothing ever armed the player on a normal connect (the server echoes the default
// TTS-on preference, which PreferencesConnector dedups to a no-op).
//
// Wires a real SdkVoice serialized lane (Unconfined → deterministic drain) as the
// arm driver, exactly as SdkAudio does in production.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LazyArmDownlinkTest {

    /**
     * Lazy arm: with the engine idle (fresh connect, nothing configured, no
     * setTtsEnabled), the first TTS cycle's audio.start must arm the engine and the
     * first frame must reach playFrame — NOT be dropped by `if (!playbackActive) return`.
     */
    @Test
    fun audioStart_lazily_arms_engine_so_first_tts_frame_is_delivered() = runTest {
        // Engine + serialized configure lane, exactly as SdkAudio wires it. Unconfined →
        // the SdkVoice consumer drains inline so the arm ack resolves deterministically.
        val voiceAudio = FakeVoiceAudio()
        val voice = SdkVoice(
            voiceAudio = voiceAudio,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = {},
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )

        // The downlink pipeline drives lazy-arm through the SAME lambdas SdkAudio uses:
        // armPlayback = voice.armPlayback (suspends until playback-active), disarm = release.
        val pipeline = AudioPipeline(
            playback = voiceAudio,
            opusDecoder = FakeOpusDecoderPort(),
            fsm = AudioFsm(),
            scope = this,
            outputSampleRate = 24_000,
            onStateChanged = { _, _ -> },
            armPlayback = { voice.armPlayback() },
            disarmPlayback = { voice.requestPlayback(false) },
        )

        // Engine starts idle — the fresh-connect scenario. NOTHING armed the player.
        assertTrue(voiceAudio.configureCalls.isEmpty(), "no configure before the first cycle")

        // First TTS cycle. A frame arrives before the arm settles → buffered, not dropped.
        pipeline.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        pipeline.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        advanceUntilIdle() // run the arm job → voice.armPlayback → configure(playback=true) → flush

        // (1) audio.start armed the engine for playback (mic stays off — text path).
        val armed = voiceAudio.configureCalls.any { (mic, playback, _) -> !mic && playback }
        assertTrue(armed, "audio.start must lazily arm playback; configureCalls=${voiceAudio.configureCalls}")

        // (2) The buffered first frame is flushed to playFrame once armed, not dropped.
        assertEquals(
            1,
            voiceAudio.playedFrames.size,
            "first TTS frame delivered after lazy arm; playedFrames=${voiceAudio.playedFrames}",
        )
    }
}
