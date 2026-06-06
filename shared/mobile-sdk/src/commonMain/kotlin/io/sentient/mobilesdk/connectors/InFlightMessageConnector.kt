// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant content while a
// cycle is still producing. Exposes a single in-flight slot separate from the
// committed conversation history.
//
// Mirrors web-sdk's inflight-message-connector.ts VERBATIM:
//   capability = "message.stream"  (status observer)
//
//   cycle.started  → seed an empty buffer { cycleId, "" } so the UI can render
//                    the pre-first-token "thinking" placeholder. (Guarded on
//                    cycleId present.)
//   message.delta  → append delta to the buffer for cycleId. If the current
//                    buffer belongs to a different cycleId, START FRESH for the
//                    new cycleId (no lingering tail). (Guarded on cycleId +
//                    delta present.)
//   message.done   → clear the buffer, but ONLY if it belongs to cycleId
//                    (ignore done for a different cycle). (Guarded on cycleId.)
//   cycle.aborted  → clear the buffer, same current-cycle guard as done.
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher
// and subscribes onUpdate. The mutable buffer is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.sdk.ChatMessage

/** The streaming buffer for one in-flight cycle. */
data class InFlightMessage(
    val cycleId: String,
    val text: String,
)

class InFlightMessageConnector(
    private val onUpdate: ((InFlightMessage?) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "inflight-message")

    private var current: InFlightMessage? = null

    /** Current buffer. null if no cycle is mid-stream. */
    fun inflight(): InFlightMessage? = current

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.CycleStarted -> onCycleStarted(msg)
            is ServerMessage.MessageDelta -> onDelta(msg)
            is ServerMessage.MessageDone -> onDone(msg.cycleId)
            is ServerMessage.CycleAborted -> onAborted(msg.cycleId)
            else -> Unit // not owned by this connector
        }
    }

    private fun onCycleStarted(msg: ServerMessage.CycleStarted) {
        val next = InFlightMessage(cycleId = msg.cycleId, text = "")
        log.info("seed", mapOf("cycleId" to msg.cycleId))
        current = next
        onUpdate?.invoke(next)
        onEvent?.invoke(SdkEvent.MessageStarted(msg.cycleId))
    }

    private fun onDelta(msg: ServerMessage.MessageDelta) {
        val cycleId = msg.cycleId
        val delta = msg.delta
        if (cycleId == null || delta == null) return // malformed → no-op
        val prior = current?.takeIf { it.cycleId == cycleId }?.text ?: ""
        val next = InFlightMessage(cycleId = cycleId, text = prior + delta)
        log.debug("delta", mapOf("cycleId" to cycleId, "deltaLen" to delta.length, "totalLen" to next.text.length))
        current = next
        onUpdate?.invoke(next)
        onEvent?.invoke(SdkEvent.MessageDelta(cycleId, delta)) // one event per chunk — never batched
    }

    private fun onDone(cycleId: String?) {
        if (cycleId == null) return
        val cur = current
        if (cur != null && cur.cycleId != cycleId) return // done for a different cycle
        log.info("done", mapOf("cycleId" to cycleId))
        val accumulatedText = cur?.text ?: ""
        current = null
        onUpdate?.invoke(null)
        // ts=0: clear-signal; committed text is authoritative via feed/timeline
        onEvent?.invoke(
            SdkEvent.MessageCommitted(
                ChatMessage(ts = 0, role = "assistant", content = accumulatedText, streaming = false, cycleId = cycleId),
            ),
        )
    }

    private fun onAborted(cycleId: String?) {
        if (cycleId == null) return
        val cur = current
        if (cur != null && cur.cycleId != cycleId) return // abort for a different cycle
        log.info("aborted", mapOf("cycleId" to cycleId))
        current = null
        onUpdate?.invoke(null)
    }

    companion object {
        const val CAPABILITY: String = "message.stream"
    }
}
