// ---------------------------------------------------------------------------
// SdkConnectors — builds + holds the connector set wired to one StateDeriver.
//
// Extracted from SentientSdk.kt to keep the orchestrator under the 300-line
// clean-code budget. Each connector callback updates a StateDeriver slice and
// triggers a re-emit via the injected [emit] lambda — the single-StateFlow
// fan-in (R5). Connectors are constructed ONCE (their mirrors survive across
// reconnects); the router broadcasts every frame to all of them.
//
// The audio connector is double-wired by the orchestrator: it appears in
// [all] (control frames) AND is handed to MessageRouter as the audioConnector
// (binary frames). UserAudioInput's binary uplink is wired to the transport's
// sendBinary by the orchestrator.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.AssistantAudioResponseConnector
import io.sentient.mobilesdk.connectors.CognitionStatusConnector
import io.sentient.mobilesdk.connectors.Connector
import io.sentient.mobilesdk.connectors.ConversationHistoryConnector
import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.connectors.PreferencesConnector
import io.sentient.mobilesdk.connectors.SessionsConnector
import io.sentient.mobilesdk.connectors.TaskStatusConnector
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.connectors.UserTextInputConnector
import io.sentient.mobilesdk.protocol.ClientMessage

/**
 * Constructs and owns the connector set, each wired to fold into [deriver].
 *
 * @param deriver The single state slice-holder; callbacks mutate it then [emit].
 * @param emit Recompute + publish the SdkState. Called after every slice change.
 * @param send Send a control [ClientMessage] over the transport.
 * @param sendBinary Send a raw binary frame (PCM uplink) over the transport.
 * @param newId Deterministic request-id generator for sessions requests.
 * @param sessionsTimeoutMs Sessions request/broadcast timeout (injected for tests).
 */
class SdkConnectors(
    private val deriver: StateDeriver,
    private val emit: () -> Unit,
    private val send: (ClientMessage) -> Unit,
    sendBinary: (ByteArray) -> Unit,
    newId: () -> String,
    sessionsTimeoutMs: Long,
) {
    val text = UserTextInputConnector(send = send)

    val history = ConversationHistoryConnector(
        onUpdate = { items -> deriver.applyFeed(items); emit() },
    )

    val inflight = InFlightMessageConnector(
        onUpdate = { msg -> deriver.inflight = msg; emit() },
    )

    val cognition = CognitionStatusConnector(
        onStateChange = { state -> deriver.cognition = state; emit() },
    )

    val preferences = PreferencesConnector(
        send = send,
        onChange = { prefs -> deriver.prefs = prefs; emit() },
    )

    val tasks = TaskStatusConnector(
        onList = { list -> deriver.tasks = list; emit() },
    )

    val sessions = SessionsConnector(
        send = send,
        newId = newId,
        timeoutMs = sessionsTimeoutMs,
    )

    val audioInput = UserAudioInputConnector(
        send = send,
        sendBinary = sendBinary,
        onTranscript = { text -> deriver.transcript = text; emit() },
    )

    val audioOutput = AssistantAudioResponseConnector(
        onAudioStart = { _ -> deriver.isSpeaking = true; emit() },
        onAudioDone = { _ -> deriver.isSpeaking = false; emit() },
        onPlaybackStop = { _, _ -> deriver.isSpeaking = false; emit() },
    )

    /** All connectors, broadcast targets for the MessageRouter. */
    val all: List<Connector> = listOf(
        text, history, inflight, cognition, preferences, tasks, sessions, audioInput, audioOutput,
    )

    /** Capability strings every connector advertises (merged into session.configure). */
    val capabilities: List<String> = all.map { it.capability }.distinct()
}
