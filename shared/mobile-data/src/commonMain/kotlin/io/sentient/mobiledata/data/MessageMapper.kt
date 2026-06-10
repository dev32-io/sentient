package io.sentient.mobiledata.data

import io.sentient.mobiledata.cache.db.Message
import io.sentient.mobilesdk.sdk.ChatMessage

/**
 * Maps between the persisted [Message] row and the SDK's rendered [ChatMessage].
 *
 * [ChatMessage] carries no conversationId and no positional seq — those are
 * supplied by the decorator at write time ([toRow]) from the active conversation
 * id + the entry's index in the fused timeline. On read ([toChatMessage]) the row
 * fields fold back into the flat render shape; tools/cycleId/pendingId/streaming
 * are NOT persisted (they are live-stream concerns reconstructed by the usecase
 * graph from liveEvents), so they default on the read path.
 */
internal fun ChatMessage.toRow(conversationId: String, seq: Long): Message = Message(
    entry_id = entryId,
    conversation_id = conversationId,
    seq = seq,
    role = role,
    content = content,
    ts = ts,
    cutoff_kind = cutoffKind,
)

internal fun Message.toChatMessage(): ChatMessage = ChatMessage(
    ts = ts,
    role = role,
    content = content,
    cutoffKind = cutoff_kind,
    entryId = entry_id,
)
