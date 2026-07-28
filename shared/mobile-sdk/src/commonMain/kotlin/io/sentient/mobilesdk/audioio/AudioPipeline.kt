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
//
// TURN QUEUEING (design §7.2): audio is a FIFO of per-turn segments. A new turnId NEVER
// cancels, fades, or replaces in-flight audio — it plays after it. flushPlayback() is
// reserved for barge-in / interrupt (onPlaybackStop) and transient teardown
// (suspendPlayback). The tuned hold-defer / lazy-arm / drain-watch machinery is unchanged.
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
 * rate or the rate announced in turn.audio.start. Opus-mode playback MUST
 * therefore start at this rate; the announced sampleRate is ignored in opus mode.
 */
private const val OPUS_DECODE_RATE_HZ = 48_000

/** The turn.audio.start encoding value that selects opus-decode mode. */
private const val ENCODING_OPUS = "opus"

/** Poll interval (ms) while waiting for the player to physically drain after audio.done. */
private const val DRAIN_POLL_MS = 50L

/** Default settle (ms) after the player reports idle before clearing the speaking state. */
private const val DEFAULT_DRAIN_SETTLE_MS = 250L

/** PCM16 mono = 2 bytes per sample. Used to size the deferred-buffer bound. */
private const val PCM16_BYTES_PER_SAMPLE = 2

/**
 * Deferred-buffer bound: ~30 s of 48 kHz mono PCM16 = 30 * 48000 * 2 = 2_880_000 bytes.
 * Bounds BOTH deferred buffers, each FIFO drop-OLDEST on overflow:
 *   - the HOLD buffer (design §7.3): proactive TTS arriving while [beginHold] is in effect
 *     accumulates in [pendingFrames] and flushes on [endHold]; and
 *   - each QUEUED-BEHIND turn's raw-wire buffer (design §7.2), held in TurnAudioQueue until
 *     that turn is promoted to head.
 * In the normal (non-hold, non-overlapping) lazy-arm path the buffer is tiny (arm settles in
 * ~one configure), so this bound only ever bites during a long hold or a stalled head turn.
 */
private const val HOLD_BUFFER_SECONDS = 30
private const val DEFAULT_DEFERRED_BUFFER_MAX_BYTES = HOLD_BUFFER_SECONDS * OPUS_DECODE_RATE_HZ * PCM16_BYTES_PER_SAMPLE

