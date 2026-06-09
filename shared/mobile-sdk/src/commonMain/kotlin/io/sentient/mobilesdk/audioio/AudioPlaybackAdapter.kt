// ---------------------------------------------------------------------------
// AudioPlaybackAdapter — boundary interface for platform PCM playback.
//
// Mirrors web-sdk's audio-output adapter ROLE: the platform owns AudioTrack
// (Android) / AVAudioEngine player node (iOS) lifecycle; the commonMain pipeline
// (E3) feeds it the assistant PCM downlink via [enqueue], and the
// AssistantAudioResponseConnector's drop-guard drives [clear] on barge-in /
// interrupt so queued audio is dropped immediately. commonMain INTERFACE only —
// no platform types (ByteArray / primitives), per
// .claude/rules/mobile-sdk/expect-actual-contract.md. `actual` lands in E2; a
// fake double lives in commonTest.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

/**
 * Platform audio playback for assistant PCM16 LE frames.
 *
 * Lifecycle: [start] opens the output at the negotiated sample rate, [stop]
 * tears it down. [enqueue] appends a frame to the playback buffer; [clear] drops
 * everything still queued WITHOUT closing the output — used by the barge-in /
 * interrupt drop-guard so the user stops hearing the assistant immediately while
 * the next stream can resume on the same open output.
 */
interface AudioPlaybackAdapter {
    /** Open the output at [sampleRate] (gateway-negotiated output rate). */
    suspend fun start(sampleRate: Int)

    /** Append a PCM16 LE frame to the playback buffer. */
    fun enqueue(pcm16: ByteArray)

    /** Close the output and release resources. Idempotent. */
    suspend fun stop()

    /** Drop all queued frames immediately without closing the output (barge-in / interrupt). */
    fun clear()

    /**
     * True when nothing is currently scheduled or playing — every enqueued frame has
     * PHYSICALLY finished playing out the device, not merely been handed off. The
     * pipeline polls this after `audio.done` to hold the "speaking" state (and the
     * interrupt affordance) until the speaker tail actually drains, mirroring the
     * webui playback adapter's drain signal. A null/absent output reads idle (true).
     */
    val isPlaybackIdle: Boolean
}
