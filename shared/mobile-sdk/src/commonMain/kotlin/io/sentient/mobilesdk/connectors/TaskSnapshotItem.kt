// ---------------------------------------------------------------------------
// TaskSnapshotItem — the tool-tile shape StateDeriver's committed/live merge
// (deriveMessages, ChatMessage.tools) still folds into a rendered message.
//
// Split out of the now-deleted TaskStatusConnector (Task 9 replaced its wire
// source with TaskListConnector / ServerMessage.TaskListState, which carries
// no per-item turnId). This type survives ONLY for the StateDeriver tile-merge
// path; that whole mechanism is retired in the tile-derivation-strip task that
// follows — do not grow new callers of it.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

/**
 * Immutable snapshot of one tool-call row, as StateDeriver's tile merge
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
