package io.sentient.mobiledata.model

import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.sdk.ChatMessage

data class ChatModel(
    val committed: List<ChatMessage> = emptyList(),
    val live: ChatMessage? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val pending: List<PendingMessage> = emptyList(),
) {
    fun messagesForUi(): List<ChatMessage> =
        if (live == null) committed else committed + live.copy(tools = tasks)
}
