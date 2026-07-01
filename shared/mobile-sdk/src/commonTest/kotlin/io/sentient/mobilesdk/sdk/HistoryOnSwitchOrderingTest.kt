// ---------------------------------------------------------------------------
// HistoryOnSwitchOrderingTest — integration test for the session.switched
// ordering bug (Task 2.6 fix).
//
// KEEPER (per .claude/rules/testing.md): pins the ordering invariant that
// the generation captured for the history fetch MUST be the post-bump value
// set by ConversationHistoryConnector. The bug this guards:
//   - BEFORE fix: onSessionAnchored read currentGeneration() = N BEFORE
//     router.route() bumped it to N+1; replaceMirror(items, N) hit the
//     stale guard (N != N+1); awaitingHistory stayed true; ALL subsequent
//     conversation.entry frames were dropped; the timeline was permanently
//     empty after every session switch.
//   - AFTER fix (connector-driven): ConversationHistoryConnector.onHistoryNeeded
//     fires INSIDE handle() AFTER generation++ so the generation token it
//     carries is N+1 at all times — no cross-handler ordering dependency.
//
// Drives the REAL orchestrator path (SentientSdk → SdkLifecycle.onFrame →
// router.route → ConversationHistoryConnector, onSessionAnchored) with a
// real SessionsHttpClient backed by ktor-client-mock MockEngine. The test
// WILL FAIL on the pre-fix code and PASS after the fix.
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
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.fakes.InMemoryDeviceIdStore
import io.sentient.mobilesdk.fakes.InMemoryTokenStore
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

// ── Helpers ─────────────────────────────────────────────────────────────────

/** session.switched broadcast for [sessionId]. */
private fun switchedFrame(sessionId: String) =
    "{\"type\":\"session.switched\",\"sessionId\":\"$sessionId\",\"ts\":1}"

/** conversation.entry carrying a live user message. */
private fun entryFrame(content: String, ts: Long = 100) =
    "{\"type\":\"conversation.entry\",\"item\":{\"kind\":\"user\",\"ts\":$ts," +
        "\"channel\":\"text\",\"content\":\"$content\"}}"

/** REST /messages payload with two user items for [sessionId]. */
private fun messagesPayload(a: String, b: String) =
    "{\"items\":[" +
        "{\"kind\":\"user\",\"ts\":1,\"channel\":\"text\",\"content\":\"$a\"}," +
        "{\"kind\":\"user\",\"ts\":2,\"channel\":\"text\",\"content\":\"$b\"}" +
        "],\"total\":2,\"hasMore\":false}"

/**
 * Build a [SessionsHttpClient] backed by a [MockEngine] that returns [body]
 * for every GET /messages request. The SDK is wired to the same fake WS URL
 * so the URL derivation matches.
 */
private fun mockHttpClient(body: String): SessionsHttpClient {
    val engine = MockEngine { _ ->
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
    }
    return SessionsHttpClient(
        httpClient = HttpClient(engine) {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        },
        gatewayWsUrl = "wss://test/api/v1/ws",
        token = { "tok-abc" },
    )
}

/**
 * Build a SentientSdk wired to [fake] + [sessionsHttpClient].
 * Mirrors [buildSdk] from SdkTestHarness but accepts a real http client.
 */
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

// ── Tests ────────────────────────────────────────────────────────────────────

class HistoryOnSwitchOrderingTest {

    /**
     * Primary ordering regression test.
     *
     * Before the fix: onSessionAnchored captured generation N, router.route
     * bumped it to N+1; replaceMirror(items, N) was discarded; timeline stayed empty.
     * After the fix: onHistoryNeeded fires AFTER generation++ with post-bump value;
     * replaceMirror(items, N+1) matches → applies → timeline is POPULATED.
     */
    @Test
    fun session_switched_populates_timeline_via_rest_history() = runTest {
        val fake = FakeWebSocketEngine()
        val http = mockHttpClient(messagesPayload("hello", "world"))
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)

        // Connect to READY.
        val connectJob = launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        connectJob.join()

        // Drive a session.switched frame through the real WS ingestion path.
        fake.emit(WsIncoming.Text(switchedFrame("sess-abc")))

        // Wait for the timeline to be populated with the REST history.
        // The bug: without the fix this times out (timeline stays empty).
        val timeline = sdk.timeline.first { it.isNotEmpty() }

        assertEquals(2, timeline.size, "timeline must contain both REST history items, got=$timeline")
        val contents = timeline.map { it.userContent() }
        assertEquals(listOf("hello", "world"), contents, "REST history must be in order, got=$timeline")
    }

    /**
     * Gate-cleared test: after history arrives a live conversation.entry must NOT
     * be dropped. Before the fix, awaitingHistory stayed true permanently because
     * replaceMirror never applied, so every live entry was silently discarded.
     */
    @Test
    fun live_entry_after_switch_is_not_dropped_once_history_arrives() = runTest {
        val fake = FakeWebSocketEngine()
        val http = mockHttpClient(messagesPayload("history-item-1", "history-item-2"))
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)

        val connectJob = launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        connectJob.join()

        // Switch sessions and wait for history to load.
        fake.emit(WsIncoming.Text(switchedFrame("sess-xyz")))
        sdk.timeline.first { it.isNotEmpty() }

        // Now send a live entry — must APPEND (gate clear), not be dropped.
        fake.emit(WsIncoming.Text(entryFrame("live-reply", ts = 99)))
        val timeline = sdk.timeline.first { t -> t.any { it.userContent() == "live-reply" } }

        // History (2) + live entry (1) = 3 items.
        assertEquals(3, timeline.size, "live entry must append after gate cleared, got=$timeline")
        assertEquals("live-reply", timeline.last().userContent(), "live entry must be last in timeline")
    }

    /**
     * Stale-switch guard: a fast second switch's REST response wins; the slower
     * first response is discarded. Drives the full ordering path end-to-end.
     */
    @Test
    fun fast_second_switch_wins_stale_first_fetch_discarded() = runTest {
        val fake = FakeWebSocketEngine()
        // The mock engine keeps a call counter so we can control which response
        // belongs to which switch (first returns "old" items; second returns "new").
        var callCount = 0
        val engine = MockEngine { _ ->
            callCount++
            val body = if (callCount == 1)
                messagesPayload("old-a", "old-b")
            else
                messagesPayload("new-a", "new-b")
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val http = SessionsHttpClient(
            httpClient = HttpClient(engine) {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            },
            gatewayWsUrl = "wss://test/api/v1/ws",
            token = { "tok-abc" },
        )
        val sdk = buildSdkWithHistory(backgroundScope, fake, http)

        val connectJob = launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        connectJob.join()

        // Fire two switches back-to-back before either REST response arrives.
        fake.emit(WsIncoming.Text(switchedFrame("sess-1")))
        fake.emit(WsIncoming.Text(switchedFrame("sess-2")))

        // Wait for the winning (second) fetch to populate the timeline.
        val timeline = sdk.timeline.first { it.isNotEmpty() }

        // The second switch's "new-a"/"new-b" must win; "old-a"/"old-b" must be gone.
        val contents = timeline.map { it.userContent() }
        assertNotEquals(
            listOf("old-a", "old-b"),
            contents,
            "stale first fetch must be discarded, got=$timeline",
        )
        assertEquals(
            listOf("new-a", "new-b"),
            contents,
            "second switch's history must populate the timeline, got=$timeline",
        )
    }
}

// ── Private helpers ──────────────────────────────────────────────────────────

private fun ChatMessage.userContent(): String = this.content
