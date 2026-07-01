package io.sentient.mobilesdk.voice.io

/**
 * The desired single-engine graph for one (mic, playback) cell. The pure decision
 * [voiceAudioGraph] is the source of truth shared by BOTH platform actuals (iOS +
 * Android) and [FakeVoiceAudio], so the matrix is pinned by commonTest, not device
 * tests. See the design table:
 *
 *   (mic, tts) | inputTap | player | VPIO | output | running |
 *   off, off   | —        | —      | —    | —      | torn down
 *   off, on    | —        | ✓      | off  | ✓      | running
 *   on, off    | ✓        | —      | off  | ✓      | running
 *   on, on     | ✓        | ✓      | on   | ✓      | running (full-duplex AEC)
 */
data class VoiceAudioGraph(
    val inputTap: Boolean,
    val player: Boolean,
    val vpio: Boolean,
    val output: Boolean,
    val running: Boolean,
)

/** The pure (mic, playback) → graph decision. No platform deps; unit-tested in commonTest. */
internal fun voiceAudioGraph(mic: Boolean, playback: Boolean): VoiceAudioGraph {
    val active = mic || playback
    return VoiceAudioGraph(
        inputTap = mic,
        player = playback,
        // AEC enabled exactly when there is echo to cancel (mic captures the TTS output).
        vpio = mic && playback,
        // Output graph is referenced whenever a player is (or will be) attached, so the
        // player never starts "disconnected" (the interim 2633b4e crash fix, now structural).
        output = active,
        running = active,
    )
}