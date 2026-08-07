// ---------------------------------------------------------------------------
// TaskListConnector — the composer task strip's mirror.
//
// Holds the last `tasklist.state` and nothing else. The gateway sends FULL
// STATE every time and owns row lifetime (a foreground call dies with its
// turn; a background delegateTask outlives it), so there is no upsert, no
// dedup and no clearing rule on this side. Replacing the list IS the contract:
// a replayed frame, a fan-out to a second window and a late joiner's attach are
// all the same operation.
//
// The one live-tool surface. Its retired predecessor mirrored a per-call
// tool-update frame: it kept tool rows forever (its `clear()` had no production
// caller) and left the UI deriving which bubble a pill belonged to — a question
// with no stable answer once a mid-turn steer splits a reply. Both that frame
// and that connector are gone; see shared/protocol/WIRE.md.
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.TaskListItem

class TaskListConnector(
    private val onUpdate: ((turnId: String?, items: List<TaskListItem>) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "task-list")

    private var items: List<TaskListItem> = emptyList()
    private var turn: String? = null

    fun list(): List<TaskListItem> = items

    fun turnId(): String? = turn

    override fun handle(msg: ServerMessage) {
        if (msg !is ServerMessage.TaskListState) return
        items = msg.items
        turn = msg.turnId
        // Row COUNT only — argsPreview is user content (PrivacyGuardTest).
        log.info("state", mapOf("turnId" to (msg.turnId ?: "-"), "count" to msg.items.size))
        onUpdate?.invoke(turn, items)
    }

    /**
     * Drop every row and re-fire [onUpdate] with the empty result. Driven by the
     * orchestrator's `clearConversationScopedState` from EVERY leave-the-conversation
     * entry point (mirrors [DelegationProgressConnector.clear]).
     *
     * The gateway's `tasklist.state` is a per-`SessionRuntime` projector that only
     * re-emits on its OWN mutations (turn start/tool-update/delegation-progress/turn
     * end) — `conversation.activate` triggers no resync push. Without this, switching
     * to a conversation with no task activity of its own leaves the client holding the
     * PREVIOUS conversation's last-known rows indefinitely: exactly the leak
     * [DelegationProgressConnector.clear]'s doc comment describes, and exactly why
     * this re-invokes [onUpdate] rather than silently resetting internal state the way
     * this connector's retired predecessor did (its `clear()` had no production caller
     * and left every consumer holding stale rows forever).
     */
    fun clear() {
        if (items.isEmpty() && turn == null) return
        log.info("clear", mapOf("count" to items.size))
        items = emptyList()
        turn = null
        onUpdate?.invoke(turn, items)
    }

    companion object {
        const val CAPABILITY: String = "tasklist"
    }
}
