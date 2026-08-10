package io.sentient.mobilesdk.protocol

import kotlinx.serialization.Serializable

/**
 * One live task/tool row, as an ELEMENT of a `tasklist.state` frame
 * ([ServerMessage.TaskListState]) — never decoded standalone.
 *
 * Identity is [id] — NOT `toolCallId`: for a foreground call it is the
 * provider's tool-call id; for a background `delegateTask` it is the
 * gateway's `taskId`. [kind] tells them apart. Every field carries a default
 * so a partial/malformed row degrades rather than failing to decode (matching
 * [ConversationFeedItem]'s precedent) — a dropped `tasklist.state` frame would
 * blank the whole composer strip, not just one row.
 */
@Serializable
data class TaskListItem(
    val id: String = "",
    val toolName: String = "",
    /** "foreground" | "background". */
    val kind: String = "foreground",
    /** "running" | "done" | "error". */
    val status: String = "",
    /** Auto-derived short preview of the tool's args; "" when absent. USER CONTENT — never logged. */
    val argsPreview: String = "",
    val startedAtMs: Long = 0L,
    val endedAtMs: Long? = null,
)
