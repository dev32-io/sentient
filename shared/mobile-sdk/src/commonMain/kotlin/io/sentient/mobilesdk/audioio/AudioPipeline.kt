// ---------------------------------------------------------------------------
// AudioPipeline — the voice flow manager (E3).
//
// Wires the gates (A5–A7), codec (A2), audio adapters (E1/E2), and audio
// connectors (C6) into the uplink + downlink voice paths. Constructed + run by
// the orchestrator (SentientSdk) on its injected scope; cancelled on
// stopMic/disconnect.
//
// UPLINK (continuous-minus-echo — MIRRORS webui):
//   Each captured frame: EchoGate.acceptFrame → AudioPreRollRing.push → connector.sendAudioFrame.
//   Echo is dropped in real time; the reject→accept onset flushes the pre-roll ring intact.
//   The server owns VAD / Smart-Turn end-pointing; the client only suppresses echo + pads onset.
//
// DOWNLINK (connector → playback + echoGate lifecycle + isSpeaking):
//   onAudioStart(cycleId)  → playback.start(outputRate) once (async) · echoGate.onPlaybackStart
//                            · isSpeaking=true · FSM AudioStart; frames arriving before
//                            start() resolves are buffered in pendingFrames and flushed in order.
//   onAudioFrame(bytes)    → playback.enqueue(bytes) if ready; else buffer in pendingFrames.
//   onAudioDone(cycleId)   → echoGate.onPlaybackDrain(cycleId, nowMs) · isSpeaking=false · FSM AudioDone
//   onPlaybackStop(reason) → echoGate.onPlaybackCancel · playback.clear() · pendingFrames.clear()
//                            · isSpeaking=false · FSM Interrupt (→ LISTENING)
//
// CANCELLATION: start() launches the capture-collect coroutine on the orchestrator scope;
// stop() cancels that job AND calls capture.stop() + resets onset buffers. All downlink
// callbacks run on the single orchestrator coroutine so no synchronization is needed.
// LOGGING: gates do not self-log; the pipeline logs every gate decision, FSM transition,
// and per-frame buffering event (.claude/rules/logging.md).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.AudioPreRollRing
import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.computeRms
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioInput
import io.sentient.mobilesdk.sdk.AudioState
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
 * The voice flow manager. One per orchestrator; reusable across startMic cycles.
 *
 * @param capture Mic capture adapter (E1). null on the text-only path → uplink no-ops.
 * @param playback Assistant playback adapter (E2). null → downlink frames are dropped.
 * @param audioInput Lazy connector accessor (breaks the construction cycle).
 * @param echoGate Client echo suppressor (A5).
 * @param fsm Voice-status FSM (drives SdkState display).
 * @param clock Injected wall-clock for gate RMS/tail timing.
 * @param scope Orchestrator coroutine scope.
 * @param inputSampleRate Mic/STT uplink rate (Hz).
 * @param outputSampleRate Assistant playback rate (Hz).
 * @param preRollFrames Pre-roll frames for the uplink onset flush.
 * @param onStateChanged Pushes isSpeaking + FSM state into the orchestrator's StateDeriver.
 * @param onBargeIn Mic-onset-while-speaking barge-in signal (default no-op).
 */
