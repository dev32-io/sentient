package io.sentient.mobiledata.model

import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.AssistantActivityState
import io.sentient.mobilesdk.sdk.ChatMessage

data class ChatModel(
    val committed: List<ChatMessage> = emptyList(),
    val live: ChatMessage? = null,
    /** The composer task strip's live rows. NOT injected into [live] — see
     *  [messagesForUi]. */
    val tasks: List<TaskListItem> = emptyList(),
    val pending: List<PendingMessage> = emptyList(),
    /** Sole assistant row eligible for thinking/responding presentation. */
    val assistantActivity: AssistantActivityState = AssistantActivityState(),
    /**
     * True while an EXISTING-session switch is fetching history — between the
     * session.switched and the next conversation.snapshot. The message list shows a
     * spinner; the composer is NEVER gated on it. A brand-new chat stays false (its
     * snapshot is empty/immediate, carried by an empty switched sessionId).
     */
    val historyLoading: Boolean = false,
    /** Accumulated live/REST committed user pendingIds for idempotent cache eviction.
     * Durable owners additionally match authoritative sessionId from [committed]. */
    val reconciledPendingIds: Set<String> = emptySet(),
) {
    /** Preserves existing Swift initializer after assistant activity became model state. */
    constructor(
        committed: List<ChatMessage>,
        live: ChatMessage?,
        tasks: List<TaskListItem>,
        pending: List<PendingMessage>,
        historyLoading: Boolean,
        reconciledPendingIds: Set<String>,
    ) : this(
        committed = committed,
        live = live,
        tasks = tasks,
        pending = pending,
        assistantActivity = AssistantActivityState(),
        historyLoading = historyLoading,
        reconciledPendingIds = reconciledPendingIds,
    )

    /** Committed rows plus the live bubble. Tool rows are NOT here — they are
     *  the composer strip's, fed straight from [tasks]. */
    fun messagesForUi(): List<ChatMessage> = if (live == null) committed else committed + live
}
