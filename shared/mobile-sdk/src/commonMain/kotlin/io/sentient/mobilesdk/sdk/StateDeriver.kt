// ---------------------------------------------------------------------------
// StateDeriver — folds the connector slices into one immutable SdkState (R5).
//
// The orchestrator holds ONE StateDeriver. Each connector callback updates a
// slice here, then asks for derive() and emits the result on the single
// StateFlow. Native UIs re-derive NOTHING — they read SdkState fields directly.
//
// messages: mirrors web-sdk deriveMessages — committed user/assistant/tool/
// trigger feed items folded to ChatMessage, then the live in-flight buffer
// appended as a streaming=true bubble when present. cutoffKind comes off the
// assistant entry's cutoff. (The webui typewriter / cycleId-stamping is a UI
// presentation concern, not an SDK contract — left to the native UI.)
//
// cognition: the cycle-driven CognitionState (THINKING/IDLE). ACTING is never
// derived from tasks — it stays unreached, matching the C4 connector + the TS.
//
// Pure + synchronous: no coroutines, no platform types, no logging (the
// orchestrator logs the integration trail; this is a value transform).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.Clock

/**
 * Holds the connector-owned slices and folds them into [SdkState].
 *
 * Single-threaded: the orchestrator mutates slices and calls [derive] from one
 * dispatcher. Each setter returns Unit; [derive] builds the immutable snapshot.
 *
 * @param clock Injected wall-clock used to stamp the live streaming bubble's ts
 *   so it sorts after committed entries (mirrors web-sdk's Date.now()).
 */
class StateDeriver(private val clock: Clock) {
    var status: SdkStatus = SdkStatus.DISCONNECTED
    var feed: List<ConversationFeedItem> = emptyList()
    var inflight: InFlightMessage? = null
    var transcript: String = ""
    var cognition: CognitionState = CognitionState.IDLE
    var voiceMode: VoiceMode = VoiceMode.OFF
    var prefs: AudioPreferences = AudioPreferences.DEFAULT
    var tasks: List<TaskSnapshotItem> = emptyList()
    var isSpeaking: Boolean = false
    var connectionLost: Boolean = false
    var authExpired: Boolean = false

    /** Build the immutable snapshot from the current slices. */
    fun derive(): SdkState = SdkState(
        status = status,
        messages = deriveMessages(feed, inflight, clock.nowMs()),
        transcript = transcript,
        cognition = cognition,
        voiceMode = voiceMode,
        prefs = prefs,
        tasks = tasks,
        isSpeaking = isSpeaking,
        connectionLost = connectionLost,
        authExpired = authExpired,
    )
}

/**
 * Fold committed feed items + the live in-flight buffer into the chat list.
 * Mirrors web-sdk deriveMessages: committed entries first, the streaming bubble
 * last. Empty user / empty-non-cutoff assistant entries are dropped (barge-in
 * markers / pre-token placeholders that don't render), matching the TS.
 */
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    for (item in feed) {
        committedMessage(item)?.let(out::add)
    }
    if (inflight != null) {
        out.add(ChatMessage(ts = nowMs, role = ROLE_ASSISTANT, content = inflight.text, streaming = true))
    }
    return out
}

private fun committedMessage(item: ConversationFeedItem): ChatMessage? = when (item) {
    is ConversationFeedItem.User ->
        if (item.content.isEmpty()) null
        else ChatMessage(ts = item.ts, role = ROLE_USER, content = item.content)

    is ConversationFeedItem.Assistant ->
        if (item.content.isEmpty() && item.cutoff == null) null
        else ChatMessage(ts = item.ts, role = ROLE_ASSISTANT, content = item.content, cutoffKind = item.cutoff?.kind)

    is ConversationFeedItem.Tool ->
        ChatMessage(ts = item.ts, role = ROLE_TOOL, content = item.summary)

    is ConversationFeedItem.Trigger ->
        ChatMessage(ts = item.ts, role = ROLE_TRIGGER, content = item.summary)
}

private const val ROLE_USER = "user"
private const val ROLE_ASSISTANT = "assistant"
private const val ROLE_TOOL = "tool"
private const val ROLE_TRIGGER = "trigger"
