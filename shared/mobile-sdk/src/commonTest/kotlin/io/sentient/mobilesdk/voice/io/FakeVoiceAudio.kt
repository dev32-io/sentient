package io.sentient.mobilesdk.voice.io

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase

/**
 * In-memory VoiceAudio for commonTest. Models the real contract:
 *  - configure() is idempotent + records every call (incl. the diff) for ordering tests;
 *  - the path-carrying configure() overload additionally records the VoiceAudioPath hint
 *    (configuredPaths) — this fake overrides it explicitly (rather than relying on the
 *    interface's default delegation) so path-threading tests can assert on it directly;
 *  - micFrames is a bounded drop-newest channel (mirrors the real producer backpressure);
 *  - playFrame appends to playedFrames; flushPlayback clears them + marks idle;
 *  - isPlaybackIdle flips false on the first playFrame, true again after flushPlayback or
 *    when the test drains via setPlaybackIdle(true) to advance the downlink drain-watch.
 *
 * No device, no real clock. Replaces the prior per-test mic + playback fakes.
 */
class FakeVoiceAudio(
    private val micChannelCapacity: Int = 8,
    initialPlaybackIdle: Boolean = true,
) : VoiceAudio {
    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    private val micCh = Channel<ShortArray>(capacity = micChannelCapacity)
    override val micFrames = micCh.receiveAsFlow()
    private val _micLevels = MutableStateFlow(MicLevelEnvelope.silence())
    override val micLevels: StateFlow<MicLevelEnvelope> = _micLevels
    private val meter = MicLevelMeter { _micLevels.value = it }

    val configureCalls = mutableListOf<Triple<Boolean, Boolean, Int>>()

    /** VoiceAudioPath hint recorded per path-carrying configure() call, in call order —
     *  parallel to (but not 1:1 index-aligned with) configureCalls: a caller that invokes
     *  the plain 3-arg configure() directly (bypassing the path overload) adds no entry
     *  here. Production always goes through SdkVoice, which always calls the 4-arg form. */
    val configuredPaths = mutableListOf<VoiceAudioPath>()

    val playedFrames = mutableListOf<ByteArray>()
    var flushCount = 0
        private set
    var playbackIdle = initialPlaybackIdle
        private set

    /** Push a mic frame; returns false if dropped (channel full) — drop-newest. */
    fun emit(pcm: ShortArray): Boolean {
        runCatching { meter.accept(pcm) }
        return micCh.trySend(pcm).isSuccess
    }

    /** Test hook to advance the downlink drain-watch (real adapter self-drains). */
    fun setPlaybackIdle(idle: Boolean) { playbackIdle = idle }

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        configureCalls += Triple(mic, playback, playbackRateHz)
        _state.value = VoiceAudioState(Phase.Configuring, micActive = mic, playbackActive = playback)
        // The pure graph decision is the shared source of truth — exercise it here so the
        // fake mirrors the real engine's vpio/running behavior without a device.
        voiceAudioGraph(mic, playback)
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    // Explicit override (rather than relying on the interface's default delegation) so
    // this fake can record the routing hint; delegates to the 3-arg configure() above for
    // the actual state/graph work, so both paths stay in lockstep.
    override suspend fun configure(mic: Boolean, playback: Boolean, path: VoiceAudioPath, playbackRateHz: Int) {
        configuredPaths += path
        configure(mic, playback, playbackRateHz)
    }

    override fun playFrame(pcm16: ByteArray) {
        if (!_state.value.playbackActive) return
        playedFrames += pcm16
        playbackIdle = false
    }

    override fun flushPlayback() {
        flushCount += 1
        playedFrames.clear()
        playbackIdle = true
    }

    override val isPlaybackIdle: Boolean get() = playbackIdle

    override suspend fun shutdown() {
        meter.reset()
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
        micCh.close()
    }
}