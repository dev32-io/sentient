// ---------------------------------------------------------------------------
// StateDeriver — folds the connector slices into the split observable surfaces:
//   deriveConnection() → ConnectionState (transport + voice axis)
//   deriveTimeline()   → List<ChatMessage> (committed history, no streaming bubble)
//
// The orchestrator holds ONE StateDeriver. Each connector callback updates a
// slice here, then calls deriveConnection()/deriveTimeline() and emits on the
// respective StateFlow. Native UIs read ConnectionState or the timeline directly.
//
// deriveMessages folds committed user/assistant feed items to ChatMessage rows.
// Tool activity is NOT part of this list — it renders in the composer task
// strip off `tasklist.state` (TaskListConnector); trigger entries are context
// for the model, not a user-facing artifact.
//
// Pure + synchronous: no coroutines, no platform types, no logging (the
// orchestrator logs the integration trail; this is a value transform).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.Clock

/**
 * Holds the connector-owned slices and projects them onto the split surfaces.
 *
 * Single-threaded: the orchestrator mutates slices and calls [deriveConnection]/
 * [deriveTimeline] from one dispatcher. Each setter returns Unit.
 *
 * @param clock Injected wall-clock used to stamp the live streaming bubble's ts
 *   so it sorts after committed entries (mirrors web-sdk's Date.now()).
 */
class StateDeriver(private val clock: Clock) {
    var status: SdkStatus = SdkStatus.DISCONNECTED
    var feed: List<ConversationFeedItem> = emptyList()

    /** Live in-flight buffer for the streaming bubble. */
    var inflight: InFlightMessage? = null

    var transcript: String = ""
    var cognition: CognitionState = CognitionState.IDLE
    var voiceMode: VoiceMode = VoiceMode.OFF
    var prefs: AudioPreferences = AudioPreferences.DEFAULT
    var isSpeaking: Boolean = false
    var audioState: AudioState = AudioState.INACTIVE
    var hasSession: Boolean = false
    var connectionLost: Boolean = false
    var authExpired: Boolean = false
    var lastTurnError: Boolean = false

    /**
     * Set the committed feed, clearing the live STT [transcript] when a speech
     * user entry whose content matches the current preview has committed.
     *
     * Mirrors web-sdk use-voice-client.ts: once the finalized speech entry lands
     * in history, the live preview is stale (the utterance is now committed) and
     * must not linger as a duplicate bubble. Channel-scoped to "speech" so a
     * text.input commit never clears a voice preview.
     *
     * Each committed Assistant entry already carries its gateway turnId (the
     * history connector re-attaches the frame turnId), so the live-bubble
     * suppression reads it straight off the item — no stamping.
     */
    fun applyFeed(items: List<ConversationFeedItem>) {
        feed = items
        if (transcript.isEmpty()) return
        val lastSpeechUser = items.asReversed().firstOrNull {
            it is ConversationFeedItem.User && it.channel == SPEECH_CHANNEL
        } as ConversationFeedItem.User?
        if (lastSpeechUser != null && lastSpeechUser.content == transcript) transcript = ""
    }

    /** Project the connection-axis slice (status, session, voice, audio). */
    fun deriveConnection(): ConnectionState = ConnectionState(
        status = status,
        hasSession = hasSession,
        connectionLost = connectionLost,
        authExpired = authExpired,
        prefs = prefs,
        voiceMode = voiceMode,
        isSpeaking = isSpeaking,
        audioState = audioState,
        cognition = cognition,
    )

    /**
     * Project committed-only messages (no live in-flight bubble).
     * Used by the timeline StateFlow — consumers that want a stable list of
     * committed entries without the streaming noise.
     */
    fun deriveTimeline(): List<ChatMessage> =
        deriveMessages(feed, inflight = null, clock.nowMs())
}

/**
 * Fold committed feed items + the live in-flight buffer into the chat list.
 * User + Assistant entries render as rows; Trigger entries are context for the
 * model, not a user-facing artifact. Empty user / empty-non-cutoff assistant
 * entries are dropped (barge-in markers, pre-token placeholders).
 *
 * TOOL ACTIVITY IS NOT IN THIS LIST. It lives in the composer task strip,
 * driven by `tasklist.state` (TaskListConnector). It used to render as pills
 * anchored to the assistant bubble that followed them, which forced this walk
 * to answer "which bubble owns this tile" — a question with no stable answer
 * once a mid-turn steer splits a reply, and the source of a live/committed
 * disagreement that made a finished reply visibly regroup.
 */
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    for (item in feed) {
        out.add(committedMessage(item) ?: continue)
    }
    if (inflight != null) {
        out.add(
            ChatMessage(
                ts = nowMs,
                role = ROLE_ASSISTANT,
                content = inflight.text,
                streaming = true,
                turnId = inflight.turnId,
                replyId = inflight.replyId,
            ),
        )
    }
    return out
}

private fun committedMessage(item: ConversationFeedItem): ChatMessage? = when (item) {
    is ConversationFeedItem.User ->
        if (item.content.isEmpty()) null
        else ChatMessage(
            ts = item.ts,
            role = ROLE_USER,
            content = item.content,
            pendingId = item.pendingId,
            entryId = item.entryId,
        )

    is ConversationFeedItem.Assistant ->
        if (item.content.isEmpty() && item.cutoff == null) null
        else ChatMessage(
            ts = item.ts,
            role = ROLE_ASSISTANT,
            content = item.content,
            cutoffKind = item.cutoff?.kind,
            // turnId is the gateway-owned join key carried on the entry (re-attached
            // from the conversation.entry frame by the history connector). Read it
            // directly — no client-side text-match/ts-window derivation.
            turnId = item.turnId,
            // Same key, same source: several committed rows of one ReAct turn
            // share it and belong to one bubble.
            replyId = item.replyId,
            entryId = item.entryId,
        )

    // Trigger entries are Phase-2 sensor events. (There is no tool item on the
    // feed at all: tool activity lives in the composer task strip,
    // tasklist.state, not the chat list.)
    is ConversationFeedItem.Trigger -> null

    // A kind this build does not know — a retired one from an older gateway, a
    // newer one from a gateway ahead of us. Rendering nothing is the whole
    // point: the alternative is the decode throwing and the frame it arrived in
    // being dropped entirely.
    is ConversationFeedItem.Unknown -> null
}

private const val SPEECH_CHANNEL = "speech"
private const val ROLE_USER = "user"
private const val ROLE_ASSISTANT = "assistant"
