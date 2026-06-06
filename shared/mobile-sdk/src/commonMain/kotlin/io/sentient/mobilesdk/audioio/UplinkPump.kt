// ---------------------------------------------------------------------------
// UplinkPump — the continuous-minus-echo uplink half of the voice flow (E3).
//
// MIRRORS webui: each captured frame runs EchoGate.acceptFrame → AudioPreRollRing
// .push → connector.sendAudioFrame. Echo is dropped in real time; the reject→accept
// onset flushes the pre-roll ring intact. The server owns VAD / Smart-Turn
// end-pointing; the client only suppresses echo + pads onset.
//
// Split out of AudioPipeline to keep both files under the clean-code line budget.
// The pump owns capture + ring + gate-decision logging; the pipeline owns the FSM
// and downlink. The pump signals a mic onset via [onMicOnset] (the pipeline maps
// it to FSM MicOnset + barge-in) and reads the speaking latch via [isSpeaking].
// LOGGING: gates do not self-log; this pump logs every gate decision (.claude/rules/logging.md).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.AudioPreRollRing
import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.computeRms
import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** DEBUG log throttle for buffered (gate-rejected) frames during silence. */
private const val GATE_REJECT_LOG_EVERY = 50

/** Hangover frames the uplink ring keeps emitting after a reject — 0: server end-points. */
private const val UPLINK_HANGOVER_FRAMES = 0

/**
 * The uplink half of the voice flow manager.
 *
 * @param capture Mic capture adapter (E1). null on the text-only path → start no-ops.
 * @param audioInput Lazy connector accessor (breaks the construction cycle).
 * @param echoGate Client echo suppressor (A5).
 * @param clock Injected wall-clock for gate RMS/tail timing.
 * @param scope Orchestrator coroutine scope the capture-collect job runs on.
 * @param inputSampleRate Mic/STT uplink rate (Hz).
 * @param preRollFrames Pre-roll frames for the onset flush.
 * @param onMicOnset Fires on each reject→accept onset; the pipeline maps it to the
 *   FSM MicOnset transition + (if speaking) the cycleId-bearing barge-in signal.
 */
class UplinkPump(
    private val capture: AudioCaptureAdapter?,
    private val audioInput: () -> UserAudioInputConnector,
    private val echoGate: EchoGate,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val inputSampleRate: Int,
    preRollFrames: Int,
    private val onMicOnset: () -> Unit,
) {
    private val log = createLogger("audio", "uplink")

    /** Ring: buffers rejected frames for the onset flush (hangover=0, server end-points). */
    private val ring = AudioPreRollRing<ByteArray>(
        preRollFrames = preRollFrames,
        hangoverFrames = UPLINK_HANGOVER_FRAMES,
    )

    private var captureJob: Job? = null
    private var ringActive = false
    private var rejectCount = 0

    /** True while the capture-collect job is live — start() is a no-op when true. */
    fun isRunning(): Boolean = captureJob?.isActive == true

    /** Start the capture-collect job. Caller guards idempotency via [isRunning]. */
    fun start() {
        val cap = capture
        if (cap == null) {
            log.warn("uplink-disabled", mapOf("reason" to "no-capture-adapter"))
            return
        }
        log.info("uplink-start", mapOf("inputSampleRate" to inputSampleRate))
        captureJob = scope.launch {
            cap.start(inputSampleRate)
            cap.frames(inputSampleRate).collect { frame -> onCaptureFrame(frame) }
        }
    }

    /** Stop the uplink: cancel capture job, release mic, reset onset buffer. */
    fun stop() {
        log.info("uplink-stop")
        captureJob?.cancel()
        captureJob = null
        ring.reset()
        ringActive = false
        rejectCount = 0
        scope.launch { capture?.stop() }
    }

    /** Cancel the capture-collect job without touching the mic (release path). */
    fun cancel() {
        captureJob?.cancel()
        captureJob = null
    }

    private fun onCaptureFrame(frame: ByteArray) {
        val pcm = pcm16LeToShorts(frame)
        val nowMs = clock.nowMs()
        val accepted = echoGate.acceptFrame(pcm, nowMs)
        logGateDecision(pcm, nowMs, accepted)
        val onset = accepted && !ringActive
        ringActive = accepted
        val forward = ring.push(frame, accepted)
        if (onset) {
            rejectCount = 0
            // Reject→accept onset. The pipeline maps this to the FSM MicOnset
            // transition and — if TTS is playing — the cycleId-bearing barge-in
            // signal (a passive barge-in: the frame keeps streaming to the gateway,
            // whose STT turn_started fires the server-side bargeInController).
            onMicOnset()
        }
        val connector = audioInput()
        for (out in forward) connector.sendAudioFrame(out)
    }

    private fun logGateDecision(pcm: ShortArray, nowMs: Long, accepted: Boolean) {
        if (accepted) {
            log.debug(
                "gate-accept",
                mapOf("rms" to computeRms(pcm), "state" to echoGate.state(nowMs), "samples" to pcm.size),
            )
            return
        }
        rejectCount += 1
        if (rejectCount % GATE_REJECT_LOG_EVERY != 0) return
        log.debug(
            "gate-reject",
            mapOf("rms" to computeRms(pcm), "state" to echoGate.state(nowMs), "rejected" to rejectCount),
        )
    }
}
