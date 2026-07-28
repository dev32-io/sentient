// ---------------------------------------------------------------------------
// StateDeriver — folds the connector slices into the split observable surfaces:
//   deriveConnection() → ConnectionState (transport + voice axis)
//   deriveTimeline()   → List<ChatMessage> (committed history, no streaming bubble)
//
// The orchestrator holds ONE StateDeriver. Each connector callback updates a
// slice here, then calls deriveConnection()/deriveTimeline() and emits on the
// respective StateFlow. Native UIs read ConnectionState or the timeline directly.
//
// messages: mirrors web-sdk deriveMessages — only committed user/assistant
// feed items fold to ChatMessage (tool + trigger entries are DROPPED, matching
// cycle-helpers.ts appendCommittedItems: tool calls surface via tasks, trigger
// is Phase-2-ignored). cutoffKind comes off the assistant entry's cutoff.
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
    var tasks: List<TaskSnapshotItem> = emptyList()
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
     * suppression + tool attachment read it straight off the item — no stamping.
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
        deriveMessages(feed, inflight = null, clock.nowMs(), tasks)
}

/**
 * Fold committed feed items + the live in-flight buffer into the chat list.
 * Mirrors web-sdk deriveMessages (cycle-helpers.ts appendCommittedItems):
 * only User + Assistant entries render — Tool entries are dropped (surfaced via
 * tasks / TaskStatusConnector) and Trigger entries are Phase-2-ignored. Empty
 * user / empty-non-cutoff assistant entries are dropped too (barge-in markers /
 * pre-token placeholders that don't render). Committed entries first, the
 * streaming bubble last.
 *
 * @param tasks Current tool-row list used to attach tools to messages by turnId.
 */
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
    tasks: List<TaskSnapshotItem> = emptyList(),
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    for (item in feed) {
        committedMessage(item, tasks)?.let(out::add)
    }
    if (inflight != null) {
        out.add(
            ChatMessage(
                ts = nowMs,
                role = ROLE_ASSISTANT,
                content = inflight.text,
                streaming = true,
                turnId = inflight.turnId,
                tools = toolsFor(inflight.turnId, tasks),
            ),
        )
    }
    return out
}

private fun committedMessage(
    item: ConversationFeedItem,
    tasks: List<TaskSnapshotItem>,
): ChatMessage? = when (item) {
    is ConversationFeedItem.User ->
        if (item.content.isEmpty()) null
        else ChatMessage(
            ts = item.ts,
            role = ROLE_USER,
            content = item.content,
            pendingId = item.pendingId,
            entryId = item.entryId,
        )

    is ConversationFeedItem.Assistant -> {
        if (item.content.isEmpty() && item.cutoff == null) null
        else {
            // turnId is the gateway-owned join key carried on the entry (re-attached
            // from the conversation.entry frame by the history connector). Read it
            // directly — no client-side text-match/ts-window derivation.
            val turnId = item.turnId
            ChatMessage(
                ts = item.ts,
                role = ROLE_ASSISTANT,
                content = item.content,
                cutoffKind = item.cutoff?.kind,
                turnId = turnId,
                tools = toolsFor(turnId, tasks),
                entryId = item.entryId,
            )
        }
    }

    // Tool entries surface via tasks (TaskStatusConnector); trigger entries are
    // Phase-2 sensor events. Both are DROPPED here to match cycle-helpers.ts and
    // avoid double-surfacing tool calls in messages AND tasks.
    is ConversationFeedItem.Tool -> null
    is ConversationFeedItem.Trigger -> null
}

/** Filter [tasks] to only those belonging to [turnId]. Returns empty list when turnId is null. */
private fun toolsFor(turnId: String?, tasks: List<TaskSnapshotItem>): List<TaskSnapshotItem> =
    if (turnId == null) emptyList() else tasks.filter { it.turnId == turnId }

private const val SPEECH_CHANNEL = "speech"
private const val ROLE_USER = "user"
private const val ROLE_ASSISTANT = "assistant"
