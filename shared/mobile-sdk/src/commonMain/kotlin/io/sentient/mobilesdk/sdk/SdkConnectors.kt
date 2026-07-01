// ---------------------------------------------------------------------------
// SdkConnectors — builds + holds the connector set wired to one StateDeriver.
//
// Extracted from SentientSdk.kt to keep the orchestrator under the 300-line
// clean-code budget. Each connector callback updates a StateDeriver slice and
// triggers a re-emit via the injected [emit] lambda (connection/timeline fan-in).
// Connectors are constructed ONCE (their mirrors survive across
// reconnects); the router broadcasts every frame to all of them.
//
// The audio connector is double-wired by the orchestrator: it appears in
// [all] (control frames) AND is handed to MessageRouter as the audioConnector
// (binary frames). UserAudioInput's binary uplink is wired to the transport's
// sendBinary by the orchestrator.
//
// History-on-switch: on session.switched the ConversationHistoryConnector
// increments its generation and fires onHistoryNeeded(sessionId, generation)
// SYNCHRONOUSLY before returning from handle(). SdkConnectors wires this
// callback to launch the REST getMessages fetch with the post-bump generation.
// This makes the history load always use the generation the connector just set
// — no cross-handler ordering dependency. A stale-switch guard ensures a fast
// second switch wins: the old fetch's generation no longer matches and its
// result is discarded.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.AssistantAudioResponseConnector
import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.CognitionStatusConnector
import io.sentient.mobilesdk.connectors.Connector
import io.sentient.mobilesdk.connectors.ConversationHistoryConnector
import io.sentient.mobilesdk.connectors.CycleErrorConnector
import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.connectors.PreferencesConnector
import io.sentient.mobilesdk.connectors.SessionsConnector
import io.sentient.mobilesdk.connectors.TaskStatusConnector
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.connectors.UserTextInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Audio downlink hooks the orchestrator routes to the AudioPipeline (E3). The
 * AssistantAudioResponseConnector's wire FSM (receiving / cancel latch) stays
 * here; these callbacks add the pipeline side effects (playback enqueue/clear +
 * echoGate lifecycle + FSM). Defaults are no-ops so the text-only path (no
 * pipeline) compiles unchanged.
 *
 * @param onAudioStart connector.audio.start → pipeline.onAudioStart.
 * @param onAudioFrame binary downlink → pipeline.onAudioFrame.
 * @param onAudioDone connector.audio.done → pipeline.onAudioDone.
 * @param onPlaybackStop playback.stop → pipeline.onPlaybackStop.
 */
class AudioDownlinkHooks(
    val onAudioStart: (cycleId: String, encoding: String?, sampleRate: Int?) -> Unit = { _, _, _ -> },
    val onAudioFrame: (frame: ByteArray, cycleId: String) -> Unit = { _, _ -> },
    val onAudioDone: (cycleId: String) -> Unit = {},
    val onPlaybackStop: (reason: String, cycleId: String) -> Unit = { _, _ -> },
)

/**
 * Constructs and owns the connector set, each wired to fold into [deriver].
 *
 * @param deriver The single state slice-holder; callbacks mutate it then [emit].
 * @param emit Recompute + publish connection/timeline. Called after every slice change.
 * @param send Send a control [ClientMessage] over the transport.
 * @param sendBinary Send a raw binary frame (PCM uplink) over the transport.
 * @param newId Deterministic request-id generator for sessions requests.
 * @param sessionsTimeoutMs Sessions lifecycle request/broadcast timeout.
 * @param clock Injected wall-clock for the SessionsConnector mint debounce (A2).
 * @param mintDebounceMs Window (ms) collapsing rapid new-chat taps into one mint.
 * @param sessionsHttpClient REST client for session queries. Injected by the SDK
 *   factory; null in text-only / test paths where REST is not exercised.
 * @param scope SDK coroutine scope; used to launch REST history fetches on switch.
 * @param audioHooks Downlink side-effect hooks wired to the AudioPipeline (E3).
 */
