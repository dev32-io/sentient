package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.scan

/** SDK-backed ConversationRepository: pure passthrough to the blackbox SDK surfaces. */
class SdkConversationRepository(private val sdk: SentientSdk) : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> get() = sdk.timeline
    override val liveEvents: SharedFlow<SdkEvent> get() = sdk.events
    override fun send(text: String, pendingId: String) = sdk.sendText(text, pendingId)

    /**
     * Accumulating fold of every pendingId carried on a committed entry of the SDK's
     * in-memory timeline (the live-echo reconcile source). Cold scan: each collector
     * restarts from the StateFlow's current value, which already holds the full
     * committed history, so every echoed pendingId to date is captured; the
     * accumulation pins each id once seen across later emissions. A COLD REST history
     * snapshot carries no pendingId — those entries are reconciled by the usecase's
     * cold-replace drop, not by this set.
     */
    override val echoedPendingIds: Flow<Set<String>> =
        sdk.timeline.scan(emptySet()) { acc, list -> acc + list.mapNotNull { it.pendingId } }
}
