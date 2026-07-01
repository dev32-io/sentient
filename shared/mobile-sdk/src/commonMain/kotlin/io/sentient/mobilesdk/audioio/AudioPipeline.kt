// ---------------------------------------------------------------------------
// AudioPipeline — the DOWNLINK voice flow manager (E3).
//
// Wires the downlink codec (A4) + playback adapter (E2) into the assistant-audio
// path (connector → decode → playback + isSpeaking latch + FSM). Constructed +
// run by the orchestrator (SdkAudio → SentientSdk) on its injected scope. The
// real-time mic UPLINK now lives entirely in the voice/ package (MicSource →
// VoiceUplinkPipeline, driven by SdkVoice); this class is downlink-only. All downlink
// callbacks run on the single orchestrator coroutine so no synchronization is needed.
// LOGGING: the pipeline logs every FSM transition + per-frame buffering event.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.opus.OpusDecoderPort
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioInput
import io.sentient.mobilesdk.sdk.AudioState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * libopus ALWAYS decodes to 48 kHz internally regardless of the encoder's input
 * rate or the rate announced in connector.audio.start. Opus-mode playback MUST
 * therefore start at this rate; the announced sampleRate is ignored in opus mode.
 */
private const val OPUS_DECODE_RATE_HZ = 48_000

/** The connector.audio.start encoding value that selects opus-decode mode. */
private const val ENCODING_OPUS = "opus"

/** Poll interval (ms) while waiting for the player to physically drain after audio.done. */
private const val DRAIN_POLL_MS = 50L

/** Default settle (ms) after the player reports idle before clearing the speaking state. */
private const val DEFAULT_DRAIN_SETTLE_MS = 250L

/**
 * The downlink voice flow manager. One per orchestrator; reusable across cycles.
 *
 * @param playback Assistant playback adapter (E2). null → downlink frames are dropped.
 * @param opusDecoder Long-lived OGG-Opus → PCM16-LE decoder (A4); one instance, reset
 *   between cycles. Only invoked in opus mode; pcm16 passes through untouched.
 * @param fsm Voice-status FSM (drives ConnectionState.audioState display).
 * @param scope Orchestrator coroutine scope.
 * @param outputSampleRate Assistant playback rate (Hz) — pcm16 fallback when none announced.
 * @param onStateChanged Pushes isSpeaking + FSM state into the orchestrator's StateDeriver.
 * @param playbackDrainSettleMs Settle (ms) after the player reports idle before speaking
 *   clears — keeps the interrupt affordance through the speaker tail.
 */
