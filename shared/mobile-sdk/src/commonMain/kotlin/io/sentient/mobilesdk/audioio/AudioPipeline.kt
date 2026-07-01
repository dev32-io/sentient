// ---------------------------------------------------------------------------
// AudioPipeline — the DOWNLINK voice flow manager (E3).
//
// Wires the downlink codec (A4) + playback adapter (E2) into the assistant-audio
// path (connector → decode → playback + isSpeaking latch + FSM). Constructed +
// run by the orchestrator (SdkAudio → SentientSdk) on its injected scope. The
// real-time mic UPLINK now lives entirely in the voice/ package (VoiceAudio.micFrames →
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
 * @param playback Playback sink (the downlink slice of VoiceAudio). null → frames dropped.
 * @param opusDecoder Long-lived OGG-Opus → PCM16-LE decoder (A4); one instance, reset
 *   between cycles. Only invoked in opus mode; pcm16 passes through untouched.
 * @param fsm Voice-status FSM (drives ConnectionState.audioState display).
 * @param scope Orchestrator coroutine scope.
 * @param outputSampleRate Assistant playback rate (Hz) — pcm16 fallback when none announced.
 * @param onStateChanged Pushes isSpeaking + FSM state into the orchestrator's StateDeriver.
 * @param playbackDrainSettleMs Settle (ms) after the player reports idle before speaking
 *   clears — keeps the interrupt affordance through the speaker tail.
 * @param armPlayback LAZY-ARM the downlink engine on the first TTS cycle. Suspends until
 *   the engine reports playback-active (Ready) — returns true — or fails (false). Routed
 *   through SdkVoice's serialized configure lane so it composes with the mic axis (VPIO).
 *   Default `{ true }` for the text/test path (no real engine; frames drop at the null
 *   [playback] guard anyway). Mirrors web-sdk's arm-on-audio.start model: the engine only
 *   runs while there is actually audio to play, not for the whole connection.
 * @param disarmPlayback Release the downlink engine once a TTS cycle has drained / been
 *   interrupted. A no-op in voice mode (mic on → full-duplex engine stays up, no per-reply
 *   VPIO churn); a teardown-to-idle in text mode (mic off → releases the .playAndRecord
 *   mic reservation → battery + no idle mic indicator). Default no-op for text/test.
 */
