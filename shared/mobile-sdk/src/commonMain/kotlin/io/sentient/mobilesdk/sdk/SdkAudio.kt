// ---------------------------------------------------------------------------
// SdkAudio — builds + holds the E3 voice pipeline wiring (gates + FSM + adapters).
//
// Extracted from SentientSdk.kt to keep the orchestrator under the 300-line
// clean-code budget, mirroring SdkConnectors / SdkLifecycle. Owns the EchoGate
// (A5), the AudioFsm voice-status FSM, and the AudioPipeline flow manager;
// exposes the downlink hooks the connector set routes binary/audio frames into,
// plus start/stop/release the orchestrator drives from startMic/stopMic/disconnect.
//
// The pipeline pushes isSpeaking + the FSM state through [onStateChanged] back
// into the orchestrator's StateDeriver (the C7 single-StateFlow fan-in). The
// audioInput connector is supplied lazily so the orchestrator can build this
// holder before the connector set (breaks the construction cycle: connectors
// need the downlink hooks, the pipeline needs connectors.audioInput).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.opus.LazyOpusDecoderPort
import io.sentient.mobilesdk.audio.opus.LazyOpusEncoderPort
import io.sentient.mobilesdk.audio.opus.OpusDownlinkDecoder
import io.sentient.mobilesdk.audio.opus.OpusUplinkEncoder
import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope

/**
 * Constructs and owns the voice pipeline (E3).
 *
 * @param audioConfig Tuned gate thresholds + sample rates (operator config).
 * @param capture Mic capture adapter (null on the text-only test path).
 * @param playback Assistant playback adapter (null on the text-only test path).
 * @param audioInput Lazy accessor for the uplink connector (cycle-break).
 * @param clock Injected wall-clock for the gate timing.
 * @param scope Orchestrator scope the capture-collect job runs on.
 * @param onStateChanged Pushes isSpeaking + FSM state into the StateDeriver.
 * @param onBargeIn Signals a mic-onset barge-in for a cycleId — routed to the
 *   CycleErrorConnector so a racing same-cycle abort stays classified self-initiated.
 */
class SdkAudio(
    audioConfig: AudioPipelineConfig,
    capture: io.sentient.mobilesdk.audioio.AudioCaptureAdapter?,
    playback: io.sentient.mobilesdk.audioio.AudioPlaybackAdapter?,
    audioInput: () -> UserAudioInputConnector,
    clock: Clock,
    scope: CoroutineScope,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
    onBargeIn: (cycleId: String) -> Unit = {},
) {
    private val fsm = AudioFsm()
    private val echoGate = EchoGate(audioConfig.echoGate)

    // Long-lived OGG-Opus → PCM16-LE downlink decoder (A4); reset between TTS cycles
    // by the pipeline. Wrapped in LazyOpusDecoderPort so the native kopus decoder is
    // only allocated when opus actually streams (on a real device) — eager
    // construction would crash host-JVM full-SDK tests on the libopus native load.
    private val opusDecoder = LazyOpusDecoderPort { OpusDownlinkDecoder() }

    // Long-lived PCM16 → raw-opus uplink encoder (A5); re-chunks the gated mic
    // frames into 20 ms packets and is reset per mic session by the pump. Wrapped
    // in LazyOpusEncoderPort so the native kopus encoder is only allocated once mic
    // capture forwards a frame (on a real device) — eager construction would crash
    // host-JVM full-SDK tests on the libopus native load.
    private val opusEncoder = LazyOpusEncoderPort { OpusUplinkEncoder() }

    /** The voice flow manager — uplink (capture→gate→encode→connector) + downlink (connector→decode→playback). */
    val pipeline: AudioPipeline = AudioPipeline(
        capture = capture,
        playback = playback,
        opusDecoder = opusDecoder,
        opusEncoder = opusEncoder,
        audioInput = audioInput,
        echoGate = echoGate,
        fsm = fsm,
        clock = clock,
        scope = scope,
        inputSampleRate = audioConfig.inputSampleRate,
        outputSampleRate = audioConfig.outputSampleRate,
        preRollFrames = audioConfig.speechGate.preRollFrames,
        onStateChanged = onStateChanged,
        onBargeIn = onBargeIn,
    )

    /** Downlink side-effect hooks the connector set routes audio frames into. */
    val downlinkHooks: AudioDownlinkHooks = AudioDownlinkHooks(
        onAudioStart = pipeline::onAudioStart,
        onAudioFrame = pipeline::onAudioFrame,
        onAudioDone = pipeline::onAudioDone,
        onPlaybackStop = pipeline::onPlaybackStop,
    )

    /** Start the uplink (capture→gate→uplink). Mirrors startMic. */
    fun startUplink() = pipeline.start()

    /** Stop the uplink (cancel collect + capture.stop + reset). Mirrors stopMic. */
    fun stopUplink() = pipeline.stop()

    /** Release playback + cancel any running uplink. Mirrors disconnect. */
    fun release() = pipeline.release()
}