/**
 * The downlink voice flow manager. One per orchestrator; reusable across turns.
 *
 * @param playback Playback sink (the downlink slice of VoiceAudio). null → frames dropped.
 * @param opusDecoder Long-lived OGG-Opus → PCM16-LE decoder (A4); one instance, reset
 *   between turns. Only invoked in opus mode; pcm16 passes through untouched.
 * @param fsm Voice-status FSM (drives ConnectionState.audioState display).
 * @param scope Orchestrator coroutine scope.
 * @param outputSampleRate Assistant playback rate (Hz) — pcm16 fallback when none announced.
 * @param onStateChanged Pushes isSpeaking + FSM state into the orchestrator's StateDeriver.
 * @param playbackDrainSettleMs Settle (ms) after the player reports idle before speaking
 *   clears — keeps the interrupt affordance through the speaker tail.
 * @param armPlayback LAZY-ARM the downlink engine on the first TTS turn. Suspends until
 *   the engine reports playback-active (Ready) — returns true — or fails (false). Routed
 *   through SdkVoice's serialized configure lane so it composes with the mic axis (VPIO).
 *   Default `{ true }` for the text/test path (no real engine; frames drop at the null
 *   [playback] guard anyway). Mirrors web-sdk's arm-on-audio.start model: the engine only
 *   runs while there is actually audio to play, not for the whole connection.
 * @param disarmPlayback Release the downlink engine once a TTS turn has drained / been
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
    private val holdBufferMaxBytes: Int = DEFAULT_DEFERRED_BUFFER_MAX_BYTES,
    /** Bound (bytes) on EACH queued-behind turn's deferred buffer (§7.2). Same drop-oldest
     *  rationale as the hold buffer; separate so a test can shrink one without the other. */
    queueBufferMaxBytes: Int = DEFAULT_DEFERRED_BUFFER_MAX_BYTES,
) {
    private val log = createLogger("audio", "pipeline")

    // Lazy-arm latch. playbackStarted flips true when a turn requests the engine; the
    // async arm job flips playbackReady true once the engine reports playback-active,
    // then flushes pendingFrames. Frames that arrive before the engine is armed buffer
    // in pendingFrames (arm latency ~ one configure) so the TTS onset is never clipped.
    private var playbackStarted = false
    private var playbackReady = false
    private val pendingFrames = mutableListOf<ByteArray>()
    private var armJob: Job? = null

    // Hold-defer (design spec §7.3). While [holdDeferred] (TalkMode == Hold), downlink TTS
    // must NEVER arm playback: onAudioStart buffers-only, frames accumulate in [pendingFrames]
    // (bounded, drop-oldest) and flush on [endHold]. The head segment's own streamDone flag
    // records a turn that finished SENDING during the hold, so the arm's post-flush hook can
    // settle it. [holdBufferedBytes] tracks the buffer size for the bound.
    private var holdDeferred = false
    private var holdBufferedBytes = 0

    // true when the active TTS stream is OGG-Opus (encoding="opus") → each binary
    // frame is decoded to PCM16-LE via opusDecoder before enqueue. false → pcm16
    // passthrough. Set on audio.start, used by audio.frame / done / playback.stop.
    private var opusMode = false

    // isSpeaking is an independent latch (true between audio.start and done/playback-
    // stop), NOT derived from the FSM: assistant TTS plays on the TEXT path too
    // (voiceMode OFF → FSM INACTIVE) and must still flip speaking (webui isAudioPlaying).
    private var isSpeaking = false

    // Per-turn downlink FIFO (§7.2). Replaces the single activeTurnId slot: a NEW turn
    // queues BEHIND the audio already playing and NEVER flushes it. flushPlayback() is
    // reserved for the two user actions — barge-in and interrupt (onPlaybackStop) — plus
    // the transient teardown (suspendPlayback).
    private val queue = TurnAudioQueue(maxBufferedBytesPerTurn = queueBufferMaxBytes)

    // turnId of the most recent turn.audio.start; the id the drain-watch finalizes under
    // and the id stopLocal reports. Cleared with the queue.
    private var lastTurnId = ""

    // Drain-watch: true between audio.done and the speaker physically draining. While
    // true, isSpeaking (and the interrupt affordance) are HELD — audio.done only means
    // the server finished sending; the player is still playing its buffered tail.
    private var framesDone = false
    private var drainJob: Job? = null

    // ── Downlink ────────────────────────────────────────────────────────────────

    /**
     * turn.audio.start. A FRESH head arms the decoder + LAZY-ARMS the engine for this turn.
     * A turn arriving while another is in flight QUEUES BEHIND it (design §7.2): no flush,
     * no decoder reset, no re-arm, no FSM transition — the pipeline is already speaking and
     * stays speaking. [encoding]/[sampleRate] come off the wire frame: opus decodes through
     * opusDecoder (libopus always outputs 48 kHz, ignoring the announced rate); pcm passes
     * through at the announced rate ([outputSampleRate] fallback — logging only).
     */
    fun onAudioStart(turnId: String, encoding: String? = null, sampleRate: Int? = null) {
        val opus = encoding.equals(ENCODING_OPUS, ignoreCase = true)
        val becameHead = queue.open(turnId, opus)
        lastTurnId = turnId
        if (!becameHead) {
            log.info(
                "downlink-queue-behind",
                mapOf("turnId" to turnId, "head" to (queue.head?.turnId ?: ""), "depth" to queue.depth, "opus" to opus),
            )
            return
        }
        // Fresh head: this turn owns the decoder, the arm, and the drain watch from here.
        drainJob?.cancel()
        framesDone = false
        opusMode = opus
        val playbackRate = if (opusMode) OPUS_DECODE_RATE_HZ else (sampleRate ?: outputSampleRate)
        log.info(
            "downlink-start",
            mapOf("turnId" to turnId, "opusMode" to opusMode, "playbackRate" to playbackRate, "depth" to queue.depth),
        )
        if (opusMode) opusDecoder.reset()
        // HOLD (spec §7.3): buffer only — do NOT flip speaking, do NOT arm playback, do NOT
        // transition the FSM. Frames accumulate in [pendingFrames] and flush on [endHold].
        if (holdDeferred) {
            log.info("downlink-hold-start", mapOf("turnId" to turnId, "opusMode" to opusMode))
            return
        }
        isSpeaking = true
        armPlaybackOnce()
        transition(AudioInput.AudioStart, turnId)
    }

    /**
     * Arm the downlink engine for this turn if not already armed. Idempotent across
     * frames of the same turn. [armPlayback] suspends through SdkVoice's serialized
     * configure lane; frames buffer in [pendingFrames] until it resolves, then flush in
     * order. A barge-in that resets [playbackStarted] while the arm is in flight makes the
     * post-arm guard skip the flush (those frames were dropped on purpose) — mirrors the
     * proven pre-consolidation startPlaybackOnce buffering.
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
                clearPendingFrames()
                log.debug("downlink-armed", mapOf("flushed" to flushed))
                // The buffered bytes are now in the player. Settle the head only AFTER the
                // flush — a pre-flush idle=true would false-finalize and clear speaking early.
                if (framesDone) armDrainWatch(lastTurnId)
                else if (queue.head?.streamDone == true) finishHeadSegment()
            } else {
                log.warn("downlink-arm-skipped", mapOf("armed" to armed, "started" to playbackStarted))
            }
        }
    }

    /**
     * Binary downlink frame. HEAD turn: decode (opus) or pass through (pcm) straight to the
     * ready/pending path. QUEUED turn: buffer the RAW bytes — decoding now would corrupt the
     * head turn's decoder state. Unknown turn (already drained / flushed): stale-drop.
     */
    fun onAudioFrame(frame: ByteArray, turnId: String) {
        if (playback == null) return
        if (queue.isHead(turnId)) {
            forwardFrame(frame, turnId)
            return
        }
        val queued = queue.segmentFor(turnId)
        if (queued != null) {
            val dropped = queue.bufferBehind(turnId, frame)
            if (dropped > 0) {
                log.warn(
                    "queue-buffer-overflow",
                    mapOf("reason" to "queue-buffer-overflow", "turnId" to turnId, "droppedBytes" to dropped),
                )
            }
            log.debug(
                "downlink-frame-queued",
                mapOf(
                    "bytes" to frame.size,
                    "turnId" to turnId,
                    "depth" to queue.depth,
                    "bufferedFrames" to queued.depth,
                    "bufferedBytes" to queued.bufferedBytes,
                ),
            )
            return
        }
        log.debug(
            "downlink-frame-stale-drop",
            mapOf("frameTurn" to turnId, "head" to (queue.head?.turnId ?: ""), "reason" to "no-open-segment"),
        )
    }

    /** Decode-or-passthrough one raw frame for the turn currently streaming into the player. */
    private fun forwardFrame(frame: ByteArray, turnId: String) {
        if (!opusMode) {
            enqueueOrBuffer(frame, turnId)
            return
        }
        val decoded = opusDecoder.decode(frame)
        log.debug(
            "downlink-decode",
            mapOf("oggBytes" to frame.size, "pcmFrames" to decoded.size, "turnId" to turnId),
        )
        for (pcm in decoded) enqueueOrBuffer(pcm, turnId)
    }

    /** Feed [bytes] to the player once armed; buffer until the lazy arm settles (or, during a
     *  hold, until [endHold]). [holdDeferred] forces buffering even if a stale ready latch
     *  lingers — the invariant "in Hold, playback is NEVER armed" holds by construction. */
    private fun enqueueOrBuffer(bytes: ByteArray, turnId: String) {
        if (playbackReady && !holdDeferred) {
            log.debug("downlink-frame", mapOf("bytes" to bytes.size, "turnId" to turnId))
            playback?.playFrame(bytes)
        } else {
            // Lazy-arm / hold buffer: frames that arrive before the engine is armed queue here
            // so the TTS onset is never clipped. Bounded (drop-OLDEST, FIFO) so a long hold can
            // never grow the buffer without limit. Cleared on flush / barge-in / suspend.
            pendingFrames.add(bytes)
            holdBufferedBytes += bytes.size
            val dropped = trimHoldBufferToBound()
            if (dropped > 0) {
                log.warn(
                    "hold-buffer-overflow",
                    mapOf("reason" to "hold-buffer-overflow", "droppedBytes" to dropped, "depth" to pendingFrames.size, "bufferedBytes" to holdBufferedBytes),
                )
            }
            log.debug(
                "downlink-frame-buffered",
                mapOf("bytes" to bytes.size, "depth" to pendingFrames.size, "turnId" to turnId),
            )
        }
    }

    /** Drop OLDEST buffered frames (FIFO) until the buffer is within [holdBufferMaxBytes].
     *  Never drops the just-added newest frame (keeps ≥1). Returns the bytes dropped. */
    private fun trimHoldBufferToBound(): Int {
        var dropped = 0
        while (holdBufferedBytes > holdBufferMaxBytes && pendingFrames.size > 1) {
            val old = pendingFrames.removeAt(0)
            holdBufferedBytes -= old.size
            dropped += old.size
        }
        return dropped
    }

    /** Clear the pending/hold buffer + reset its byte counter (single source of truth). */
    private fun clearPendingFrames() {
        pendingFrames.clear()
        holdBufferedBytes = 0
    }

    /**
     * turn.audio.done: the server finished SENDING this turn's frames — the player is still
     * playing its buffered tail. Mark the segment done; the HEAD then either promotes the
     * next queued turn or (queue empty) starts the physical-drain watch.
     */
    fun onAudioDone(turnId: String) {
        if (queue.segmentFor(turnId) == null) {
            log.debug(
                "downlink-done-stale-drop",
                mapOf("doneTurn" to turnId, "head" to (queue.head?.turnId ?: "")),
            )
            return
        }
        queue.markStreamDone(turnId)
        log.info(
            "downlink-done",
            mapOf("turnId" to turnId, "isHead" to queue.isHead(turnId), "depth" to queue.depth),
        )
        if (!queue.isHead(turnId)) return // a queued turn finished early; promotion drains it
        if (opusMode) opusDecoder.reset()
        // HOLD (spec §7.3): nothing is playing, so there is nothing to drain. [endHold] arms
        // + flushes, and the post-flush hook settles the head from there.
        if (holdDeferred) {
            log.info("downlink-hold-done", mapOf("turnId" to turnId))
            return
        }
        finishHeadSegment()
    }

    /**
     * The head turn finished streaming. Promote queued turns (handing their buffered bytes
     * to the player, in order) until one is still streaming; when the queue drains, arm the
     * physical-drain watch. Deferred when bytes are still waiting on the lazy arm — a
     * pre-flush isPlaybackIdle=true would false-finalize and clear speaking early.
     */
    private fun finishHeadSegment() {
        if (promoteUntilStreaming() != null) return // a queued turn took over — keep speaking
        framesDone = true
        if (!playbackReady && pendingFrames.isNotEmpty()) {
            log.debug("drain-watch-deferred", mapOf("pending" to pendingFrames.size, "turnId" to lastTurnId))
            return
        }
        armDrainWatch(lastTurnId)
    }

    /** Pop the finished head and forward each queued turn's buffered bytes, in order, until
     *  one is still streaming. Returns that turn, or null once the queue is empty. */
    private fun promoteUntilStreaming(): TurnAudioSegment? {
        var next = queue.promote()
        while (next != null) {
            opusMode = next.opus
            if (opusMode) opusDecoder.reset()
            val buffered = next.takeBuffered()
            log.info(
                "downlink-promote",
                mapOf("turnId" to next.turnId, "frames" to buffered.size, "opusMode" to opusMode, "depth" to queue.depth),
            )
            for (raw in buffered) forwardFrame(raw, next.turnId)
            if (!next.streamDone) return next
            if (opusMode) opusDecoder.reset()
            next = queue.promote()
        }
        return null
    }

    /**
     * After audio.done, poll the playback adapter until it has PHYSICALLY drained
     * (every enqueued frame played out the speaker), then a short settle, then clear
     * the speaking state + fire the FSM AudioDone. Holding it this long is what keeps
     * the interrupt affordance visible through the speaker tail (webui parity). A promoted
     * queued turn or an interrupt (onPlaybackStop) cancels the watch.
     */
    private fun armDrainWatch(turnId: String) {
        drainJob?.cancel()
        val pb = playback ?: run { finalizeDrain(turnId); return }
        drainJob = scope.launch {
            while (framesDone && !pb.isPlaybackIdle) delay(DRAIN_POLL_MS)
            if (!framesDone) return@launch // superseded by a promotion / interrupt
            delay(playbackDrainSettleMs)
            if (framesDone && pb.isPlaybackIdle) finalizeDrain(turnId)
        }
    }

    /** Clear the speaking latch + advance the FSM once the speaker has truly drained,
     *  then RELEASE the downlink engine (lazy model: it only runs while there is audio). */
    private fun finalizeDrain(turnId: String) {
        if (!framesDone) return
        framesDone = false
        isSpeaking = false
        queue.clear()
        lastTurnId = ""
        log.info("downlink-drained", mapOf("turnId" to turnId))
        releasePlaybackEngine()
        transition(AudioInput.AudioDone, turnId)
    }

    /**
     * Release the downlink engine after a turn ends (drain / interrupt). Cancels any
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

    // ── Hold-and-defer (design spec §7.3) ─────────────────────────────────────────

    /**
     * Enter Hold buffering (TalkMode == Hold). While held, downlink TTS must NEVER arm
     * playback: [onAudioStart] buffers-only and frames accumulate in the bounded
     * [pendingFrames] (drop-oldest on overflow), flushing on [endHold]. Cancels any in-flight
     * arm and drops the ready latch so a lingering armed turn can't play into the hold — the
     * controller interrupts any active reply BEFORE entering Hold, so this is normally a no-op.
     * Idempotent.
     */
    fun beginHold() {
        if (holdDeferred) return
        holdDeferred = true
        armJob?.cancel()
        playbackReady = false
        playbackStarted = false
        log.info("hold-begin", mapOf("bufferedFrames" to pendingFrames.size, "bufferedBytes" to holdBufferedBytes))
    }

    /**
     * Exit Hold buffering (releaseMic / lockMic). If a proactive TTS was buffered during the
     * hold, flip speaking + arm playback + flush the buffer IN ORDER, then continue live. From
     * commonMain's view release AND lock are both "arm + flush"; the platform actual selects
     * the media vs duplex path from the (mic, playback) cell. If nothing was buffered this is a
     * clean no-op. Idempotent.
     */
    fun endHold() {
        if (!holdDeferred) return
        holdDeferred = false
        val hadBuffered = pendingFrames.isNotEmpty()
        val head = queue.head
        log.info(
            "hold-end",
            mapOf(
                "bufferedFrames" to pendingFrames.size,
                "bufferedBytes" to holdBufferedBytes,
                "streamDone" to (head?.streamDone ?: false),
                "turnId" to (head?.turnId ?: ""),
                "depth" to queue.depth,
            ),
        )
        if (head == null && !hadBuffered) return // nothing arrived during the hold
        isSpeaking = true
        // NEVER pre-set framesDone here (the pre-2.0 line was `framesDone = streamDone`).
        // The arm's post-flush hook settles the head once the buffered reply has actually
        // reached the player — a pre-flush isPlaybackIdle=true would false-finalize and
        // clear speaking early. Resetting to false also drops any stale flag from a turn
        // that ended before the hold began.
        framesDone = false
        armPlaybackOnce()
        transition(AudioInput.AudioStart, head?.turnId ?: "")
    }

    /** Local Stop (UI/escape): force-stop playback for the active turn without a server frame. */
    fun stopLocal() {
        if (queue.isEmpty && !isSpeaking) return
        onPlaybackStop(reason = "interrupt-local", turnId = lastTurnId)
    }

    /** playback.stop (barge-in / interrupt): flush playback, reset decoder, clear speaking. */
    fun onPlaybackStop(reason: String, turnId: String) {
        log.info("downlink-stop", mapOf("reason" to reason, "turnId" to turnId))
        // Interrupt/barge-in clears speaking immediately — cancel any pending drain-watch.
        drainJob?.cancel()
        framesDone = false
        playback?.flushPlayback()
        if (opusMode) opusDecoder.reset()
        // Discard any frames buffered before the player was ready — barge-in drops pending
        // audio. releasePlaybackEngine cancels a pending arm + disarms the engine (lazy
        // model) — a no-op in voice mode, a teardown in text mode.
        clearPendingFrames()
        releasePlaybackEngine()
        isSpeaking = false
        queue.clear()
        lastTurnId = ""
        transition(AudioInput.Interrupt, turnId)
    }

    /**
     * Transient teardown for a reconnect / idle disconnect: stop playback and RESET
     * the opus decoder — but KEEP the native codec allocated so the next reconnect can
     * decode again. Closing it here would free the native libopus decoder; the next
     * turn's reset()/decode() would then abort or silently drop all TTS. Use [dispose]
     * for terminal teardown.
     */
    fun suspendPlayback() {
        log.info("suspend")
        drainJob?.cancel()
        armJob?.cancel() // a pending arm must not fire + flush into a suspended pipeline
        framesDone = false
        playbackReady = false
        // A reconnect/idle mid-hold: reset the hold gate so the next audio.start re-arms from
        // scratch (never strand the pipeline in defer mode across a transient teardown).
        holdDeferred = false
        clearPendingFrames()
        queue.clear()
        lastTurnId = ""
        opusDecoder.reset()
        // Lazy model: the engine is only armed during a turn. Drop queued audio + reset
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
    private fun transition(input: AudioInput, turnId: String = "") {
        val prev = fsm.state
        val next = fsm.handle(input)
        if (next != prev) {
            log.debug(
                "fsm",
                mapOf("from" to prev, "to" to next, "input" to input::class.simpleName, "turnId" to turnId),
            )
        }
        onStateChanged(isSpeaking, next)
    }
}
