package io.sentient.mobilesdk.protocol

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ChatMessage

sealed class SdkEvent {
    data class MessageStarted(val cycleId: String) : SdkEvent()
    data class MessageDelta(val cycleId: String, val chunk: String) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class CycleDone(val cycleId: String) : SdkEvent()
    data class CycleAborted(val cycleId: String, val kind: String?) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()

    /**
     * One-shot notice: a reconnect re-establish was rejected by the gateway with
     * `sessions.error code=forbidden` — the owned conversation was dropped on the
     * server (e.g. the Hermes worker recycled it). The SDK has cleared the anchor;
     * the next user send starts a FRESH conversation. The UI should surface a brief
     * notice (e.g. "Couldn't reopen that chat — started a new one."). Fire-once, no
     * payload: it carries no state, only the fact of the failed reopen. Delivered on
     * the no-loss [events] SharedFlow, never the conflating connection StateFlow.
     */
    data object ReopenFailed : SdkEvent()
}