class SdkConnectors(
    private val deriver: StateDeriver,
    private val emit: () -> Unit,
    private val emitEvent: (SdkEvent) -> Unit,
    private val send: (ClientMessage) -> Unit,
    sendBinary: (ByteArray) -> Unit,
    newId: () -> String,
    sessionsTimeoutMs: Long,
    clock: Clock,
    mintDebounceMs: Long,
    private val sessionsHttpClient: SessionsHttpClient? = null,
    private val scope: CoroutineScope? = null,
    private val audioHooks: () -> AudioDownlinkHooks = { AudioDownlinkHooks() },
    private val onCognitionChanged: (CognitionState) -> Unit = { state -> deriver.cognition = state; emit() },
) {
    private val log = createLogger("sdk", "connectors")

    val text = UserTextInputConnector(send = send)

    val history = ConversationHistoryConnector(
        onUpdate = { items -> deriver.applyFeed(items); emit() },
        onEvent = emitEvent,
        // onHistoryNeeded fires AFTER the connector increments its generation,
        // so the [generation] token here is the post-bump value that
        // replaceMirror will validate against — no ordering dependency on when
        // onSessionAnchored runs relative to router.route.
        onHistoryNeeded = { sessionId, generation ->
            loadHistoryForSession(sessionId, generation)
        },
    )

    val inflight = InFlightMessageConnector(
        onUpdate = { msg -> deriver.inflight = msg; emit() },
        onEvent = emitEvent,
    )

    val cognition = CognitionStatusConnector(
        onStateChange = { state -> onCognitionChanged(state) },
        onEvent = emitEvent,
    )

    val cycleError = CycleErrorConnector(
        onErrorChange = { hasError -> deriver.lastCycleError = hasError; emit() },
        onEvent = emitEvent,
    )

    val preferences = PreferencesConnector(
        send = send,
        // Fold a server-driven prefs change into the deriver + re-emit for the UI toggle
        // state. The downlink engine is LAZY-ARMED on connector.audio.start (mirrors
        // web-sdk), not from the preference flag — the gateway only sends audio.* when TTS
        // is on, so arming follows the actual audio, no preference→configure coupling.
        onChange = { prefs ->
            deriver.prefs = prefs
            emit()
        },
    )

    val tasks = TaskStatusConnector(
        onList = { list -> deriver.tasks = list; emit() },
        onEvent = emitEvent,
    )

    val sessions = SessionsConnector(
        send = send,
        newId = newId,
        timeoutMs = sessionsTimeoutMs,
        clock = clock,
        mintDebounceMs = mintDebounceMs,
        httpClient = sessionsHttpClient,
    )

    val audioInput = UserAudioInputConnector(
        send = send,
        sendBinary = sendBinary,
        onTranscript = { text -> deriver.transcript = text; emit(); emitEvent(SdkEvent.TranscriptUpdated(text)) },
    )

    val audioOutput = AssistantAudioResponseConnector(
        onAudioStart = { cycleId, encoding, sampleRate -> audioHooks().onAudioStart(cycleId, encoding, sampleRate) },
        onAudioFrame = { frame, cycleId -> audioHooks().onAudioFrame(frame, cycleId) },
        onAudioDone = { cycleId -> audioHooks().onAudioDone(cycleId) },
        onPlaybackStop = { reason, cycleId -> audioHooks().onPlaybackStop(reason, cycleId) },
    )

    /** All connectors, broadcast targets for the MessageRouter. */
    val all: List<Connector> = listOf(
        text, history, inflight, cognition, cycleError, preferences, tasks, sessions, audioInput, audioOutput,
    )

    /** Capability strings every connector advertises (merged into session.configure). */
    val capabilities: List<String> = all.map { it.capability }.distinct()

    // ── History-on-switch ─────────────────────────────────────────────────────

    /**
     * Launch a REST fetch of the conversation history for [sessionId] and
     * replace the mirror once it arrives. The [forGeneration] token prevents
     * a stale response from an earlier switch overwriting a newer one.
     *
     * Called from the [ConversationHistoryConnector.onHistoryNeeded] callback,
     * which fires synchronously inside [ConversationHistoryConnector.handle]
     * AFTER the connector has already incremented its generation counter.
     * [forGeneration] therefore equals [history.currentGeneration()] at call
     * time — no external ordering dependency.
     */
    /**
     * Refetch history for [sessionId] outside the session.switched path (Task 3.10
     * — stream.resumed{recovered:false}). Bumps the history connector's generation
     * (arming its straggler gate) and reuses the same REST [loadHistoryForSession]
     * path as a normal switch.
     */
    fun refetchHistoryForSession(sessionId: String) {
        val generation = history.bumpForRefetch()
        loadHistoryForSession(sessionId, generation)
    }

    fun loadHistoryForSession(sessionId: String, forGeneration: Int) {
        val client = sessionsHttpClient ?: run {
            log.debug("loadHistory.no-client", mapOf("sessionId" to sessionId))
            history.replaceMirror(emptyList(), forGeneration)
            return
        }
        val s = scope ?: run {
            log.warn("loadHistory.no-scope", mapOf("sessionId" to sessionId))
            history.replaceMirror(emptyList(), forGeneration)
            return
        }
        log.info("loadHistory.start", mapOf("sessionId" to sessionId, "generation" to forGeneration))
        s.launch {
            val items = runCatching { client.getMessages(sessionId) }.getOrElse { e ->
                log.warn("loadHistory.error", mapOf("sessionId" to sessionId, "cause" to (e.message ?: "unknown")))
                emptyList()
            }
            log.info("loadHistory.done", mapOf("sessionId" to sessionId, "count" to items.size, "generation" to forGeneration))
            history.replaceMirror(items, forGeneration)
        }
    }
}
