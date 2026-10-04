package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Stateless read/command surface for the ACTIVE conversation. The SDK is on one
 * conversation at a time; switching is a SessionsRepository concern. No combine,
 * no accumulation, no connection gating — those belong to usecases / the VM.
 */
interface ConversationRepository {
    /** Committed history of the active conversation. */
    val timeline: StateFlow<List<ChatMessage>>

    /**
     * The composer task strip's live rows for the active conversation. Full-state
     * passthrough of [io.sentient.mobilesdk.sdk.SentientSdk.tasks] — the gateway
     * sends the complete list every time, so there is no fold or accumulation
     * here, and the SDK itself clears it on every conversation-leave.
     */
    val tasks: StateFlow<List<TaskListItem>>

    /** No-loss event stream (deltas, turn/commit, session switch). Tool activity is
     *  NOT on this stream — it arrives as state on [tasks], not as an event. */
    val liveEvents: SharedFlow<SdkEvent>

    /** Accumulated committed user pendingIds from both live and REST history.
     * Durable reconciliation must also match the receipt's authoritative sessionId. */
    val echoedPendingIds: Flow<Set<String>>

    /** Fire an outbound message with a client-generated pendingId (reconciliation key). */
    fun send(text: String, pendingId: String, attachmentIds: List<String> = emptyList())
}