class AudioPipeline(
    private val playback: AudioPlaybackAdapter?,
    private val opusDecoder: OpusDecoderPort,
    private val fsm: AudioFsm,
    private val scope: CoroutineScope,
    private val outputSampleRate: Int,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
    private val playbackDrainSettleMs: Long = DEFAULT_DRAIN_SETTLE_MS,
) {
    private val log = createLogger("audio", "pipeline")

    private var playbackStarted = false
    // true once playback.start() has resolved — frames buffer in pendingFrames until then.
    private var playbackReady = false
    private val pendingFrames = mutableListOf<ByteArray>()

    // true when the active TTS stream is OGG-Opus (encoding="opus") → each binary
    // frame is decoded to PCM16-LE via opusDecoder before enqueue. false → pcm16
    // passthrough. Set on audio.start, used by audio.frame / done / playback.stop.
    private var opusMode = false

    // isSpeaking is an independent latch (true between audio.start and done/playback-
    // stop), NOT derived from the FSM: assistant TTS plays on the TEXT path too
    // (voiceMode OFF → FSM INACTIVE) and must still flip speaking (webui isAudioPlaying).
    private var isSpeaking = false

    // cycleId of the TTS stream currently playing (set on audio.start, cleared on
    // done / playback.stop). "" when no TTS is active. Guards supersede + stale-drop.
    private var activeCycleId = ""

    // Drain-watch: true between audio.done and the speaker physically draining. While
    // true, isSpeaking (and the interrupt affordance) are HELD — audio.done only means
    // the server finished sending; the player is still playing its buffered tail.
    private var framesDone = false
    private var drainJob: Job? = null

    // ── Downlink ────────────────────────────────────────────────────────────────

    /**
     * connector.audio.start: open playback once, mark speaking. [encoding]/[sampleRate]
     * come from the wire frame: opus mode decodes binary frames through opusDecoder and
     * MUST play at 48 kHz (libopus always decodes there, ignoring the announced rate);
     * pcm16 mode passes bytes through at the announced rate (or outputSampleRate fallback).
     */
    fun onAudioStart(cycleId: String, encoding: String? = null, sampleRate: Int? = null) {
        // A NEWER cycle's audio arriving while a prior cycle is still playing/queued →
        // drop the superseded audio so the user hears the LATEST response, not the old
        // tail (webui parity). The cycleId guard in onAudioFrame/onAudioDone then drops
        // any late frames/done still in flight for the superseded cycle.
        if (activeCycleId.isNotEmpty() && activeCycleId != cycleId) {
            log.info("downlink-supersede", mapOf("superseded" to activeCycleId, "next" to cycleId))
            playback?.clear()
            pendingFrames.clear()
        }
        // A new cycle supersedes any pending drain-watch from the prior cycle.
        drainJob?.cancel()
        framesDone = false
        opusMode = encoding.equals(ENCODING_OPUS, ignoreCase = true)
        val playbackRate = if (opusMode) OPUS_DECODE_RATE_HZ else (sampleRate ?: outputSampleRate)
        log.info(
            "downlink-start",
            mapOf("cycleId" to cycleId, "opusMode" to opusMode, "playbackRate" to playbackRate),
        )
        if (opusMode) opusDecoder.reset()
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
        // Drop frames from a superseded cycle (a newer audio.start moved activeCycleId
        // on). Dropping BEFORE decode is essential in opus mode — feeding a stale chunk
        // would corrupt the freshly-reset decoder state for the new cycle.
        if (activeCycleId.isNotEmpty() && cycleId != activeCycleId) {
            log.debug("downlink-frame-stale-drop", mapOf("frameCycle" to cycleId, "activeCycle" to activeCycleId))
            return
        }
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

    /**
     * connector.audio.done: the server finished SENDING frames — but the player is
     * still playing its buffered tail. Reset the decoder now, then HOLD the speaking
     * state (and the interrupt affordance) until the player physically drains
     * (armDrainWatch), instead of clearing it here.
     */
    fun onAudioDone(cycleId: String) {
        log.info("downlink-done", mapOf("cycleId" to cycleId))
        // Stale audio.done for a superseded cycle — the active cycle owns the state.
        if (activeCycleId.isNotEmpty() && cycleId != activeCycleId) {
            log.debug("downlink-done-stale-drop", mapOf("doneCycle" to cycleId, "activeCycle" to activeCycleId))
            return
        }
        if (opusMode) opusDecoder.reset()
        framesDone = true
        armDrainWatch(cycleId)
    }

    /**
     * After audio.done, poll the playback adapter until it has PHYSICALLY drained
     * (every enqueued frame played out the speaker), then a short settle, then clear
     * the speaking state + fire the FSM AudioDone. Holding it this long is what keeps
     * the interrupt affordance visible through the speaker tail (webui parity). A new
     * cycle (onAudioStart) or an interrupt (onPlaybackStop) cancels the watch.
     */
    private fun armDrainWatch(cycleId: String) {
        drainJob?.cancel()
        val pb = playback ?: run { finalizeDrain(cycleId); return }
        drainJob = scope.launch {
            while (framesDone && !pb.isPlaybackIdle) delay(DRAIN_POLL_MS)
            if (!framesDone) return@launch // superseded by a new cycle / interrupt
            delay(playbackDrainSettleMs)
            if (framesDone && pb.isPlaybackIdle) finalizeDrain(cycleId)
        }
    }

    /** Clear the speaking latch + advance the FSM once the speaker has truly drained. */
    private fun finalizeDrain(cycleId: String) {
        if (!framesDone) return
        framesDone = false
        isSpeaking = false
        activeCycleId = ""
        log.info("downlink-drained", mapOf("cycleId" to cycleId))
        transition(AudioInput.AudioDone, cycleId)
    }

    /** Local Stop (UI/escape): force-stop playback for the active cycle without a server frame. */
    fun stopLocal() {
        if (activeCycleId.isEmpty() && !isSpeaking) return
        onPlaybackStop(reason = "interrupt-local", cycleId = activeCycleId)
    }

    /** playback.stop (barge-in / interrupt): flush playback, reset decoder, clear speaking. */
    fun onPlaybackStop(reason: String, cycleId: String) {
        log.info("downlink-stop", mapOf("reason" to reason, "cycleId" to cycleId))
        // Interrupt/barge-in clears speaking immediately — cancel any pending drain-watch.
        drainJob?.cancel()
        framesDone = false
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
     * Transient teardown for a reconnect / idle disconnect: stop playback and RESET
     * the opus decoder — but KEEP the native codec allocated so the next reconnect can
     * decode again. Closing it here would free the native libopus decoder; the next
     * cycle's reset()/decode() would then abort or silently drop all TTS. Use [dispose]
     * for terminal teardown.
     */
    fun suspendPlayback() {
        log.info("suspend")
        drainJob?.cancel()
        framesDone = false
        playbackReady = false
        pendingFrames.clear()
        opusDecoder.reset()
        if (playbackStarted) {
            playbackStarted = false
            scope.launch { playback?.stop() }
        }
    }

    /** Terminal teardown (logout / SDK close): suspend, then free the native decoder. */
    fun dispose() {
        log.info("dispose")
        suspendPlayback()
        opusDecoder.close()
    }

    // ── Shared helpers ──────────────────────────────────────────────────────────

    /**
     * Advance the FSM on [input], log the transition, and push the current
     * isSpeaking latch + the new FSM state into the StateDeriver. Always emits —
     * the StateFlow is conflated so a same-value emit is harmless, and it keeps the
     * snapshot consistent when audio plays on the text path (voiceMode OFF → FSM
     * INACTIVE) so no FSM transition fires.
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
