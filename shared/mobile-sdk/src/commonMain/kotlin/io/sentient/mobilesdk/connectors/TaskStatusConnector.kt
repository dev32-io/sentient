// ---------------------------------------------------------------------------
// TaskStatusConnector — session-scoped live task list.
//
// Mirrors web-sdk's task-status-connector.ts VERBATIM:
//   capability = "task.status"  (status observer; no outbound protocol)
//
//   task.update → upsert by taskId into a map. Requires taskId, toolName,
//                 cycleId, status, startedAtMs (the sealed ServerMessage.TaskUpdate
//                 already enforces these as non-null at decode, so the TS guard
//                 "reject if a required field is missing" is satisfied by the
//                 wire schema — a malformed frame decodes to ServerMessage.Unknown
//                 and never reaches here). argsPreview defaults to "" when blank.
//                 Fire onUpdate(item) + onList(list()).
//
//   list() → all tasks sorted by startedAtMs ASCENDING. Terminal states stay in
//            the list — the UI filters running-only if it wants. endedAtMs is
//            carried through when present (set on the deregister update).
//
// Threading: single-threaded; the orchestrator routes frames + subscribes the
// callbacks. The mutable task map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage

/**
 * Immutable snapshot of one task row. Mirrors web-sdk's `TaskSnapshotItem`.
 *
 * Defined here (not in protocol) because it is a connector-derived view, not a
 * raw wire frame — it is built from [ServerMessage.TaskUpdate] with argsPreview
 * defaulted. C7's SdkState.tasks consumes this type.
 */
data class TaskSnapshotItem(
    val taskId: String,
    val toolName: String,
    val cycleId: String,
    /** Mirrors web-sdk TaskStatus (e.g. "running" | "finished" | "failed"). */
    val status: String,
    /** Auto-derived short preview of the tool's args; "" when absent. */
    val argsPreview: String,
    val startedAtMs: Long,
    val endedAtMs: Long? = null,
)

class TaskStatusConnector(
    private val onUpdate: ((TaskSnapshotItem) -> Unit)? = null,
    private val onList: ((List<TaskSnapshotItem>) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "task-status")

    private val tasks = LinkedHashMap<String, TaskSnapshotItem>()

    /** All tasks, ordered by startedAtMs ascending. Safe to read synchronously. */
    fun list(): List<TaskSnapshotItem> = tasks.values.sortedBy { it.startedAtMs }

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TaskUpdate -> onTaskUpdate(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onTaskUpdate(msg: ServerMessage.TaskUpdate) {
        val item = TaskSnapshotItem(
            taskId = msg.taskId,
            toolName = msg.toolName,
            cycleId = msg.cycleId,
            status = msg.status,
            argsPreview = msg.argsPreview,
            startedAtMs = msg.startedAtMs,
            endedAtMs = msg.endedAtMs,
        )
        log.info(
            "task.update",
            mapOf(
                "taskId" to item.taskId,
                "cycleId" to item.cycleId,
                "status" to item.status,
                "endedAtMs" to item.endedAtMs,
            ),
        )
        tasks[item.taskId] = item
        onUpdate?.invoke(item)
        onList?.invoke(list())
    }

    /** Clear the task list. Called by the orchestrator on session teardown. */
    fun clear() {
        log.info("clear", mapOf("count" to tasks.size))
        tasks.clear()
    }

    companion object {
        const val CAPABILITY: String = "task.status"
    }
}
