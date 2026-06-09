package io.sentient.mobiledata.model

import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.sdk.ChatMessage

data class ChatModel(
    val committed: List<ChatMessage> = emptyList(),
    val live: ChatMessage? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val pending: List<PendingMessage> = emptyList(),
    /**
     * True while an EXISTING-session switch is fetching history — between the
     * session.switched and the next conversation.snapshot. The message list shows a
     * spinner; the composer is NEVER gated on it. A brand-new chat stays false (its
     * snapshot is empty/immediate, carried by an empty switched sessionId).
     */
    val historyLoading: Boolean = false,
) {
    fun messagesForUi(): List<ChatMessage> =
        if (live == null) committed else committed + live.copy(tools = tasks)
}
