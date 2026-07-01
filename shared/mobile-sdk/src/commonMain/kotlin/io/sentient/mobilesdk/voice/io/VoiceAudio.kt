package io.sentient.mobilesdk.voice.io

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * The single audio-engine boundary for the SDK. ONE engine (iOS: one AVAudioEngine;
 * Android: one AudioRecord + one AudioTrack) serves every (mic, playback) state.
 * Callers never see AVAudioEngine / VPIO / AudioRecord — full encapsulation, matching
 * the SDK's black-box philosophy.
 *
 * Toggle is ONE idempotent [configure] call: it diffs the desired graph against the
 * current graph, stops the engine, reconfigures (tap / player / VPIO), and restarts.
 * No second engine, no AVAudioSession handoff — the StartIO-on-dirty-session bug
 * class is deleted by construction.
 */
interface VoiceAudio {
    /** Continuous readiness state (StateFlow — conflation fine). UI: spinner on Configuring. */
    val state: StateFlow<VoiceAudioState>

    /** 16k mono PCM16 capture frames. Hot ONLY while micActive; bounded, drop-newest. */
    val micFrames: Flow<ShortArray>

    /**
     * THE reconfig call. Idempotent — no-op if already in (mic, playback). Diffs +
     * reconfigures the single engine (stop → reconfigure → start). Suspends until the
     * reconfigure settles (→ Ready) or fails (→ Error). Never throws.
     *
     * @param playbackRateHz Player prepare rate. Defaults to 48_000 (libopus decode rate;
     *   the gateway is end-to-end Opus). Do not pass a non-48k rate unless a future
     *   pcm16 passthrough stream requires it (currently dead in production).
     */
    suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int = 48_000)

    /** Downlink sink: one PCM16 LE frame → playback. No-op if playbackActive is false. */
    fun playFrame(pcm16: ByteArray)

    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun flushPlayback()

    /** Idle when no scheduled buffer remains (pipeline holds "speaking" until the tail drains). */
    val isPlaybackIdle: Boolean

    /** Terminal teardown: stop engine + deactivate session + release. */
    suspend fun shutdown()
}

/** Reactive engine readiness for the UI + the SDK reconfig surface. */
data class VoiceAudioState(
    val phase: Phase,
    val micActive: Boolean,
    val playbackActive: Boolean,
    val errorReason: String? = null,
) {
    enum class Phase { Idle, Configuring, Ready, Error }
}