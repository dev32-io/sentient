package io.sentient.android.chat.message

/** Pure state for the one-shot viewport movement caused by an outbound user row. */
internal data class SendAnchorState(val observed: Set<String> = emptySet())

/** Returns the first newly observed send identity, or null for existing/assistant rows. */
internal fun reduceSendAnchor(
    state: SendAnchorState,
    identities: Set<String>,
): Pair<SendAnchorState, String?> {
    val newIdentity = identities.firstOrNull { it !in state.observed }
    return SendAnchorState(state.observed + identities) to newIdentity
}

internal fun sendAnchorIdentity(pendingId: String): String = "send-$pendingId"
