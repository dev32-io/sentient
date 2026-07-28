// ---------------------------------------------------------------------------
// PrivacyGuardTest — privacy boundary: chat content must never appear in the
// captured diagnostic log. Three cases are pinned:
//
//   1. InFlightMessageConnector (streaming assistant text path): logs only
//      cycleId, deltaLen, totalLen — never the raw delta. This was the
//      original guard.
//
//   2. WsTransport recv path (NEW): the inbound TEXT-frame boundary was the
//      proven chat-content leak site (line 143 of WsTransport.kt logged `raw`
//      directly). This case drives the REAL WsTransport.routeText path via
//      FakeWebSocketEngine so the guard now exercises the actual leak vector
//      and will fail loudly if raw-frame logging is ever re-introduced.
//
//   3. Conversation-search query path: SessionsConnector.search() and
//      SessionsHttpClient.search() both previously logged `q.take(60)` —
//      the raw user search query = user content. The fix changed to `qLen`
//      (integer length only). This case drives the REAL SessionsConnector
//      path so the guard fails loudly if raw query logging is re-introduced.
//
// Why this test belongs here (.claude/rules/testing.md):
//   Security boundary — log content privacy is an explicit boundary concern.
//   The SDK's logging convention logs lengths/ids/types only, never message
//   content. This guard pins that property so any future change that starts
//   logging raw content fails loudly instead of silently leaking to disk.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.vitals

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.connectors.SessionsConnector
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.transport.WsIncoming
import io.sentient.mobilesdk.transport.WsTransport
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class PrivacyGuardTest {

    @AfterTest fun reset() {
        VitalsLogTap.clear()
        LogConfig.minLevel = LogLevel.DEBUG
    }

    @Test fun captured_log_never_contains_chat_text() {
        val secret = "the capital of France is Paris and my dog is named Biscuit"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line ->
            captured.append(tag).append(' ').append(line).append('\n')
        }

        // Drive the REAL streaming path with the secret as the assistant delta text.
        // InFlightMessageConnector logs only cycleId, deltaLen, and totalLen — never
        // the raw delta — so the secret must not appear in the captured output.
        val c = InFlightMessageConnector()
        c.handle(ServerMessage.TurnStarted(turnId = "c-priv-1", trigger = "text"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-priv-1", text = secret))
        c.handle(ServerMessage.TurnCompleted(turnId = "c-priv-1"))

        // Also exercise the abort (barge-in) path — in-flight content dropped mid-stream
        // is the primary case the diagnostic feature exists to debug and a plausible
        // future leak vector. The secret must not appear in abort logging either.
        c.handle(ServerMessage.TurnStarted(turnId = "c-priv-2", trigger = "text"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-priv-2", text = secret))
        c.handle(ServerMessage.TurnAborted(turnId = "c-priv-2", cutoff = "barge-in"))

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "chat text leaked into the diagnostic log:\n$log",
        )
    }

    /**
     * Exercises the REAL WsTransport inbound TEXT-frame path — the proven
     * chat-content leak site (WsTransport.routeText logged `raw` directly before
     * the fix). A realistic assistant.message.delta JSON frame whose `delta` field
     * contains the secret is delivered through FakeWebSocketEngine so that
     * routeText runs and logs. The captured ring must contain ZERO chat text.
     *
     * Before fix: log.debug("recv-text", mapOf("raw" to raw)) → the first 120
     * chars of the frame body appear in the ring, leaking the delta text.
     * After fix:  log.debug("recv-text", mapOf("len" to raw.length)) → only an
     * integer length is captured; the secret cannot appear.
     */
    @Test fun ws_transport_recv_path_never_logs_frame_content() = runTest {
        val secret = "the capital of France is Paris and my dog is named Biscuit"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line ->
            captured.append(tag).append(' ').append(line).append('\n')
        }

        // Realistic assistant.message.delta wire frame — this is the exact JSON
        // shape the gateway sends. The `delta` field holds the chat content that
        // was leaking into the diagnostic ring.
        val frame = """{"type":"assistant.message.delta","cycleId":"c-ws-priv-1","delta":"$secret"}"""

        val fake = FakeWebSocketEngine()
        val session = fake.open("wss://test/ws", allowSelfSignedDevHost = false)
        // Drain events so the pump coroutine progresses — pump blocks on channel
        // send until a consumer reads, and backgroundScope ensures it's cleaned up.
        val transport = WsTransport(session, scope = backgroundScope)
        transport.events.launchIn(backgroundScope)

        // Deliver the secret-bearing text frame through the real transport recv path.
        fake.emit(WsIncoming.Text(frame))
        // Close the session so the pump drains and the log line is committed.
        fake.closeIncoming()

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "chat text from WS frame leaked into the diagnostic log:\n$log",
        )
    }

    /**
     * Exercises the REAL SessionsConnector.search() path — the proven search-query
     * content leak site (SessionsConnector.kt line 139 logged `q.take(60)` directly
     * before the fix; SessionsHttpClient.kt line 145 did the same).
     *
     * The fix changed both to `qLen` (integer length only). This guard drives the
     * REAL SessionsConnector with a MockEngine-backed SessionsHttpClient so that
     * both the connector and http-client log lines execute. The captured ring must
     * contain ZERO search query content.
     *
     * Before fix: log.debug("search", mapOf("q" to q.take(60))) → up to 60 chars
     *   of the raw user query appear in the ring.
     * After fix:  log.debug("search", mapOf("qLen" to q.length)) → only an integer
     *   length is captured; the secret cannot appear.
     */
    @Test
    fun search_query_never_logged_as_content() = runTest {
        val secret = "my-secret-search-query-chocolate-labrador-1928"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line ->
            captured.append(tag).append(' ').append(line).append('\n')
        }

        // Build a real SessionsHttpClient backed by a MockEngine that returns an
        // empty result — we don't care about the response, only the log output.
        val engine = MockEngine { _ ->
            respond(
                """{"items":[],"total":0,"hasMore":false}""",
                HttpStatusCode.OK,
                headersOf("Content-Type", "application/json"),
            )
        }
        val httpClient = SessionsHttpClient(
            httpClient = HttpClient(engine),
            gatewayWsUrl = "wss://test/api/v1/ws",
            token = { "tok" },
        )

        // Drive the REAL SessionsConnector.search() — this is the code path that
        // called q.take(PREVIEW_LEN) before the fix. The connector delegates to the
        // http client which also had the same log line; both paths run here.
        val connector = SessionsConnector(
            send = { _: ClientMessage -> },
            newId = { "r0" },
            clock = Clock { 0L },
            httpClient = httpClient,
        )
        connector.search(q = secret, limit = 10)

        val log = captured.toString()
        assertTrue(
            !log.contains(secret),
            "search query content leaked into the diagnostic log:\n$log",
        )
    }
}
