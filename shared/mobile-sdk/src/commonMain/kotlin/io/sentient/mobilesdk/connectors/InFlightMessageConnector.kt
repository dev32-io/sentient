// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant content while a
// turn is still producing. Exposes an in-flight slot separate from the
// committed conversation history.
//
// Mirrors web-sdk's inflight-message-connector.ts:
//   capability = "message.stream"  (status observer)
//
//   turn.started    → seed an empty buffer { turnId, "" } so the UI can render
//                     the pre-first-token "thinking" placeholder.
//   turn.text.delta → append text to THAT turn's buffer.
//   turn.completed  → commit + remove that turn's buffer.
//   turn.aborted    → drop that turn's buffer (no commit).
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher
// and subscribes onUpdate. The mutable buffer map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.sdk.ChatMessage

/** The streaming buffer for one in-flight turn. */
data class InFlightMessage(
    val turnId: String,
    val text: String,
)

class InFlightMessageConnector(
    private val onUpdate: ((InFlightMessage?) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "inflight-message")

    // ONE BUFFER PER TURN, in arrival order. A 2.0 follow-up turn (§4.5/§7.2) can open
    // while the previous turn's deltas are still landing; the pre-2.0 single `current`
    // slot silently DISCARDED the earlier turn's accumulated text. Insertion order makes
    // [inflight] the newest still-open turn — the one the live bubble renders.
    private val buffers = LinkedHashMap<String, InFlightMessage>()

    /** Newest still-open streaming buffer; null when no turn is mid-stream. */
    fun inflight(): InFlightMessage? = buffers.values.lastOrNull()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnTextDelta -> onDelta(msg.turnId, msg.text)
            is ServerMessage.TurnCompleted -> onCompleted(msg.turnId)
            is ServerMessage.TurnAborted -> onAborted(msg.turnId, msg.cutoff)
            else -> Unit // not owned by this connector
        }
    }

    private fun onTurnStarted(turnId: String) {
        if (turnId.isEmpty()) return
        buffers[turnId] = InFlightMessage(turnId = turnId, text = "")
        log.info("seed", mapOf("turnId" to turnId, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        onEvent?.invoke(SdkEvent.MessageStarted(turnId))
    }

    private fun onDelta(turnId: String, text: String) {
        if (turnId.isEmpty() || text.isEmpty()) return
        // Absent buffer → create: a delta may legitimately precede its turn.started on a
        // resume replay. Content is NEVER logged — lengths only (PrivacyGuardTest).
        val next = InFlightMessage(turnId = turnId, text = (buffers[turnId]?.text ?: "") + text)
        buffers[turnId] = next
        log.debug(
            "delta",
            mapOf("turnId" to turnId, "deltaLen" to text.length, "totalLen" to next.text.length, "open" to buffers.size),
        )
        onUpdate?.invoke(inflight())
        onEvent?.invoke(SdkEvent.MessageDelta(turnId = turnId, chunk = text)) // one event per chunk — never batched
    }

    private fun onCompleted(turnId: String) {
        // Unknown turn → no-op: committing "" here would drain ANOTHER turn's live bubble.
        val done = buffers.remove(turnId) ?: return
        log.info("done", mapOf("turnId" to turnId, "totalLen" to done.text.length, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        // ts=0: clear-signal; committed text is authoritative via feed/timeline.
        onEvent?.invoke(
            SdkEvent.MessageCommitted(
                ChatMessage(ts = 0, role = "assistant", content = done.text, streaming = false, turnId = turnId),
            ),
        )
    }

    private fun onAborted(turnId: String, cutoff: String) {
        val dropped = buffers.remove(turnId) ?: return
        log.info(
            "aborted",
            mapOf("turnId" to turnId, "cutoff" to cutoff, "droppedLen" to dropped.text.length, "open" to buffers.size),
        )
        onUpdate?.invoke(inflight())
        // No MessageCommitted on abort; the abort surfaces as SdkEvent.TurnAborted (TurnErrorConnector).
    }

    companion object {
        const val CAPABILITY: String = "message.stream"
    }
}
