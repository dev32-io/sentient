// ---------------------------------------------------------------------------
// Chat types — shared types for the SDK's public chat surfaces.
//
// Both native UIs consume the split surfaces:
//   connection: StateFlow<ConnectionState>  — transport + voice axis
//   timeline:   StateFlow<List<ChatMessage>> — committed message history
//
// The legacy SdkState aggregate has been removed (dead code cleanup).
// ChatMessage and VoiceMode are live types consumed by both UIs and the SDK.
//
// TaskSnapshotItem (C5) is imported for ChatMessage.tools.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.TaskSnapshotItem

/** Voice-mode latch. OFF = text path; ACTIVE = mic streaming (full pipeline E3). */
enum class VoiceMode { OFF, ACTIVE }

/**
 * One rendered chat message. Folds a committed [ConversationFeedItem] OR the
 * live in-flight streaming buffer into a flat, SKIE-friendly shape.
 *
 * @param ts Wall-clock ms of the entry (feed item ts, or now for the streaming bubble). May be 0 for a clear-signal event payload (e.g. MessageCommitted), whose authoritative timestamp arrives via the conversation feed — consumers rendering a date from a raw event must guard ts <= 0.
 * @param role "user" | "assistant" | "tool" | "trigger".
 * @param content Rendered text.
 * @param streaming True for the live in-flight bubble (pre-commit). False once committed.
 * @param cutoffKind "interrupt" | "barge-in" when an assistant reply was cut short.
 * @param turnId Turn that produced this assistant message (UI join key for tools). Null when unknown.
 * @param pendingId Correlates an optimistic client send to its committed feed entry. Set on user
 *   messages derived from a [ConversationFeedItem.User] that carries a pendingId (echoed back by
 *   the gateway). ChatRepository uses this to reconcile the optimistic bubble by id. Null when the
 *   entry has no associated optimistic send (assistant, tool, trigger entries, or legacy user entries
 *   that predate the pendingId echo).
 * @param tools Tool rows grouped onto this message by shared turnId (mirrors web-sdk ChatMessage.tools).
 * @param entryId Stable gateway entry id of the committed feed item this message folds. Empty for the
 *   live streaming bubble (pre-commit) and for legacy frames without an entryId. Used for Slice-4
 *   mirror keying + de-dup of a replayed committed entry on reconnect (Task 3.10).
 */
data class ChatMessage(
    val ts: Long,
    val role: String,
    val content: String,
    val streaming: Boolean = false,
    val cutoffKind: String? = null,
    val turnId: String? = null,
    val pendingId: String? = null,
    val tools: List<TaskSnapshotItem> = emptyList(),
    val entryId: String = "",
)
