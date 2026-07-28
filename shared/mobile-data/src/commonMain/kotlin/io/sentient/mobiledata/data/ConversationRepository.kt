package io.sentient.mobiledata.data

import io.sentient.mobilesdk.protocol.SdkEvent
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

    /** No-loss event stream (deltas, tool upserts, turn/commit, session switch). */
    val liveEvents: SharedFlow<SdkEvent>

    /**
     * Accumulating set of pendingIds echoed back on COMMITTED user entries — the LIVE
     * reconcile source, derived from the SDK's in-memory timeline. The optimistic
     * outbox is reconciled against THIS set, so an optimistic bubble is dropped on its
     * echo. Accumulating: once an id is seen it stays in the set, so the bubble stays
     * dropped after the live streaming bubble clears. A COLD REST history snapshot
     * carries no pendingId — those entries are reconciled by the usecase's cold-replace
     * drop (onColdHistoryReplace), not by this set.
     */
    val echoedPendingIds: Flow<Set<String>>

    /** Fire an outbound message with a client-generated pendingId (reconciliation key). */
    fun send(text: String, pendingId: String)
}
