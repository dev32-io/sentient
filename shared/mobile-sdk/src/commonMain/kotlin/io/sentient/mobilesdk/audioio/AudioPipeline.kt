// ---------------------------------------------------------------------------
// AudioPipeline — the voice flow manager (E3).
//
// Wires the gates (A5–A7), codecs (A2/A4), audio adapters (E1/E2), and audio
// connectors (C6) into the uplink + downlink voice paths. Constructed + run by
// the orchestrator (SentientSdk) on its injected scope; cancelled on
// stopMic/disconnect. The uplink half lives in UplinkPump; this class owns the
// FSM, the downlink, and the shared isSpeaking/activeCycleId latches.
//
// DOWNLINK (connector → decode → playback + echoGate lifecycle + isSpeaking):
//   onAudioStart(cycleId,enc,sr) → opusMode = enc=="opus"; playbackRate = 48k in opus
//                            mode (libopus always decodes there) else sr ?: outputRate.
//                            opusDecoder.reset() if opus · playback.start(playbackRate)
//                            once (async) · echoGate.onPlaybackStart · isSpeaking=true ·
//                            FSM AudioStart; frames arriving before start() resolves are
//                            buffered in pendingFrames and flushed in order.
//   onAudioFrame(bytes)    → opus: opusDecoder.decode(bytes) → each PCM16 frame through
//                            enqueueOrBuffer; pcm16: passthrough through enqueueOrBuffer.
//   onAudioDone(cycleId)   → echoGate.onPlaybackDrain · opusDecoder.reset() if opus ·
//                            isSpeaking=false · FSM AudioDone
//   onPlaybackStop(reason) → echoGate.onPlaybackCancel · playback.clear() · reset decoder
//                            if opus · pendingFrames.clear() · isSpeaking=false · FSM Interrupt
//
// CANCELLATION: start() launches the capture-collect coroutine (in UplinkPump) on the
// orchestrator scope; stop() cancels that job AND calls capture.stop() + resets onset
// buffers. All downlink callbacks run on the single orchestrator coroutine so no
// synchronization is needed. LOGGING: gates do not self-log; the pipeline + pump log
// every gate decision, FSM transition, and per-frame buffering event (.claude/rules/logging.md).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.opus.OpusDecoderPort
import io.sentient.mobilesdk.audio.opus.OpusEncoderPort
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioInput
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * libopus ALWAYS decodes to 48 kHz internally regardless of the encoder's input
 * rate or the rate announced in connector.audio.start. Opus-mode playback MUST
 * therefore start at this rate; the announced sampleRate is ignored in opus mode.
 */
private const val OPUS_DECODE_RATE_HZ = 48_000

/** The connector.audio.start encoding value that selects opus-decode mode. */
private const val ENCODING_OPUS = "opus"

/**
 * The voice flow manager. One per orchestrator; reusable across startMic cycles.
 *
 * @param capture Mic capture adapter (E1). null on the text-only path → uplink no-ops.
 * @param playback Assistant playback adapter (E2). null → downlink frames are dropped.
 * @param opusDecoder Long-lived OGG-Opus → PCM16-LE decoder (A4). One instance,
 *   reset between cycles. Only invoked in opus mode; pcm16 passes through untouched.
 * @param opusEncoder Long-lived PCM16 → raw-opus uplink encoder (A5). Re-chunks
 *   the gated mic frames into 20 ms packets; reset per mic session by the pump.
 * @param audioInput Lazy connector accessor (breaks the construction cycle).
 * @param echoGate Client echo suppressor (A5).
 * @param fsm Voice-status FSM (drives ConnectionState.audioState display).
 * @param clock Injected wall-clock for gate RMS/tail timing.
 * @param scope Orchestrator coroutine scope.
 * @param inputSampleRate Mic/STT uplink rate (Hz).
 * @param outputSampleRate Assistant playback rate (Hz) — pcm16 fallback when none announced.
 * @param preRollFrames Pre-roll frames for the uplink onset flush.
 * @param onStateChanged Pushes isSpeaking + FSM state into the orchestrator's StateDeriver.
 * @param onBargeIn Mic-onset-while-speaking barge-in signal (default no-op).
 */
