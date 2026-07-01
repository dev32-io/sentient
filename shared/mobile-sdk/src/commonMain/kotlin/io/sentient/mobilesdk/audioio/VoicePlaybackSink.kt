package io.sentient.mobilesdk.audioio

/**
 * The downlink-facing slice of [io.sentient.mobilesdk.voice.io.VoiceAudio].
 *
 * `AudioPipeline` depends on this 3-method slice (not the whole engine interface) so
 * the downlink codec/FSM logic is testable against `FakeVoiceAudio` without a mic /
 * encoder. `VoiceAudio` already declares these three members — it satisfies this
 * interface structurally, and the iOS/Android actuals + `FakeVoiceAudio` inherit that
 * satisfaction with no further changes.
 *
 * The player is PRE-STARTED by `VoiceAudio.configure(playback = true)` at 48 kHz (the
 * gateway is end-to-end Opus). Callers therefore feed PCM16 frames straight to
 * [playFrame]; there is no async `start(rate)` race to gate on.
 */
interface VoicePlaybackSink {
    /** Downlink sink: one PCM16 LE frame → playback. No-op if playback is not active. */
    fun playFrame(pcm16: ByteArray)

    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun flushPlayback()

    /**
     * Idle when no scheduled buffer remains — every fed frame has PHYSICALLY finished
     * playing out the device, not merely been handed off. The pipeline polls this after
     * `audio.done` to hold the "speaking" state (and the interrupt affordance) until the
     * speaker tail actually drains.
     */
    val isPlaybackIdle: Boolean
}
