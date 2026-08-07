// ---------------------------------------------------------------------------
// TaskSnapshotItem — one tool-call row, as consumed by mobile-data's live
// reveal fold (RevealReducer, fed by SdkEvent.TaskUpserted) and rendered in
// mobile-data's ChatModel.tasks.
//
// Split out of the now-deleted TaskStatusConnector (Task 9 replaced its wire
// source with TaskListConnector / ServerMessage.TaskListState, which carries
// no per-item turnId). The StateDeriver tile-merge that used to be this type's
// other consumer (committed/live tile derivation in the chat list) was retired
// by the tile-derivation-strip task — do not reintroduce it.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

/**
 * Immutable snapshot of one tool-call row, as mobile-data's live reveal fold
 * consumes it.
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
