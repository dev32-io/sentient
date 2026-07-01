// ---------------------------------------------------------------------------
// SentientSdkPreferencesTest — KEEPER (per .claude/rules/testing.md): pins the
// C1 contract — a server-driven session.preferences.changed (TTS on by default)
// MUST arm the engine for playback so the first text-TTS frame is delivered, not
// silently dropped. Without this, only the app's setTtsEnabled toggle armed the
// player; a fresh connect with server-default TTS-on left voiceAudio.current at
// (false,false) and playFrame dropped every frame.
//
// Two halves of the C1 fix are pinned:
//  (1) SdkConnectors: a server-driven prefs change fires onPreferencesChanged
//      (the new callback) — NOT just deriver.prefs + emit. Verified by wiring the
//      callback to a real SdkVoice (Unconfined scope → deterministic consumer
//      drain, mirroring SdkVoiceTest) and asserting FakeVoiceAudio.configure landed
//      a (mic=false, playback=true) entry.
//  (2) Armed ⇒ frames delivered: with the engine armed by the server-prefs path,
//      AudioPipeline.onAudioStart + onAudioFrame route the first frame to
//      playFrame (playedFrames non-empty) — the regression C1 would have caught.
//
// No SentientSdk / WS pump — the SdkVoice serialized consumer runs on
// Dispatchers.Unconfined so trySend drains inline (deterministic under runTest).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.connectors.PreferencesConnector
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertTrue

class SentientSdkPreferencesTest {

    /**
     * C1: a server-driven session.preferences.changed with ttsEnabled=true must
     * drive voice.requestConfigure(playback=true) via SdkConnectors'
     * onPreferencesChanged callback, pre-starting the player. A subsequent downlink
     * audio frame must reach playFrame — NOT be dropped by `if (!playbackActive) return`.
     */
    @Test
    fun server_preferences_changed_arms_player_so_first_tts_frame_is_delivered() = runTest {
        // ── Engine + serialized configure lane (Unconfined → deterministic drain) ──
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

        // ── SdkConnectors with the C1 wiring: onPreferencesChanged → voice.requestConfigure ──
        // Mirrors SentientSdk's wiring (mic follows voiceMode; OFF on a fresh connect).
        val deriver = StateDeriver(FixedClock(0L))
        val connectors = SdkConnectors(
            deriver = deriver,
            emit = { },
            emitEvent = { },
            send = { },
            sendBinary = { },
            newId = { "req-1" },
            sessionsTimeoutMs = 5_000L,
            clock = FixedClock(0L),
            mintDebounceMs = 1_000L,
            onPreferencesChanged = { prefs ->
                voice.requestConfigure(mic = (deriver.voiceMode == VoiceMode.ACTIVE), playback = prefs.ttsEnabled)
            },
        )

        // The server pushes TTS-on with a channel that DIFFERS from the SDK local
        // default (channel="voice") so PreferencesConnector.onChange actually fires
        // (duplicate suppression no-ops an echo of the default). ttsEnabled is still
        // true (the C1 scenario: server-default TTS-on). The app NEVER calls
        // setTtsEnabled — this is the server-preference-sync path (the C1 gap).
        connectors.preferences.handle(
            ServerMessage.SessionPreferencesChanged(
                preferences = AudioPreferences(ttsEnabled = true, channel = "text"),
            ),
        )
        // Drain the SdkVoice serialized consumer (Unconfined → inline, but be explicit).
        advanceUntilIdle()

        // (1) The engine was armed for playback by the SERVER-prefs path: configureCalls
        // contains a (mic=false, playback=true) entry. Without C1 this is empty.
        val armed = voiceAudio.configureCalls.any { (mic, playback, _) -> !mic && playback }
        assertTrue(armed, "server prefs change must arm playback; configureCalls=${voiceAudio.configureCalls}")

        // (2) Armed ⇒ the first TTS frame is delivered, not dropped. Run the downlink
        // pipeline with the SAME FakeVoiceAudio as the playback sink and feed one frame.
        val pipeline = AudioPipeline(
            playback = voiceAudio,
            opusDecoder = FakeOpusDecoderPort(),
            fsm = AudioFsm(),
            scope = this,
            outputSampleRate = 24_000,
            onStateChanged = { _, _ -> },
        )
        pipeline.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        pipeline.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        advanceUntilIdle()

        assertTrue(
            voiceAudio.playedFrames.isNotEmpty(),
            "first TTS frame delivered (player armed by server prefs); playedFrames=${voiceAudio.playedFrames}",
        )
    }
}