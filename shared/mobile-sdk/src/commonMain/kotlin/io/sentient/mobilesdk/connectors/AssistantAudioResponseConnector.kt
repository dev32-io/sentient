// ---------------------------------------------------------------------------
// AssistantAudioResponseConnector — receives assistant audio from the gateway.
//
// Mirrors web-sdk's assistant-audio-response-connector.ts VERBATIM:
//   capability = "audio.output"
//   turn.audio.start → activeTurnId = turnId; isReceiving = true;
//                           isCancelled = false; onAudioStart(turnId)
//   binary frame (handleBinary) → IF isReceiving && !isCancelled →
//                           onAudioFrame(bytes, activeTurnId); else DROP
//   turn.audio.done → isReceiving = false; IF !isCancelled →
//                           onAudioDone(turnId, falling back to activeTurnId when blank)
//   playback.stop → isCancelled = true; isReceiving = false;
//                           onPlaybackStop(reason, defaulting to "barge-in" when blank)
//
// TURN ATTRIBUTION: binary downlink frames carry NO turnId (9-byte header = seq +
// type only), so every frame is attributed to the most recent turn.audio.start.
// The gateway therefore MUST bracket each turn's audio strictly —
// start(t) … frames(t) … done(t) — before start(t+1). AudioPipeline's queue is
// defensive against an overlapping start, but it cannot re-attribute bytes.
//
// DROP-GUARD (the barge-in / interrupt latch — ported exactly):
//   A playback.stop sets isCancelled and clears isReceiving. Subsequent binary
//   frames are DROPPED (the && !isCancelled check) and a trailing
//   turn.audio.done is suppressed — until the NEXT turn.audio.start
//   clears isCancelled and re-enables playback. This is what stops the user
//   hearing the assistant immediately on barge-in while the next turn's audio
//   resumes cleanly.
//
// web-sdk receives binary via sdk.onBinary; mobile-sdk receives it through the
// router calling handleBinary (this connector is MessageRouter.audioConnector).
// web-sdk's separate onCancelled() effect-cancel hook collapses into the SAME
// latch path as playback.stop here — mobile-sdk drives the latch through the
// playback.stop frame, which is the wire signal for barge-in / interrupt.
//
// No coroutines here — the E3 pipeline routes onAudioFrame → VoicePlaybackSink
// .playFrame and onPlaybackStop → .flushPlayback. This connector owns ONLY the flag FSM.
//
// Threading: single-threaded; the router drives handle/handleBinary on the
// orchestrator's dispatcher. The flag/turnId state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage

// JUSTIFIED DIVERGENCE from web-sdk's assistant-audio-response-connector.ts:
// onAudioStart carries encoding + sampleRate. On web, opus→PCM decode lives in
// webui (not web-sdk), so the web connector never sees the encoding. On mobile
// the SDK OWNS decode (AudioPipeline → OpusDecoderPort), so the connector must
// forward turn.audio.start's encoding/sampleRate down to the pipeline.
class AssistantAudioResponseConnector(
    private val onAudioStart: ((turnId: String, encoding: String?, sampleRate: Int?) -> Unit)? = null,
    private val onAudioFrame: ((frame: ByteArray, turnId: String) -> Unit)? = null,
    private val onAudioDone: ((turnId: String) -> Unit)? = null,
    private val onPlaybackStop: ((reason: String, turnId: String) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "assistant-audio-response")

    /** True between audio.start and audio.done / playback.stop. */
    private var isReceiving = false

    /** Drop latch: set on playback.stop, cleared on the next audio.start. */
    private var isCancelled = false

    /** turnId of the currently active audio stream (set on audio.start). */
    private var activeTurnId = ""

    /** Exposed for tests / orchestration: are we accepting downlink frames? */
    fun isReceiving(): Boolean = isReceiving

    /** Exposed for tests / orchestration: is the current stream cancel-latched? */
    fun isCancelled(): Boolean = isCancelled

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnAudioStart -> onStart(msg.turnId, msg.encoding, msg.sampleRate)
            is ServerMessage.TurnAudioDone -> onDone(msg.turnId)
            is ServerMessage.PlaybackStop -> onStop(msg.reason, msg.turnId)
            else -> Unit // not owned by this connector
        }
    }

    /** Raw PCM16 LE downlink. Gated by the receiving && !cancelled drop-guard. */
    override fun handleBinary(bytes: ByteArray) {
        if (!isReceiving || isCancelled) {
            log.debug(
                "frame-dropped",
                mapOf("bytes" to bytes.size, "isReceiving" to isReceiving, "isCancelled" to isCancelled),
            )
            return
        }
        log.debug("downlink-frame", mapOf("bytes" to bytes.size, "turnId" to activeTurnId))
        onAudioFrame?.invoke(bytes, activeTurnId)
    }

    private fun onStart(turnId: String, encoding: String?, sampleRate: Int?) {
        activeTurnId = turnId
        isReceiving = true
        isCancelled = false
        log.info(
            "transition",
            mapOf(
                "to" to "receiving",
                "trigger" to "turn.audio.start",
                "turnId" to turnId,
                "encoding" to (encoding ?: ""),
                "sampleRate" to (sampleRate ?: 0),
            ),
        )
        onAudioStart?.invoke(turnId, encoding, sampleRate)
    }

    private fun onDone(turnId: String) {
        // Blank turnId (a malformed/legacy frame) falls back to the stream in flight.
        val doneId = turnId.ifEmpty { activeTurnId }
        isReceiving = false
        log.info(
            "transition",
            mapOf(
                "to" to "idle",
                "trigger" to "turn.audio.done",
                "turnId" to doneId,
                "isCancelled" to isCancelled,
            ),
        )
        if (!isCancelled) onAudioDone?.invoke(doneId)
    }

    private fun onStop(reason: String, turnId: String) {
        // Mark this stream dropped. isReceiving stays false until a fresh
        // turn.audio.start arrives — the next turn's audio re-enables
        // playback automatically.
        isCancelled = true
        isReceiving = false
        val effectiveReason = reason.ifEmpty { DEFAULT_STOP_REASON }
        log.info(
            "transition",
            mapOf(
                "to" to "cancelled",
                "trigger" to "playback.stop",
                "reason" to effectiveReason,
                "turnId" to turnId,
            ),
        )
        onPlaybackStop?.invoke(effectiveReason, turnId)
    }

    companion object {
        const val CAPABILITY: String = "audio.output"

        /** web-sdk defaults an absent playback.stop reason to "barge-in". */
        private const val DEFAULT_STOP_REASON: String = "barge-in"
    }
}