class AudioPipeline(
    capture: AudioCaptureAdapter?,
    private val playback: AudioPlaybackAdapter?,
    private val opusDecoder: OpusDecoderPort,
    private val opusEncoder: OpusEncoderPort,
    audioInput: () -> UserAudioInputConnector,
    private val echoGate: EchoGate,
    private val fsm: AudioFsm,
    private val clock: Clock,
    private val scope: CoroutineScope,
    inputSampleRate: Int,
    private val outputSampleRate: Int,
    preRollFrames: Int,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
    private val onBargeIn: (cycleId: String) -> Unit = {},
) {
    private val log = createLogger("audio", "pipeline")

    /** Uplink half (capture → gate → connector). Signals onset back here for FSM + barge-in. */
    private val uplink = UplinkPump(
        capture = capture,
        audioInput = audioInput,
        echoGate = echoGate,
        encoder = opusEncoder,
        clock = clock,
        scope = scope,
        inputSampleRate = inputSampleRate,
        preRollFrames = preRollFrames,
        onMicOnset = ::onMicOnset,
    )

    private var playbackStarted = false
    // true once playback.start() has resolved — frames buffer in pendingFrames until then.
    private var playbackReady = false
    private val pendingFrames = mutableListOf<ByteArray>()

    // true when the active TTS stream is OGG-Opus (encoding="opus") → each binary
    // frame is decoded to PCM16-LE via opusDecoder before enqueue. false → pcm16
    // passthrough. Set on audio.start, used by audio.frame / done / playback.stop.
    private var opusMode = false

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

    /** Start the uplink capture-collect job; idempotent (no FSM re-fire on a repeat call). */
    fun start() {
        if (uplink.isRunning()) {
            log.debug("start-noop", mapOf("reason" to "already-running"))
            return
        }
        transition(AudioInput.Activate)
        uplink.start()
    }

    /** Stop the uplink: cancel capture job, release mic, reset onset buffer. */
    fun stop() {
        uplink.stop()
        transition(AudioInput.Deactivate)
    }

    /** Uplink onset hook: log + signal barge-in if speaking, then drive the FSM. */
    private fun onMicOnset() {
        if (isSpeaking) {
            // PASSIVE barge-in: the loud frame keeps streaming to the gateway, whose
            // STT turn_started fires the server-side bargeInController (cancel cycle +
            // TTS, KEEP tasks). No `interrupt` frame here — that is the DISTINCT UI-stop
            // path that routes task-cancel. Logged with the cut cycleId for traceability.
            log.info("barge-in", mapOf("trigger" to "mic-onset-while-speaking", "cycleId" to activeCycleId))
            onBargeIn(activeCycleId)
        }
        transition(AudioInput.MicOnset, activeCycleId)
    }

    // ── Downlink ────────────────────────────────────────────────────────────────

    /**
     * connector.audio.start: open playback once, raise the echo threshold, mark
     * speaking. [encoding]/[sampleRate] come from the wire frame: opus mode
     * decodes binary frames through opusDecoder and MUST play at 48 kHz (libopus
     * always decodes there, ignoring the announced rate); pcm16 mode passes
     * bytes through at the announced rate (or outputSampleRate fallback).
     */
    fun onAudioStart(cycleId: String, encoding: String? = null, sampleRate: Int? = null) {
        opusMode = encoding.equals(ENCODING_OPUS, ignoreCase = true)
        val playbackRate = if (opusMode) OPUS_DECODE_RATE_HZ else (sampleRate ?: outputSampleRate)
        log.info(
            "downlink-start",
            mapOf("cycleId" to cycleId, "opusMode" to opusMode, "playbackRate" to playbackRate),
        )
        if (opusMode) opusDecoder.reset()
        echoGate.onPlaybackStart(cycleId)
        startPlaybackOnce(playbackRate)
        isSpeaking = true
        activeCycleId = cycleId
        transition(AudioInput.AudioStart, cycleId)
    }

    /** Open the player once at [rate]; flush any pre-ready buffered frames in order. */
    private fun startPlaybackOnce(rate: Int) {
        if (playbackStarted || playback == null) return
        playbackStarted = true
        playbackReady = false
        pendingFrames.clear()
        scope.launch {
            playback.start(rate)
            // Guard: if a barge-in/stop reset playbackStarted while start() was
            // suspended, do NOT flush — those frames were discarded on purpose.
            if (playbackStarted) {
                playbackReady = true
                for (f in pendingFrames) playback.enqueue(f)
                pendingFrames.clear()
            }
        }
    }

    /**
     * Binary downlink frame. opus mode: decode the OGG-Opus chunk to zero or more
     * PCM16-LE frames and route EACH through the same ready/pending path, in order.
     * pcm16 mode: pass the raw bytes through unchanged. Either way frames buffer
     * until the player is ready, then enqueue directly.
     */
    fun onAudioFrame(frame: ByteArray, cycleId: String) {
        if (playback == null) return
        if (!opusMode) {
            enqueueOrBuffer(frame, cycleId)
            return
        }
        val decoded = opusDecoder.decode(frame)
        log.debug(
            "downlink-decode",
            mapOf("oggBytes" to frame.size, "pcmFrames" to decoded.size, "cycleId" to cycleId),
        )
        for (pcm in decoded) enqueueOrBuffer(pcm, cycleId)
    }

    /** Enqueue [bytes] if the player is ready; else buffer for the post-start flush. */
    private fun enqueueOrBuffer(bytes: ByteArray, cycleId: String) {
        if (playbackReady) {
            log.debug("downlink-frame", mapOf("bytes" to bytes.size, "cycleId" to cycleId))
            playback?.enqueue(bytes)
        } else {
            pendingFrames.add(bytes)
            log.debug(
                "downlink-frame-buffered",
                mapOf("bytes" to bytes.size, "depth" to pendingFrames.size, "cycleId" to cycleId),
            )
        }
    }

    /** connector.audio.done: drain the echo tail, reset the opus decoder, clear speaking. */
    fun onAudioDone(cycleId: String) {
        log.info("downlink-done", mapOf("cycleId" to cycleId))
        echoGate.onPlaybackDrain(cycleId, clock.nowMs())
        if (opusMode) opusDecoder.reset()
        isSpeaking = false
        activeCycleId = ""
        transition(AudioInput.AudioDone, cycleId)
    }

    /** playback.stop (barge-in / interrupt): cancel echo state, flush playback, reset decoder, clear speaking. */
    fun onPlaybackStop(reason: String, cycleId: String) {
        log.info("downlink-stop", mapOf("reason" to reason, "cycleId" to cycleId))
        echoGate.onPlaybackCancel(cycleId)
        playback?.clear()
        if (opusMode) opusDecoder.reset()
        // Discard any frames buffered before the player was ready — barge-in drops pending audio.
        playbackStarted = false
        playbackReady = false
        pendingFrames.clear()
        isSpeaking = false
        activeCycleId = ""
        transition(AudioInput.Interrupt, cycleId)
    }

    /**
     * Transient teardown for a reconnect / idle disconnect: cancel the uplink, stop
     * playback, and RESET the opus decoder — but KEEP the native codecs allocated so
     * the next reconnect can decode again. Closing the decoder here would free the
     * native libopus decoder; the next cycle's reset()/decode() would then abort
     * (OpusDecoder#ctl) or silently drop all TTS. Use [dispose] for terminal teardown.
     */
    fun suspendPlayback() {
        log.info("suspend")
        uplink.cancel()
        playbackReady = false
        pendingFrames.clear()
        opusDecoder.reset()
        if (playbackStarted) {
            playbackStarted = false
            scope.launch { playback?.stop() }
        }
    }

    /** Terminal teardown (logout / SDK close): suspend, then free the native codecs. */
    fun dispose() {
        log.info("dispose")
        suspendPlayback()
        opusDecoder.close()
        opusEncoder.close()
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
}
