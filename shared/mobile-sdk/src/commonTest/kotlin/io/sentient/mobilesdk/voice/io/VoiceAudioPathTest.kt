package io.sentient.mobilesdk.voice.io

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * A minimal VoiceAudio that overrides ONLY the pre-existing 3-arg [configure] — the exact
 * shape of VoiceAudio.ios.kt / VoiceAudio.android.kt (S3b requirement: both actuals compile
 * UNCHANGED). It never overrides the new path-carrying overload, so calling THAT overload on
 * it must resolve to the interface's default body (`= configure(mic, playback, playbackRateHz)`).
 */
private class ThreeArgOnlyVoiceAudio : VoiceAudio {
    override val state: StateFlow<VoiceAudioState> =
        MutableStateFlow(VoiceAudioState(VoiceAudioState.Phase.Idle, micActive = false, playbackActive = false))
    override val micFrames = emptyFlow<ShortArray>()

    val configureCalls = mutableListOf<Triple<Boolean, Boolean, Int>>()

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        configureCalls += Triple(mic, playback, playbackRateHz)
    }

    override fun playFrame(pcm16: ByteArray) {}
    override fun flushPlayback() {}
    override val isPlaybackIdle: Boolean = true
    override suspend fun shutdown() {}
}

/**
 * Pins [VoiceAudio]'s default-delegating path-carrying `configure` overload (S3b): a caller
 * that only implements the pre-existing 3-arg method must still work correctly when invoked
 * through the new 4-arg overload — the whole point of the default body is that platform
 * actuals need NOT be touched to add the routing hint.
 */
class VoiceAudioPathTest {

    @Test
    fun path_overload_delegates_to_3arg_when_only_3arg_is_overridden() = runTest {
        val va = ThreeArgOnlyVoiceAudio()
        va.configure(mic = true, playback = false, path = VoiceAudioPath.Manual)
        assertEquals(
            listOf(Triple(true, false, 48_000)),
            va.configureCalls,
            "default body forwards to the 3-arg override with the default playbackRateHz; the path hint is silently dropped, exactly as documented",
        )
    }

    @Test
    fun path_overload_respects_an_explicit_playbackRateHz() = runTest {
        val va = ThreeArgOnlyVoiceAudio()
        va.configure(mic = false, playback = true, path = VoiceAudioPath.Duplex, playbackRateHz = 16_000)
        assertEquals(listOf(Triple(false, true, 16_000)), va.configureCalls)
    }
}