class AudioPipeline(
    private val capture: AudioCaptureAdapter?,
    private val playback: AudioPlaybackAdapter?,
    private val audioInput: () -> UserAudioInputConnector,
    private val echoGate: EchoGate,
    private val fsm: AudioFsm,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val inputSampleRate: Int,
    private val outputSampleRate: Int,
    private val preRollFrames: Int,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
    private val onBargeIn: (cycleId: String) -> Unit = {},
) {
    private val log = createLogger("audio", "pipeline")

    /** Uplink ring: buffers rejected frames for the onset flush (hangover=0, server end-points). */
    private val ring = AudioPreRollRing<ByteArray>(
        preRollFrames = preRollFrames,
        hangoverFrames = UPLINK_HANGOVER_FRAMES,
    )

    private var captureJob: Job? = null
    private var playbackStarted = false
    // true once playback.start() has resolved — frames buffer in pendingFrames until then.
    private var playbackReady = false
    private val pendingFrames = mutableListOf<ByteArray>()
    private var ringActive = false
    private var rejectCount = 0

    // isSpeaking is an independent latch (true between audio.start and
    // done/playback-stop), NOT derived from the FSM: assistant TTS plays on the
    // TEXT path too (voiceMode OFF → FSM INACTIVE) and must still flip speaking,
    // mirroring webui's isAudioPlaying. The FSM drives the richer voice-mode display.
    private var isSpeaking = false

    // cycleId of the TTS stream currently playing (set on audio.start, cleared on
    // done / playback.stop). Carried into the barge-in log so a mic-onset-over-TTS
    // is traceable to the cycle it cut. "" when no TTS is active.
    private var activeCycleId = ""

    // ── Uplink ────────────────────────────────────────────────────────────────

    /** Start the uplink capture-collect job; idempotent. */
    fun start() {
        if (captureJob?.isActive == true) {
            log.debug("start-noop", mapOf("reason" to "already-running"))
            return
        }
        transition(AudioInput.Activate)
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
        transition(AudioInput.Deactivate)
    }

    private fun onCaptureFrame(frame: ByteArray) {
        val pcm = bytesToShorts(frame)
        val nowMs = clock.nowMs()
        val accepted = echoGate.acceptFrame(pcm, nowMs)
        logGateDecision(pcm, nowMs, accepted)
        val onset = accepted && !ringActive
        ringActive = accepted
        val forward = ring.push(frame, accepted)
        if (onset) {
            rejectCount = 0
            // A mic-onset WHILE TTS plays is a barge-in: the loud frame cleared
            // the EchoGate's elevated playback threshold. This is PASSIVE — the
            // frame keeps streaming to the gateway, whose STT turn_started fires
            // the server-side bargeInController (cancel cycle + TTS, KEEP tasks).
            // The client sends NO `interrupt` frame here (that is the DISTINCT
            // UI-stop path that routes task-cancel). Log it for traceability.
            if (isSpeaking) {
                log.info(
                    "barge-in",
                    mapOf("trigger" to "mic-onset-while-speaking", "cycleId" to activeCycleId),
                )
                onBargeIn(activeCycleId)
            }
            transition(AudioInput.MicOnset, activeCycleId)
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

    // ── Downlink ────────────────────────────────────────────────────────────────

    /** connector.audio.start: open playback once, raise the echo threshold, mark speaking. */
    fun onAudioStart(cycleId: String) {
        log.info("downlink-start", mapOf("cycleId" to cycleId))
        echoGate.onPlaybackStart(cycleId)
        if (!playbackStarted && playback != null) {
            playbackStarted = true
            playbackReady = false
            pendingFrames.clear()
            scope.launch {
                playback.start(outputSampleRate)
                // Guard: if a barge-in/stop reset playbackStarted while start() was
                // suspended, do NOT flush — those frames were discarded on purpose.
                if (playbackStarted) {
                    playbackReady = true
                    for (f in pendingFrames) playback.enqueue(f)
                    pendingFrames.clear()
                }
            }
        }
        isSpeaking = true
        activeCycleId = cycleId
        transition(AudioInput.AudioStart, cycleId)
    }

    /** Binary downlink frame: buffer until the player is ready, then enqueue directly. */
    fun onAudioFrame(frame: ByteArray, cycleId: String) {
        val pb = playback ?: return
        if (playbackReady) {
            log.debug("downlink-frame", mapOf("bytes" to frame.size, "cycleId" to cycleId))
            pb.enqueue(frame)
        } else {
            pendingFrames.add(frame)
            log.debug(
                "downlink-frame-buffered",
                mapOf("bytes" to frame.size, "depth" to pendingFrames.size, "cycleId" to cycleId),
            )
        }
    }

    /** connector.audio.done: drain the echo tail, clear speaking. */
    fun onAudioDone(cycleId: String) {
        log.info("downlink-done", mapOf("cycleId" to cycleId))
        echoGate.onPlaybackDrain(cycleId, clock.nowMs())
        isSpeaking = false
        activeCycleId = ""
        transition(AudioInput.AudioDone, cycleId)
    }

    /** playback.stop (barge-in / interrupt): cancel echo state, flush playback, clear speaking. */
    fun onPlaybackStop(reason: String, cycleId: String) {
        log.info("downlink-stop", mapOf("reason" to reason, "cycleId" to cycleId))
        echoGate.onPlaybackCancel(cycleId)
        playback?.clear()
        // Discard any frames buffered before the player was ready — barge-in drops pending audio.
        playbackStarted = false
        playbackReady = false
        pendingFrames.clear()
        isSpeaking = false
        activeCycleId = ""
        transition(AudioInput.Interrupt, cycleId)
    }

    /** Release playback resources. Called on disconnect/teardown. */
    fun release() {
        log.info("release")
        captureJob?.cancel()
        captureJob = null
        playbackReady = false
        pendingFrames.clear()
        if (playbackStarted) {
            playbackStarted = false
            scope.launch { playback?.stop() }
        }
    }

    // ── Shared helpers ──────────────────────────────────────────────────────────

    /**
     * Advance the FSM on [input], log the transition (prev→new+input+cycleId),
     * and push the current isSpeaking latch + the new FSM state into the
     * StateDeriver. Always emits — the StateFlow is conflated so a same-value
     * emit is harmless, and it keeps the snapshot consistent when a duplicate
     * audio.start/done arrives without an FSM transition (e.g. the text path,
     * where audio plays but voiceMode stays OFF → FSM INACTIVE).
     */
    private fun transition(input: AudioInput, cycleId: String = "") {
        val prev = fsm.state
        val next = fsm.handle(input)
        if (next != prev) {
            log.debug(
                "fsm",
                mapOf("from" to prev, "to" to next, "input" to input::class.simpleName, "cycleId" to cycleId),
            )
        }
        onStateChanged(isSpeaking, next)
    }

    /** Decode PCM16 LE bytes to a ShortArray for the gate's RMS check. */
    private fun bytesToShorts(bytes: ByteArray): ShortArray {
        val n = bytes.size / 2
        val out = ShortArray(n)
        for (i in 0 until n) {
            val lo = bytes[i * 2].toInt() and 0xFF
            val hi = bytes[i * 2 + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }
}
