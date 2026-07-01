// ---------------------------------------------------------------------------
// SdkResumeReconciliationTest — orchestrator-level contract for the A1-vs-resume
// reconciliation (Task 3.10-mobile, Slice 3). THIS IS THE GAP THAT WAS UNTESTED.
//
// KEEPER (per .claude/rules/testing.md): pins the FSM invariant that a reconnect
// PRESERVES in-flight cognition on a recovered:true resume and RECOVERS to idle
// (clear + REST-refetch + re-establish) on recovered:false or a no-cursor
// reconnect. The bug it guards (confirmed by review):
//   - onReadyReached() called clearActiveToIdle() UNCONDITIONALLY on every
//     reconnect-to-READY, BEFORE stream.resumed arrived. On a recovered:true
//     resume the gateway replays the in-flight cycle's frames to restore
//     THINKING/speaking — but the client had ALREADY cleared cognition→IDLE,
//     losing the state the resume exists to preserve (an IDLE flash + a possible
//     stuck-state watchdog fire).
//
// Drives the REAL orchestrator over a FakeWebSocketEngine + a MockEngine-backed
// SessionsHttpClient under runTest virtual time. The resume cursor is advanced
// by SEQ-STAMPED frames (so a reconnect attempts stream.resume); cognition is
// driven THINKING via cycle.started before the drop.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.fakes.InMemoryDeviceIdStore
import io.sentient.mobilesdk.fakes.InMemoryTokenStore
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SdkResumeReconciliationTest {

    private val anchoredUuid = "8f3c1d2e-aaaa-bbbb-cccc-000000000099"

    // ── Frame builders ────────────────────────────────────────────────────────

    private fun createdFrame(uuid: String) =
        "{\"type\":\"session.created\",\"sessionId\":\"$uuid\",\"ts\":1}"

    /** cycle.started carrying a resume [seq] stamp (peeled by WsTransport → advances
     *  the cursor's lastSeq so a reconnect will attempt stream.resume). */
    private fun cycleStartedSeq(seq: Long, cycleId: String = "c1") =
        "{\"type\":\"cycle.started\",\"cycleId\":\"$cycleId\",\"seq\":$seq,\"epoch\":1}"

    /** cycle.started with NO seq stamp — drives cognition without advancing the cursor. */
    private fun cycleStartedNoSeq(cycleId: String = "c1") =
        "{\"type\":\"cycle.started\",\"cycleId\":\"$cycleId\"}"

    private fun streamResumedFrame(recovered: Boolean) =
        "{\"type\":\"stream.resumed\",\"recovered\":$recovered,\"epoch\":1}"

    private fun activateFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"conversation.activate\"") }

    // Resume now rides INSIDE session.configure (no separate stream.resume frame):
    // a "resumed" reconnect is a configure frame that carries a `resume` object.
    private fun resumeFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"session.configure\"") && it.contains("\"resume\":") }

    // ── recovered:true → PRESERVE in-flight state ─────────────────────────────

    @Test
    fun recovered_true_preserves_in_flight_cognition_and_does_not_clear() = runTest {
        val fake = FakeWebSocketEngine()
        var getMessagesCalls = 0
        val http = countingHttpClient { getMessagesCalls++ }
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)
        connectToReady(sdk, fake)

        // Anchor the ACP session + drive cognition THINKING with a SEQ-stamped
        // cycle.started (advances the resume cursor so a reconnect resumes).
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        fake.emit(WsIncoming.Text(cycleStartedSeq(seq = 5)))
        sdk.connection.first { it.cognition == CognitionState.THINKING }

        // Drop → reconnect → READY. The DEFER path: resume is carried in
        // session.configure; onReadyReached must NOT clear cognition or re-activate.
        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()

        // Resume cursor had a seq → configure MUST carry a resume object on the reconnect.
        assertTrue(resumeFrames(fake.sentText).isNotEmpty(), "reconnect with a cursor must carry resume in configure, sent=${fake.sentText}")
        // DEFERRED: no clear, no re-activate yet — in-flight THINKING preserved.
        assertEquals(CognitionState.THINKING, sdk.connection.value.cognition, "cognition must stay THINKING before stream.resumed")
        assertTrue(activateFrames(fake.sentText).isEmpty(), "deferred path must NOT re-activate before the ack, sent=${fake.sentText}")

        // The gateway replays the in-flight cycle and acks recovered:true.
        fake.emit(WsIncoming.Text(streamResumedFrame(recovered = true)))
        runCurrent()

        // PRESERVED: cognition untouched, no clear-to-idle, no REST refetch, no activate.
        assertEquals(CognitionState.THINKING, sdk.connection.value.cognition, "recovered:true must preserve in-flight cognition")
        assertEquals(0, getMessagesCalls, "recovered:true must NOT refetch history")
        assertTrue(activateFrames(fake.sentText).isEmpty(), "recovered:true must NOT re-activate, sent=${fake.sentText}")
    }

    // ── recovered:false → RECOVER to idle (clear + refetch + re-establish) ─────

    @Test
    fun recovered_false_clears_to_idle_and_refetches_history() = runTest {
        val fake = FakeWebSocketEngine()
        var getMessagesCalls = 0
        val http = countingHttpClient { getMessagesCalls++ }
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)
        connectToReady(sdk, fake)

        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        fake.emit(WsIncoming.Text(cycleStartedSeq(seq = 7)))
        sdk.connection.first { it.cognition == CognitionState.THINKING }

        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()

        // Still deferred at READY — cognition preserved until the ack decides.
        assertEquals(CognitionState.THINKING, sdk.connection.value.cognition, "cognition preserved until stream.resumed")
        val getMessagesBefore = getMessagesCalls

        // The gateway could NOT resume → recovered:false: the A1-equivalent recovery.
        fake.emit(WsIncoming.Text(streamResumedFrame(recovered = false)))
        sdk.connection.first { it.cognition == CognitionState.IDLE }
        // The history refetch is launched on the scope and round-trips the MockEngine,
        // then replaces the mirror — await the timeline to populate (end-to-end proof
        // the REST refetch fired) rather than draining virtual time.
        sdk.timeline.first { it.isNotEmpty() }

        assertEquals(CognitionState.IDLE, sdk.connection.value.cognition, "recovered:false must clear cognition to IDLE")
        assertTrue(getMessagesCalls > getMessagesBefore, "recovered:false must REST-refetch history (getMessages called)")
        assertTrue(activateFrames(fake.sentText).isNotEmpty(), "recovered:false must re-establish via conversation.activate, sent=${fake.sentText}")
    }

    // ── no-cursor reconnect (lastSeq==0) → legacy A1 (clear + activate, no resume) ─

    @Test
    fun no_cursor_reconnect_runs_legacy_a1_clear_and_activate() = runTest {
        val fake = FakeWebSocketEngine()
        var getMessagesCalls = 0
        val http = countingHttpClient { getMessagesCalls++ }
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)
        connectToReady(sdk, fake)

        // Anchor + drive cognition THINKING with an UNSTAMPED cycle.started: the
        // resume cursor stays at lastSeq==0 → a reconnect cannot attempt resume.
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        fake.emit(WsIncoming.Text(cycleStartedNoSeq()))
        sdk.connection.first { it.cognition == CognitionState.THINKING }

        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        // The A1 clear runs synchronously inside onReadyReached on the READY edge.
        sdk.connection.first { it.cognition == CognitionState.IDLE }
        runCurrent()

        // Legacy A1: cleared to idle + re-activated, and configure carried NO resume.
        assertEquals(CognitionState.IDLE, sdk.connection.value.cognition, "no-cursor reconnect clears to IDLE (legacy A1)")
        assertTrue(resumeFrames(fake.sentText).isEmpty(), "no-cursor reconnect must NOT carry resume in configure, sent=${fake.sentText}")
        assertEquals(1, activateFrames(fake.sentText).size, "no-cursor reconnect must re-activate exactly once, sent=${fake.sentText}")
    }

    // ── configure carries conversationId on reconnect ────────────────────────

    @Test
    fun `configure carries current conversationId on reconnect`() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdkWithHistory(backgroundScope, fake, countingHttpClient {})
        connectToReady(sdk, fake)

        // Anchor a conversation so _currentSessionId = "conv-A".
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }

        // Drop → reconnect → the handshake fires a fresh session.configure.
        fake.failIncoming("network drop")
        // Wait for the reconnect to open a new socket.
        sdk.connection.first { fake.openedUrls.size >= 2 }
        // Drive the reconnect handshake to READY.
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }

        // The reconnect session's configure frame MUST carry conversationId = anchoredUuid.
        val configureFrames = fake.sentText.filter { it.contains("\"type\":\"session.configure\"") }
        assertTrue(configureFrames.isNotEmpty(), "reconnect must send session.configure, sent=${fake.sentText}")
        // .last() because the initial connect also sends session.configure (no conversationId yet — nothing anchored); the reconnect's configure is the last one and carries the anchored id.
        val configureJson = configureFrames.last()
        assertTrue(
            configureJson.contains("\"conversationId\":\"$anchoredUuid\""),
            "session.configure must carry conversationId=\"$anchoredUuid\", got: $configureJson",
        )
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /** SessionsHttpClient whose getMessages records each call via [onGetMessages] and
     *  returns a one-item messages payload (so a refetch visibly populates the
     *  timeline — the end-to-end signal the recovered:false path actually fetched). */
    private fun countingHttpClient(onGetMessages: () -> Unit): SessionsHttpClient {
        val engine = MockEngine { _ ->
            onGetMessages()
            respond(
                "{\"items\":[{\"kind\":\"user\",\"ts\":1,\"channel\":\"text\",\"content\":\"refetched\"}]," +
                    "\"total\":1,\"hasMore\":false}",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        return SessionsHttpClient(
            httpClient = HttpClient(engine) {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            },
            gatewayWsUrl = "wss://test/api/v1/ws",
            token = { "tok-abc" },
        )
    }

    private fun buildSdkWithHistory(
        scope: CoroutineScope,
        fake: FakeWebSocketEngine,
        sessionsHttpClient: SessionsHttpClient,
    ): SentientSdk {
        var n = 0
        val bundle = PlatformBundle(
            engine = fake,
            tokenStore = InMemoryTokenStore().apply { save("tok-abc") },
            deviceIdStore = InMemoryDeviceIdStore("dev-test"),
            clock = FixedClock(0L),
            playback = null,
        )
        return SentientSdk(
            config = SdkConfig(
                gatewayWsUrl = "wss://test/api/v1/ws",
                allowSelfSignedDevHost = false,
                capabilities = listOf("text.input", "conversation.history"),
            ),
            bundle = bundle,
            scope = scope,
            newId = { "req-${n++}" },
            sessionsHttpClient = sessionsHttpClient,
        )
    }
}
