package io.sentient.mobilesdk.protocol

import io.sentient.mobilesdk.connectors.DelegationSnapshotItem
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ChatMessage

sealed class SdkEvent {
    data class MessageStarted(val turnId: String, val replyId: String? = null) : SdkEvent()
    data class MessageDelta(val turnId: String, val chunk: String, val replyId: String? = null) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class TurnDone(val turnId: String) : SdkEvent()
    /** [cutoff] is the gateway CutoffKind: "interrupt" | "barge-in". */
    data class TurnAborted(val turnId: String, val cutoff: String) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()

    /**
     * One-shot: the gateway is asking the user to approve a side-effecting tool call
     * (design §7.1). Delivered on the no-loss [io.sentient.mobilesdk.sdk.SentientSdk.events]
     * SharedFlow, NEVER a conflating StateFlow — two prompts landing back-to-back must both
     * reach the UI.
     */
    data class PermissionRequested(val prompt: PermissionPrompt) : SdkEvent()

    /** One-shot: the request resolved — "allowed" | "denied" | "timeout". The UI dismisses. */
    data class PermissionResolved(val requestId: String, val outcome: String) : SdkEvent()

    /** One-shot: a background delegateTask reported progress (design §5.4). */
    data class DelegationProgressed(val task: DelegationSnapshotItem) : SdkEvent()

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
