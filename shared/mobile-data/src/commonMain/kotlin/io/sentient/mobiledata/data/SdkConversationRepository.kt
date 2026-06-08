package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** SDK-backed ConversationRepository: pure passthrough to the blackbox SDK surfaces. */
class SdkConversationRepository(private val sdk: SentientSdk) : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> get() = sdk.timeline
    override val liveEvents: SharedFlow<SdkEvent> get() = sdk.events
    override fun send(text: String, pendingId: String) = sdk.sendText(text, pendingId)
}
