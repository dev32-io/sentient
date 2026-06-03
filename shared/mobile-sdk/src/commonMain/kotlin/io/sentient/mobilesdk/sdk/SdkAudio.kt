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
 */
class SdkAudio(
    audioConfig: AudioPipelineConfig,
    capture: io.sentient.mobilesdk.audioio.AudioCaptureAdapter?,
    playback: io.sentient.mobilesdk.audioio.AudioPlaybackAdapter?,
    audioInput: () -> UserAudioInputConnector,
    clock: Clock,
    scope: CoroutineScope,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
) {
    private val fsm = AudioFsm()
    private val echoGate = EchoGate(audioConfig.echoGate)

    /** The voice flow manager — uplink (capture→gate→connector) + downlink (connector→playback). */
    val pipeline: AudioPipeline = AudioPipeline(
        capture = capture,
        playback = playback,
        audioInput = audioInput,
        echoGate = echoGate,
        fsm = fsm,
        clock = clock,
        scope = scope,
        inputSampleRate = audioConfig.inputSampleRate,
        outputSampleRate = audioConfig.outputSampleRate,
        preRollFrames = audioConfig.speechGate.preRollFrames,
        onStateChanged = onStateChanged,
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
