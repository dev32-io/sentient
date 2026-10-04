package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.scan

/** SDK-backed ConversationRepository: pure passthrough to the blackbox SDK surfaces. */
class SdkConversationRepository(private val sdk: SentientSdk) : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> get() = sdk.timeline
    override val tasks: StateFlow<List<TaskListItem>> get() = sdk.tasks
    override val liveEvents: SharedFlow<SdkEvent> get() = sdk.events
    override fun send(text: String, pendingId: String, attachmentIds: List<String>) =
        sdk.sendText(text, pendingId, attachmentIds)

    /** Cold collectors start with current history; both REST and live preserve pendingId. */
    override val echoedPendingIds: Flow<Set<String>> =
        sdk.timeline.scan(emptySet()) { acc, list ->
            acc + list.filter { it.role == "user" && it.sessionId != null }.mapNotNull { it.pendingId }
        }
}
