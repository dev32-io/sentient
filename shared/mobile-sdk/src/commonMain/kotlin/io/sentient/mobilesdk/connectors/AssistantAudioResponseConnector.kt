// ---------------------------------------------------------------------------
// AssistantAudioResponseConnector — receives assistant audio from the gateway.
//
// Mirrors web-sdk's assistant-audio-response-connector.ts VERBATIM:
//   capability = "audio.output"
//   connector.audio.start → activeCycleId = cycleId; isReceiving = true;
//                           isCancelled = false; onAudioStart(cycleId)
//   binary frame (handleBinary) → IF isReceiving && !isCancelled →
//                           onAudioFrame(bytes, activeCycleId); else DROP
//   connector.audio.done → isReceiving = false; IF !isCancelled →
//                           onAudioDone(cycleId ?: activeCycleId)
//   playback.stop → isCancelled = true; isReceiving = false;
//                           onPlaybackStop(reason ?: "barge-in", cycleId ?: "")
//
// DROP-GUARD (the barge-in / interrupt latch — ported exactly):
//   A playback.stop sets isCancelled and clears isReceiving. Subsequent binary
//   frames are DROPPED (the && !isCancelled check) and a trailing
//   connector.audio.done is suppressed — until the NEXT connector.audio.start
//   clears isCancelled and re-enables playback. This is what stops the user
//   hearing the assistant immediately on barge-in while the next cycle's audio
//   resumes cleanly.
//
// web-sdk receives binary via sdk.onBinary; mobile-sdk receives it through the
// router calling handleBinary (this connector is MessageRouter.audioConnector).
// web-sdk's separate onCancelled() effect-cancel hook collapses into the SAME
// latch path as playback.stop here — mobile-sdk drives the latch through the
// playback.stop frame, which is the wire signal for barge-in / interrupt.
//
// No coroutines here — the E3 pipeline routes onAudioFrame → AudioPlaybackAdapter
// .enqueue and onPlaybackStop → .clear. This connector owns ONLY the flag FSM.
//
// Threading: single-threaded; the router drives handle/handleBinary on the
// orchestrator's dispatcher. The flag/cycleId state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage

class AssistantAudioResponseConnector(
    private val onAudioStart: ((cycleId: String) -> Unit)? = null,
    private val onAudioFrame: ((frame: ByteArray, cycleId: String) -> Unit)? = null,
    private val onAudioDone: ((cycleId: String) -> Unit)? = null,
    private val onPlaybackStop: ((reason: String, cycleId: String) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "assistant-audio-response")

    /** True between audio.start and audio.done / playback.stop. */
    private var isReceiving = false

    /** Drop latch: set on playback.stop, cleared on the next audio.start. */
    private var isCancelled = false

    /** cycleId of the currently active audio stream (set on audio.start). */
    private var activeCycleId = ""

    /** Exposed for tests / orchestration: are we accepting downlink frames? */
    fun isReceiving(): Boolean = isReceiving

    /** Exposed for tests / orchestration: is the current stream cancel-latched? */
    fun isCancelled(): Boolean = isCancelled

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.ConnectorAudioStart -> onStart(msg.cycleId ?: "")
            is ServerMessage.ConnectorAudioDone -> onDone(msg.cycleId)
            is ServerMessage.PlaybackStop -> onStop(msg.reason, msg.cycleId)
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
        log.debug("downlink-frame", mapOf("bytes" to bytes.size, "cycleId" to activeCycleId))
        onAudioFrame?.invoke(bytes, activeCycleId)
    }

    private fun onStart(cycleId: String) {
        activeCycleId = cycleId
        isReceiving = true
        isCancelled = false
        log.info(
            "transition",
            mapOf("to" to "receiving", "trigger" to "connector.audio.start", "cycleId" to cycleId),
        )
        onAudioStart?.invoke(cycleId)
    }

    private fun onDone(cycleId: String?) {
        val doneId = cycleId ?: activeCycleId
        isReceiving = false
        log.info(
            "transition",
            mapOf(
                "to" to "idle",
                "trigger" to "connector.audio.done",
                "cycleId" to doneId,
                "isCancelled" to isCancelled,
            ),
        )
        if (!isCancelled) onAudioDone?.invoke(doneId)
    }

    private fun onStop(reason: String?, cycleId: String?) {
        // Mark this stream dropped. isReceiving stays false until a fresh
        // connector.audio.start arrives — the next cycle's audio re-enables
        // playback automatically.
        isCancelled = true
        isReceiving = false
        val effectiveReason = reason ?: DEFAULT_STOP_REASON
        log.info(
            "transition",
            mapOf(
                "to" to "cancelled",
                "trigger" to "playback.stop",
                "reason" to effectiveReason,
                "cycleId" to (cycleId ?: ""),
            ),
        )
        onPlaybackStop?.invoke(effectiveReason, cycleId ?: "")
    }

    companion object {
        const val CAPABILITY: String = "audio.output"

        /** web-sdk defaults an absent playback.stop reason to "barge-in". */
        private const val DEFAULT_STOP_REASON: String = "barge-in"
    }
}
