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
}
