// ---------------------------------------------------------------------------
// SdkState — legacy aggregate (kept for app dead-code that still compiles
// against it). Both native UIs now consume the split surfaces:
//   connection: StateFlow<ConnectionState>  — transport + voice axis
//   timeline:   StateFlow<List<ChatMessage>> — committed message history
//
// SdkState is no longer emitted by SentientSdk. StateDeriver.derive() has been
// removed. This file is kept because ChatScreen.kt (Android dead-code) and
// VoiceStatus.swift (iOS dead-code) still import the type.
//
// CognitionState (C4) and TaskSnapshotItem (C5) are imported, never redefined.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.transport.SdkStatus

/** Voice-mode latch. OFF = text path; ACTIVE = mic streaming (full pipeline E3). */
enum class VoiceMode { OFF, ACTIVE }

/**
 * One rendered chat message. Folds a committed [ConversationFeedItem] OR the
 * live in-flight streaming buffer into a flat, SKIE-friendly shape.
 *
 * @param ts Wall-clock ms of the entry (feed item ts, or now for the streaming bubble). May be 0 for a clear-signal event payload (e.g. MessageCommitted), whose authoritative timestamp arrives via the conversation feed — consumers rendering a date from a raw event must guard ts <= 0.
 * @param role "user" | "assistant" | "tool" | "trigger".
 * @param content Rendered text.
 * @param streaming True for the live in-flight bubble (pre-commit). False once committed.
 * @param cutoffKind "interrupt" | "barge-in" when an assistant reply was cut short.
 * @param cycleId Cycle that produced this assistant message (UI join key for tools). Null when unknown.
 * @param pendingId Correlates an optimistic client send to its committed feed entry. Set on user
 *   messages derived from a [ConversationFeedItem.User] that carries a pendingId (echoed back by
 *   the gateway). ChatRepository uses this to reconcile the optimistic bubble by id. Null when the
 *   entry has no associated optimistic send (assistant, tool, trigger entries, or legacy user entries
 *   that predate the pendingId echo).
 * @param tools Tasks grouped onto this message by shared cycleId (mirrors web-sdk ChatMessage.tools).
 */
data class ChatMessage(
    val ts: Long,
    val role: String,
    val content: String,
    val streaming: Boolean = false,
    val cutoffKind: String? = null,
    val cycleId: String? = null,
    val pendingId: String? = null,
    val tools: List<TaskSnapshotItem> = emptyList(),
)

/**
 * The single observable SDK state. Immutable; every connector callback
 * recomputes a fresh copy via [StateDeriver] and emits it on the StateFlow.
 *
 * @param status Connection FSM state (transport/SdkStatus).
 * @param messages Committed history + the live streaming bubble (deriveMessages mirror).
 * @param transcript Latest live STT preview (connector.transcript.final). Cleared once the
 *   matching finalized speech user entry commits to history (StateDeriver.applyFeed), mirroring
 *   web-sdk use-voice-client.ts — the in-progress utterance is now committed so the preview is stale.
 * @param cognition Cycle-driven cognition state (THINKING/IDLE; ACTING unreached, per C4).
 * @param voiceMode OFF (text) / ACTIVE (mic). Flipped by startMic/stopMic.
 * @param prefs Current audio preferences (TTS on/off, channel).
 * @param tasks Live task list (TaskStatusConnector.list(), startedAtMs ascending).
 * @param isSpeaking True between assistant audio start and done/playback-stop.
 * @param audioState The voice-pipeline FSM state (E3) — the richer voice-status
 *   surface both native UIs can render directly (listening / user-speaking /
 *   processing / assistant-speaking / interrupting / inactive). Driven by the
 *   AudioPipeline's AudioFsm; mirrors voice-status.ts's listening/processing/
 *   speaking plus the local user-speaking/interrupting transients.
 * @param hasSession True once the user has reached an authenticated session and
 *   has not logged out. Gates login↔chat navigation on both native UIs (the
 *   web-sdk parity: AUTH gates the screen, transport status drives an in-chat
 *   banner). Set true on the first transition to READY; PRESERVED across idle-
 *   disconnect, transport drops, and reconnect attempts (the user stays "in
 *   session" and auto-reconnects on presence); cleared only on explicit LOGOUT
 *   (consumer disconnect) or terminal authExpired.
 * @param connectionLost True while the reconnect loop is recovering an unexpected drop.
 * @param authExpired True on terminal auth failure (token won't recover via retry).
 * @param lastCycleError True after an UNSOLICITED cycle.aborted — a wire-death /
 *   server error mid-cycle that yields no answer. NOT set by a client-initiated
 *   abort (UI Stop / barge-in). Recoverable: cleared on the next cycle.started,
 *   a successful cycle, newChat, or switchSession. Driven by CycleErrorConnector.
 */
data class SdkState(
    val status: SdkStatus = SdkStatus.DISCONNECTED,
    val messages: List<ChatMessage> = emptyList(),
    val transcript: String = "",
    val cognition: CognitionState = CognitionState.IDLE,
    val voiceMode: VoiceMode = VoiceMode.OFF,
    val prefs: AudioPreferences = AudioPreferences.DEFAULT,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val isSpeaking: Boolean = false,
    val audioState: AudioState = AudioState.INACTIVE,
    val hasSession: Boolean = false,
    val connectionLost: Boolean = false,
    val authExpired: Boolean = false,
    val lastCycleError: Boolean = false,
)
