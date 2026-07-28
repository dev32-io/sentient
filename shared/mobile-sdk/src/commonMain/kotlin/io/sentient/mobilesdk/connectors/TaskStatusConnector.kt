// ---------------------------------------------------------------------------
// TaskStatusConnector — session-scoped live tool-call list.
//
// Mirrors web-sdk's task-status-connector.ts:
//   capability = "task.status"  (status observer; no outbound protocol)
//
//   turn.tool.update → upsert by toolCallId into a map. A malformed frame
//                      decodes to ServerMessage.Unknown and never reaches here,
//                      so the TS "reject if a required field is missing" guard is
//                      satisfied by the wire schema. Fire onUpdate(item) + onList(list()).
//
//   list() → all rows sorted by startedAtMs ASCENDING. Terminal states stay in
//            the list — the UI filters running-only if it wants. endedAtMs is
//            carried through once the call reaches a terminal status.
//
// Threading: single-threaded; the orchestrator routes frames + subscribes the
// callbacks. The mutable map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

/**
 * Immutable snapshot of one tool-call row. Built from [ServerMessage.TurnToolUpdate].
 *
 * IDENTITY IS [toolCallId] — one row per model-emitted tool call. [taskId] is present
 * only for a BACKGROUND tool (delegateTask), which returns a handle immediately and
 * completes later via a stimulus; a foreground tool has none.
 */
data class TaskSnapshotItem(
    val toolCallId: String,
    val toolName: String,
    val turnId: String,
    /** "running" | "done" | "error". */
    val status: String,
    /** Auto-derived short preview of the tool's args; "" when absent. USER CONTENT — never logged. */
    val argsPreview: String,
    val startedAtMs: Long,
    val endedAtMs: Long? = null,
    val taskId: String? = null,
)

class TaskStatusConnector(
    private val onUpdate: ((TaskSnapshotItem) -> Unit)? = null,
    private val onList: ((List<TaskSnapshotItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "task-status")

    private val tasks = LinkedHashMap<String, TaskSnapshotItem>()

    /** All rows, ordered by startedAtMs ascending. Safe to read synchronously. */
    fun list(): List<TaskSnapshotItem> = tasks.values.sortedBy { it.startedAtMs }

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnToolUpdate -> onToolUpdate(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onToolUpdate(msg: ServerMessage.TurnToolUpdate) {
        val item = TaskSnapshotItem(
            toolCallId = msg.toolCallId,
            toolName = msg.toolName,
            turnId = msg.turnId,
            status = msg.status,
            argsPreview = msg.argsPreview,
            startedAtMs = msg.startedAtMs,
            endedAtMs = msg.endedAtMs,
            taskId = msg.taskId,
        )
        // argsPreview is user content — ids/status/timing only.
        log.info(
            "turn.tool.update",
            mapOf(
                "toolCallId" to item.toolCallId,
                "turnId" to item.turnId,
                "toolName" to item.toolName,
                "status" to item.status,
                "taskId" to item.taskId,
                "endedAtMs" to item.endedAtMs,
            ),
        )
        tasks[item.toolCallId] = item
        onEvent?.invoke(SdkEvent.TaskUpserted(item))
        onUpdate?.invoke(item)
        onList?.invoke(list())
    }

    /** Clear the row list. Called by the orchestrator on session teardown. */
    fun clear() {
        log.info("clear", mapOf("count" to tasks.size))
        tasks.clear()
    }

    companion object {
        const val CAPABILITY: String = "task.status"
    }
}
