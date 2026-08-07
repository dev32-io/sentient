// ---------------------------------------------------------------------------
// DelegationProgressConnector — live progress for BACKGROUND delegateTask work
// (design §5.4 / §7). Closest analog: the retired TaskStatusConnector (same
// upsert-by-id shape; superseded by TaskListConnector's full-state model),
// but a delegation row is agent-scoped and outlives the turn that dispatched it —
// its completion returns later as a stimulus, so terminal rows stay in the list and
// the UI filters if it wants.
//
// PRIVACY: `note` is worker-authored text (it can quote user content). Log its LENGTH
// only, never the note.
//
// Threading: single-threaded; the router drives handle() on the orchestrator's
// dispatcher. The mutable map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

/** Immutable snapshot of one delegated background task. */
data class DelegationSnapshotItem(
    val taskId: String,
    /** The turn that dispatched the delegation (join key for the UI's turn grouping). */
    val turnId: String,
    /** Worker identity, e.g. "hermes". */
    val agent: String,
    /** "running" | "done" | "error". */
    val status: String,
    /** Short worker-authored progress note; null when absent. USER-ADJACENT — never logged. */
    val note: String? = null,
)

class DelegationProgressConnector(
    private val onList: ((List<DelegationSnapshotItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "delegation-progress")

    private val tasks = LinkedHashMap<String, DelegationSnapshotItem>()

    /** All delegation rows in arrival order. Terminal rows are retained. */
    fun list(): List<DelegationSnapshotItem> = tasks.values.toList()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.DelegationProgress -> onProgress(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onProgress(msg: ServerMessage.DelegationProgress) {
        val item = DelegationSnapshotItem(
            taskId = msg.taskId,
            turnId = msg.turnId,
            agent = msg.agent,
            status = msg.status,
            note = msg.note,
        )
        log.info(
            "delegation.progress",
            mapOf(
                "taskId" to item.taskId,
                "turnId" to item.turnId,
                "agent" to item.agent,
                "status" to item.status,
                "noteLen" to (item.note?.length ?: 0),
            ),
        )
        tasks[item.taskId] = item
        onEvent?.invoke(SdkEvent.DelegationProgressed(item))
        onList?.invoke(list())
    }

    /**
     * Drop every row. Driven by the orchestrator's `clearConversationScopedState` from
     * EVERY leave-the-conversation entry point — the awaited `newChat` / `switchSession`
     * and the fire-and-forget `sendNewChat` / `sendSwitchSession` the UI actually uses.
     * Never driven by interrupt or by the reconnect re-establish: a delegation outlives
     * its turn and survives a resume of the same conversation.
     */
    fun clear() {
        if (tasks.isEmpty()) return
        log.info("clear", mapOf("count" to tasks.size))
        tasks.clear()
        onList?.invoke(list())
    }

    companion object {
        const val CAPABILITY: String = "delegation.progress"
    }
}