class AudioPipeline(
    private val playback: VoicePlaybackSink?,
    private val opusDecoder: OpusDecoderPort,
    private val fsm: AudioFsm,
    private val scope: CoroutineScope,
    private val outputSampleRate: Int,
    private val onStateChanged: (isSpeaking: Boolean, fsmState: AudioState) -> Unit,
    private val playbackDrainSettleMs: Long = DEFAULT_DRAIN_SETTLE_MS,
    private val armPlayback: suspend () -> Boolean = { true },
    private val disarmPlayback: () -> Unit = {},
) {
    private val log = createLogger("audio", "pipeline")

    // Lazy-arm latch. playbackStarted flips true when a cycle requests the engine; the
    // async arm job flips playbackReady true once the engine reports playback-active,
    // then flushes pendingFrames. Frames that arrive before the engine is armed buffer
    // in pendingFrames (arm latency ~ one configure) so the TTS onset is never clipped.
    private var playbackStarted = false
    private var playbackReady = false
    private val pendingFrames = mutableListOf<ByteArray>()
    private var armJob: Job? = null

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
     * connector.audio.start: mark speaking + arm the decoder for the cycle. The player
     * is PRE-STARTED by `VoiceAudio.configure(playback = true)` at 48 kHz, so there is
     * no async `start(rate)` to await — [playbackReady] flips true synchronously and
     * frames route straight to [VoicePlaybackSink.playFrame]. [encoding]/[sampleRate]
     * come from the wire frame: opus mode decodes binary frames through opusDecoder
     * (libopus always decodes to 48 kHz, ignoring the announced rate); pcm16 mode passes
     * bytes through at the announced rate (or [outputSampleRate] fallback — logging only).
     */
    fun onAudioStart(cycleId: String, encoding: String? = null, sampleRate: Int? = null) {
        // A NEWER cycle's audio arriving while a prior cycle is still playing/queued →
        // drop the superseded audio so the user hears the LATEST response, not the old
        // tail (webui parity). The cycleId guard in onAudioFrame/onAudioDone then drops
        // any late frames/done still in flight for the superseded cycle.
        if (activeCycleId.isNotEmpty() && activeCycleId != cycleId) {
            log.info("downlink-supersede", mapOf("superseded" to activeCycleId, "next" to cycleId))
            playback?.flushPlayback()
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
        isSpeaking = true
        activeCycleId = cycleId
        armPlaybackOnce()
        transition(AudioInput.AudioStart, cycleId)
    }

    /**
     * Arm the downlink engine for this cycle if not already armed. Idempotent across
     * frames of the same cycle. [armPlayback] suspends through SdkVoice's serialized
     * configure lane; frames buffer in [pendingFrames] until it resolves, then flush in
     * order. A barge-in/supersede that resets [playbackStarted] while the arm is in
     * flight makes the post-arm guard skip the flush (those frames were dropped on
     * purpose) — mirrors the proven pre-consolidation startPlaybackOnce buffering.
     */
    private fun armPlaybackOnce() {
        if (playbackStarted || playback == null) {
            playbackReady = playbackStarted // text/test path (null playback): treat as ready-noop
            return
        }
        playbackStarted = true
        playbackReady = false
        armJob?.cancel()
        armJob = scope.launch {
            val armed = armPlayback()
            if (playbackStarted && armed) {
                val flushed = pendingFrames.size
                playbackReady = true
                for (f in pendingFrames) playback.playFrame(f)
                pendingFrames.clear()
                log.debug("downlink-armed", mapOf("flushed" to flushed))
            } else {
                log.warn("downlink-arm-skipped", mapOf("armed" to armed, "started" to playbackStarted))
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

    /** Feed [bytes] straight to the player (pre-started); buffer only if not yet ready. */
    private fun enqueueOrBuffer(bytes: ByteArray, cycleId: String) {
        if (playbackReady) {
            log.debug("downlink-frame", mapOf("bytes" to bytes.size, "cycleId" to cycleId))
            playback?.playFrame(bytes)
        } else {
            // M2: defensive latch — in the pre-start model playbackReady flips true
            // synchronously in onAudioStart and is only reset by onPlaybackStop /
            // suspendPlayback (both clear pendingFrames), so this branch is not hit in
            // production. Kept as a guard against a future regress where playbackReady
            // is reset without clearing pendingFrames (frames would otherwise be lost).
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

    /** Clear the speaking latch + advance the FSM once the speaker has truly drained,
     *  then RELEASE the downlink engine (lazy model: it only runs while there is audio). */
    private fun finalizeDrain(cycleId: String) {
        if (!framesDone) return
        framesDone = false
        isSpeaking = false
        activeCycleId = ""
        log.info("downlink-drained", mapOf("cycleId" to cycleId))
        releasePlaybackEngine()
        transition(AudioInput.AudioDone, cycleId)
    }

    /**
     * Release the downlink engine after a cycle ends (drain / interrupt). Cancels any
     * in-flight arm, drops the latch, and disarms — a no-op in voice mode (mic keeps the
     * full-duplex engine up), a teardown-to-idle in text mode (frees the .playAndRecord
     * mic reservation → battery). Gated on [playbackStarted] so a spurious call (never
     * armed) does not spam the configure lane.
     */
    private fun releasePlaybackEngine() {
        armJob?.cancel()
        if (!playbackStarted) return
        playbackStarted = false
        playbackReady = false
        disarmPlayback()
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
        playback?.flushPlayback()
        if (opusMode) opusDecoder.reset()
        // Discard any frames buffered before the player was ready — barge-in drops pending
        // audio. releasePlaybackEngine cancels a pending arm + disarms the engine (lazy
        // model) — a no-op in voice mode, a teardown in text mode.
        pendingFrames.clear()
        releasePlaybackEngine()
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
        armJob?.cancel() // a pending arm must not fire + flush into a suspended pipeline
        framesDone = false
        playbackReady = false
        pendingFrames.clear()
        opusDecoder.reset()
        // Lazy model: the engine is only armed during a cycle. Drop queued audio + reset
        // the latch so the next audio.start (post-reconnect) re-arms from scratch. The
        // engine's own teardown is owned by the SDK lifecycle, not driven from here (a
        // configure on the teardown path could race the reconnect).
        if (playbackStarted) {
            playbackStarted = false
            playback?.flushPlayback()
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
