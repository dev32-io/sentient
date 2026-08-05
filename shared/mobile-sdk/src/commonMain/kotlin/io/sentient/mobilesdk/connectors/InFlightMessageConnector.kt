// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant content while a
// turn is still producing. Exposes an in-flight slot separate from the
// committed conversation history.
//
// Mirrors web-sdk's inflight-message-connector.ts:
//   capability = "message.stream"  (status observer)
//
//   turn.started    → seed an empty buffer so the UI can render the
//                     pre-first-token "thinking" placeholder.
//   turn.text.delta → append text to THAT BUBBLE's buffer.
//   turn.completed  → commit + remove every buffer of that turn.
//   turn.aborted    → drop that turn's buffers (no commit).
//
// ONE BUFFER PER BUBBLE, NOT PER TURN. A ReAct turn produces text more than
// once — narration, a tool round trip, then the answer — and all of it belongs
// to one bubble that grew. But a message the person sends mid-turn is drawn as
// its own row BETWEEN two of those stretches, so the text after it has to start
// a new bubble. The gateway decides where that boundary falls and stamps every
// delta with a `messageId` (session-runtime.ts rotates it on a mid-turn user
// message); this connector just follows. Nothing is derived here.
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher
// and subscribes onUpdate. The mutable buffer map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.sdk.ChatMessage

/** The streaming buffer for one in-flight bubble. */
data class InFlightMessage(
    val turnId: String,
    val text: String,
    /** Null against a gateway that does not stamp deltas — the buffer is then
     *  keyed by turn, which is the pre-`messageId` behaviour. */
    val messageId: String? = null,
)

class InFlightMessageConnector(
    private val onUpdate: ((InFlightMessage?) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "inflight-message")

    // Keyed by BUBBLE, in arrival order. A 2.0 follow-up turn (§4.5/§7.2) can open
    // while the previous turn's deltas are still landing; the pre-2.0 single `current`
    // slot silently DISCARDED the earlier turn's accumulated text. Insertion order makes
    // [inflight] the newest still-open bubble — the one the live bubble renders.
    private val buffers = LinkedHashMap<String, InFlightMessage>()

    /** Newest still-open streaming buffer; null when nothing is mid-stream. */
    fun inflight(): InFlightMessage? = buffers.values.lastOrNull()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnTextDelta -> onDelta(msg.turnId, msg.messageId, msg.text)
            is ServerMessage.TurnCompleted -> onCompleted(msg.turnId)
            is ServerMessage.TurnAborted -> onAborted(msg.turnId, msg.cutoff)
            else -> Unit // not owned by this connector
        }
    }

    /** The map key for one bubble. Falls back to the turn when the gateway sent
     *  no `messageId`, which reproduces the old one-buffer-per-turn behaviour. */
    private fun keyOf(turnId: String, messageId: String?): String = messageId ?: turnId

    private fun onTurnStarted(turnId: String) {
        if (turnId.isEmpty()) return
        // Seeded under the TURN key: `turn.started` carries no messageId, and the
        // first delta is what names the bubble. `onDelta` re-keys this buffer in
        // place, so the placeholder never becomes an orphan.
        buffers[turnId] = InFlightMessage(turnId = turnId, text = "")
        log.info("seed", mapOf("turnId" to turnId, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        onEvent?.invoke(SdkEvent.MessageStarted(turnId))
    }

    private fun onDelta(turnId: String, messageId: String?, text: String) {
        if (turnId.isEmpty() || text.isEmpty()) return
        val key = keyOf(turnId, messageId)

        // The seeded placeholder is keyed by turn; the first stamped delta adopts
        // it so its "thinking" bubble becomes this message's buffer rather than
        // being stranded beside it.
        if (key != turnId) adoptSeededBuffer(turnId, key, messageId)

        val isNewBubble = !buffers.containsKey(key)
        // Absent buffer → create: a delta may legitimately precede its turn.started on a
        // resume replay. Content is NEVER logged — lengths only (PrivacyGuardTest).
        val next = InFlightMessage(
            turnId = turnId,
            text = (buffers[key]?.text ?: "") + text,
            messageId = messageId,
        )
        buffers[key] = next
        if (isNewBubble && messageId != null) {
            log.info("bubble-opened", mapOf("turnId" to turnId, "messageId" to messageId, "open" to buffers.size))
            onEvent?.invoke(SdkEvent.MessageStarted(turnId, messageId))
        }
        log.debug(
            "delta",
            mapOf(
                "turnId" to turnId,
                "messageId" to (messageId ?: "-"),
                "deltaLen" to text.length,
                "totalLen" to next.text.length,
                "open" to buffers.size,
            ),
        )
        onUpdate?.invoke(inflight())
        // One event per chunk — never batched.
        onEvent?.invoke(SdkEvent.MessageDelta(turnId = turnId, chunk = text, messageId = messageId))
    }

    /** Move the turn-keyed placeholder onto its real bubble key, ONCE — only
     *  while it is still empty. A non-empty turn-keyed buffer belongs to a
     *  gateway that sent unstamped deltas and must not be stolen. */
    private fun adoptSeededBuffer(turnId: String, key: String, messageId: String?) {
        val seeded = buffers[turnId] ?: return
        if (seeded.text.isNotEmpty()) return
        buffers.remove(turnId)
        buffers[key] = seeded.copy(messageId = messageId)
    }

    private fun onCompleted(turnId: String) {
        // EVERY bubble of this turn, not just the newest: a turn the person spoke
        // through owns more than one, and each is a reply that must be committed.
        val done = buffers.entries.filter { it.value.turnId == turnId }.map { it.key to it.value }
        if (done.isEmpty()) return // unknown turn → no-op; committing "" would drain a peer's live bubble
        for ((key, _) in done) buffers.remove(key)
        log.info("done", mapOf("turnId" to turnId, "bubbles" to done.size, "open" to buffers.size))
        onUpdate?.invoke(inflight())
        for ((_, buffer) in done) {
            // ts=0: clear-signal; committed text is authoritative via feed/timeline.
            onEvent?.invoke(
                SdkEvent.MessageCommitted(
                    ChatMessage(
                        ts = 0,
                        role = "assistant",
                        content = buffer.text,
                        streaming = false,
                        turnId = turnId,
                        messageId = buffer.messageId,
                    ),
                ),
            )
        }
    }

    private fun onAborted(turnId: String, cutoff: String) {
        val dropped = buffers.entries.filter { it.value.turnId == turnId }.map { it.key }
        if (dropped.isEmpty()) return
        for (key in dropped) buffers.remove(key)
        log.info("aborted", mapOf("turnId" to turnId, "cutoff" to cutoff, "dropped" to dropped.size))
        onUpdate?.invoke(inflight())
        // No MessageCommitted on abort; the abort surfaces as SdkEvent.TurnAborted (TurnErrorConnector).
    }

    companion object {
        const val CAPABILITY: String = "message.stream"
    }
}
