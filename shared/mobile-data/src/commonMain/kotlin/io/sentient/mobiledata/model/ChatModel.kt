package io.sentient.mobiledata.model

import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.ChatMessage

data class ChatModel(
    val committed: List<ChatMessage> = emptyList(),
    val live: ChatMessage? = null,
    /** The composer task strip's live rows. NOT injected into [live] — see
     *  [messagesForUi]. */
    val tasks: List<TaskListItem> = emptyList(),
    val pending: List<PendingMessage> = emptyList(),
    /**
     * True while an EXISTING-session switch is fetching history — between the
     * session.switched and the next conversation.snapshot. The message list shows a
     * spinner; the composer is NEVER gated on it. A brand-new chat stays false (its
     * snapshot is empty/immediate, carried by an empty switched sessionId).
     */
    val historyLoading: Boolean = false,
    /**
     * ACCUMULATING set of pendingIds whose committed echo has been seen on the LIVE
     * in-memory timeline. The reconcile source is the live echo's [echoedPendingIds] —
     * there is no DB. Cold REST snapshots carry pendingId=null, so
     * committed.mapNotNull { it.pendingId } would be empty; this set (sourced from the
     * live echo before any strip) is the VM's drive signal for cache eviction.
     * The VM calls cache.remove(id) for each id here; cache.remove is idempotent so
     * duplicate echoes are harmless. [pending] is ALREADY filtered to exclude these for
     * display; this set is the VM's drive signal for cache eviction, not a per-emission
     * action set.
     */
    val reconciledPendingIds: Set<String> = emptySet(),
) {
    /** Committed rows plus the live bubble. Tool rows are NOT here — they are
     *  the composer strip's, fed straight from [tasks]. */
    fun messagesForUi(): List<ChatMessage> = if (live == null) committed else committed + live
}
