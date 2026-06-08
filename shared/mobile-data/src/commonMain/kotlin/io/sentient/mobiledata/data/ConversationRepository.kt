package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
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

    /** No-loss event stream (deltas, task upserts, cycle/commit, session switch). */
    val liveEvents: SharedFlow<SdkEvent>

    /** Fire an outbound message with a client-generated pendingId (reconciliation key). */
    fun send(text: String, pendingId: String)
}
