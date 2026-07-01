// ---------------------------------------------------------------------------
// SdkAudio — builds + holds the E3 DOWNLINK voice pipeline (decoder + FSM + playback).
//
// Extracted from SentientSdk.kt to keep the orchestrator under the 300-line
// clean-code budget, mirroring SdkConnectors / SdkLifecycle. Owns the AudioFsm
// voice-status FSM and the AudioPipeline downlink flow manager; exposes the
// downlink hooks the connector set routes binary/audio frames into, plus the
// lifecycle (suspend/dispose/stopLocal) the orchestrator drives.
//
// The real-time mic UPLINK lives entirely in the voice/ package (MicSource →
// VoiceUplinkPipeline, driven by SdkVoice) — SdkAudio no longer touches capture,
// the uplink encoder, or the EchoGate.
//
// The pipeline pushes isSpeaking + the FSM state through [onStateChanged] back
// into the orchestrator's StateDeriver (the C7 single-StateFlow fan-in).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audio.opus.LazyOpusDecoderPort
import io.sentient.mobilesdk.audio.opus.OpusDownlinkDecoder
import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.voice.io.VoiceAudio
import kotlinx.coroutines.CoroutineScope

/**
 * Constructs and owns the downlink voice pipeline (E3).
 *
 * @param audioConfig Tuned sample rates + settle timing (operator config).
 * @param voiceAudio Voice engine (null on the text-only test path). AudioPipeline
 *   depends only on its [io.sentient.mobilesdk.audioio.VoicePlaybackSink] slice.
 * @param scope Orchestrator scope the downlink coroutines run on.
 * @param onStateChanged Pushes isSpeaking + FSM state into the StateDeriver.
 */
class SdkAudio(
    audioConfig: AudioPipelineConfig,
    voiceAudio: VoiceAudio?,
    scope: CoroutineScope,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
) {
    private val fsm = AudioFsm()

    // Long-lived OGG-Opus → PCM16-LE downlink decoder (A4); reset between TTS cycles
    // by the pipeline. Wrapped in LazyOpusDecoderPort so the native kopus decoder is
    // only allocated when opus actually streams (on a real device) — eager
    // construction would crash host-JVM full-SDK tests on the libopus native load.
    private val opusDecoder = LazyOpusDecoderPort { OpusDownlinkDecoder() }

    /** The downlink voice flow manager (connector → decode → playback). */
    val pipeline: AudioPipeline = AudioPipeline(
        playback = voiceAudio, // VoiceAudio : VoicePlaybackSink
        opusDecoder = opusDecoder,
        fsm = fsm,
        scope = scope,
        outputSampleRate = audioConfig.outputSampleRate,
        onStateChanged = onStateChanged,
        playbackDrainSettleMs = audioConfig.playbackDrainSettleMs,
    )

    /** Downlink side-effect hooks the connector set routes audio frames into. */
    val downlinkHooks: AudioDownlinkHooks = AudioDownlinkHooks(
        onAudioStart = pipeline::onAudioStart,
        onAudioFrame = pipeline::onAudioFrame,
        onAudioDone = pipeline::onAudioDone,
        onPlaybackStop = pipeline::onPlaybackStop,
    )

    // ── Audio lifecycle ─────────────────────────────────────────────────────────
    // Audio teardown has exactly TWO flavors. A transient disconnect (reconnect /
    // idle / background) must KEEP the native codec so TTS survives the next
    // reconnect — only a terminal teardown (logout / SDK close) frees it. Mixing
    // the two was the freeze + silent-TTS bug (close-on-every-disconnect).

    /** Transient: the connection dropped for a reconnect/idle. Keep native codec. */
    fun suspendForReconnect() = pipeline.suspendPlayback()

    /** Terminal: logout / SDK close. Free the native codec. */
    fun dispose() = pipeline.dispose()

    /** Local Stop (UI/escape): force-stop playback for the active cycle without a server frame. */
    fun stopLocal() = pipeline.stopLocal()
}
