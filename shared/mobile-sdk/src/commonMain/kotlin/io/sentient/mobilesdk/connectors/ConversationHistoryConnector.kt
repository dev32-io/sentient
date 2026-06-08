// ---------------------------------------------------------------------------
// ConversationHistoryConnector — session-scoped read-only mirror of the
// gateway's ConversationHistory.
//
// Mirrors web-sdk's conversation-history-connector.ts VERBATIM:
//   capability = "conversation.history"  (status observer)
//
//   conversation.snapshot → REPLACE the mirror, release the gate, fire
//                           onSnapshot + onUpdate.
//   conversation.entry    → APPEND to the mirror, fire onEntry + onUpdate,
//                           UNLESS awaitingSnapshot (then DROP — a straggler
//                           from the prior generation).
//   session.switched      → set the awaitingSnapshot gate. The gateway emits
//                           switched-then-snapshot on every switch/resume, so
//                           the gate is set first and immediately released by
//                           the snapshot — keeping post-switch live entries
//                           flowing.
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher
// and subscribes the callbacks. The mutable mirror + gate are owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

class ConversationHistoryConnector(
    private val onSnapshot: ((List<ConversationFeedItem>) -> Unit)? = null,
    private val onEntry: ((ConversationFeedItem) -> Unit)? = null,
    private val onUpdate: ((List<ConversationFeedItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
    // Fired on session.switched so the orchestrator can drop cross-conversation
    // derivation state (the ts → cycleId stamp map) before the next snapshot.
    private val onSwitch: (() -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "conversation-history")

    private var mirror: List<ConversationFeedItem> = emptyList()

    // Generation gate: set on session.switched, cleared on every snapshot.
    // Entries received between session.switched and the next snapshot are dropped.
    private var awaitingSnapshot: Boolean = false

    /** Current ordered mirror of the feed. Safe to read synchronously. */
    fun items(): List<ConversationFeedItem> = mirror

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.ConversationSnapshot -> onSnapshotFrame(msg)
            is ServerMessage.ConversationEntry -> onEntryFrame(msg)
            is ServerMessage.SessionSwitched -> onSessionSwitched(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onSnapshotFrame(msg: ServerMessage.ConversationSnapshot) {
        log.info(
            "snapshot",
            mapOf("count" to msg.items.size, "wasAwaiting" to awaitingSnapshot),
        )
        mirror = msg.items.toList() // REPLACE, not merge
        awaitingSnapshot = false
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    private fun onEntryFrame(msg: ServerMessage.ConversationEntry) {
        if (awaitingSnapshot) {
            log.debug("entry-dropped", mapOf("reason" to "awaiting-snapshot", "ts" to msg.item.ts))
            return // drop straggler from prior generation
        }
        log.info("entry", mapOf("ts" to msg.item.ts, "size" to mirror.size + 1))
        mirror = mirror + msg.item
        onEntry?.invoke(msg.item)
        onUpdate?.invoke(mirror)
    }

    private fun onSessionSwitched(msg: ServerMessage.SessionSwitched) {
        log.info("gate-set", mapOf("trigger" to "session.switched", "sessionId" to msg.sessionId))
        awaitingSnapshot = true
        // Drop cross-conversation derivation state BEFORE the following snapshot
        // re-stamps; otherwise an old cycleId could attach to the new feed.
        onSwitch?.invoke()
        onEvent?.invoke(SdkEvent.SessionSwitched(sessionId = msg.sessionId))
    }

    companion object {
        const val CAPABILITY: String = "conversation.history"
    }
}
