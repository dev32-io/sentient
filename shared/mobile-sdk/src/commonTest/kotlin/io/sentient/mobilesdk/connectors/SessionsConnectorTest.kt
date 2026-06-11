// ---------------------------------------------------------------------------
// SessionsConnectorTest — pins the session lifecycle frame contract and REST
// delegation after protocol Task 2.1/2.6.
//
// Query RPCs (list/search/delete/rename) now delegate to SessionsHttpClient
// (REST). The WS connector only owns lifecycle frames:
//   switchTo   → sends conversation.activate; resolves on session.switched
//   newChat    → sends session.new; resolves on session.created
//
// Wire/protocol contract → keeper per .claude/rules/testing.md:
//   - switchTo sends conversation.activate (not session.switch)
//   - newChat still sends session.new
//   - session.switched resolves switchTo; session.created resolves newChat
//   - broadcasts fan out to onSessionsChanged
//   - timeout on switch throws SessionsTimeoutException
//   - reset() fails pending waiters
//   - list/delete/rename delegate to httpClient (no WS frame sent)
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

// ── Test helpers ──────────────────────────────────────────────────────────────

private fun row(id: String) = SessionRow(
    sessionId = id,
    rootId = null,
    title = "t-$id",
    startedAt = 0L,
    lastActiveAt = 0L,
    messageCount = 0,
    isActive = false,
)

private fun counterIds(): () -> String {
    var n = 0
    return { "r${n++}" }
}

/**
 * Minimal fake REST client. Uses a stub MockEngine (never called in unit tests
 * since we directly call the fake methods via FakeSessionsHttpClient).
 */
private class FakeSessionsHttpClient(
    private val deleteSuccess: Boolean = true,
    private val renameSuccess: Boolean = true,
) : SessionsHttpClient(
    httpClient = HttpClient(MockEngine { _ -> respond("", HttpStatusCode.OK) }),
    gatewayWsUrl = "wss://h/api/v1/ws",
    token = { "" },
) {
    val listCalls = mutableListOf<Pair<Int, Int>>()
    val deleteCalls = mutableListOf<String>()
    val renameCalls = mutableListOf<Pair<String, String>>()
    var listResult: List<SessionRow> = emptyList()

    override suspend fun list(limit: Int, offset: Int): List<SessionRow> {
        listCalls += limit to offset
        return listResult
    }

    override suspend fun delete(sessionId: String): Boolean {
        deleteCalls += sessionId
        return deleteSuccess
    }

    override suspend fun rename(sessionId: String, title: String): Boolean {
        renameCalls += sessionId to title
        return renameSuccess
    }

    override suspend fun getMessages(sessionId: String, limit: Int, offset: Int): List<ConversationFeedItem> =
        emptyList()

    override suspend fun search(q: String, limit: Int): List<SessionRow> = emptyList()
}

private fun connector(
    sent: MutableList<ClientMessage>,
    httpClient: SessionsHttpClient? = null,
    timeoutMs: Long = 5_000L,
): SessionsConnector =
    SessionsConnector(
        send = { sent += it },
        newId = counterIds(),
        clock = Clock { 0L },
        httpClient = httpClient,
        timeoutMs = timeoutMs,
    )

class SessionsConnectorTest {

    @Test
    fun has_capability_sessions() {
        assertEquals("sessions", connector(mutableListOf()).capability)
    }

    // ── switchTo sends conversation.activate ──────────────────────────────────

    @Test
    fun switchTo_sends_conversation_activate() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.switchTo("s1") }
        runCurrent()

        val frame = sent.single()
        assertIs<ClientMessage.ConversationActivate>(frame)
        assertEquals("s1", frame.sessionId)
        deferred.cancel()
    }

    @Test
    fun switchTo_resolves_on_session_switched_broadcast() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }
        val deferred = async { c.switchTo("s1") }
        runCurrent()

        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))

        deferred.await()
        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Switched("s1", null, 1L)), events)
    }

    @Test
    fun switchTo_times_out_and_throws_typed_exception() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent, timeoutMs = 50L)
        val captured = async { runCatching { c.switchTo("s1") } }
        runCurrent()
        advanceTimeBy(60L)
        runCurrent()

        val ex = captured.await().exceptionOrNull()
        assertTrue(ex is SessionsTimeoutException)
        assertEquals("session.switched", ex.frameType)
    }

    // ── newChat sends session.new ──────────────────────────────────────────────

    @Test
    fun newChat_sends_session_new() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.newChat() }
        runCurrent()

        assertIs<ClientMessage.SessionNew>(sent.single())
        deferred.cancel()
    }

    @Test
    fun newChat_resolves_with_sessionId_on_session_created() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.newChat() }
        runCurrent()

        c.handle(ServerMessage.SessionCreated(sessionId = "s2", ts = 1L))
        assertEquals("s2", deferred.await())
    }

    // ── broadcast fan-out ────────────────────────────────────────────────────

    @Test
    fun deleted_broadcast_fans_out_to_listeners() {
        val c = connector(mutableListOf())
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.SessionsDeleted(sessionId = "s1"))

        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Deleted("s1")), events)
    }

    @Test
    fun renamed_broadcast_fans_out_to_listeners() {
        val c = connector(mutableListOf())
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.SessionsRenamed(sessionId = "s1", title = "Renamed"))

        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Renamed("s1", "Renamed")), events)
    }

    // ── reset fails in-flight waiters ─────────────────────────────────────────

    @Test
    fun reset_fails_in_flight_switch_waiter() = runTest {
        val c = connector(mutableListOf())
        val captured = async { runCatching { c.switchTo("s1") } }
        runCurrent()

        c.reset()

        assertTrue(captured.await().exceptionOrNull() is SessionsTimeoutException)
    }

    @Test
    fun reset_fails_in_flight_newChat_waiter() = runTest {
        val c = connector(mutableListOf())
        val captured = async { runCatching { c.newChat() } }
        runCurrent()

        c.reset()

        assertTrue(captured.await().exceptionOrNull() is SessionsTimeoutException)
    }

    // ── REST delegation: no WS frames sent ───────────────────────────────────

    @Test
    fun list_delegates_to_httpClient_and_sends_no_ws_frame() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val http = FakeSessionsHttpClient().also { it.listResult = listOf(row("s1")) }
        val c = connector(sent, httpClient = http)

        val page = c.list(limit = 20, offset = 0)

        assertEquals(listOf(row("s1")), page.items)
        assertTrue(sent.isEmpty(), "list must NOT send WS frame, sent=$sent")
        assertEquals(listOf(20 to 0), http.listCalls)
    }

    @Test
    fun delete_delegates_to_httpClient_and_fans_out() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val http = FakeSessionsHttpClient(deleteSuccess = true)
        val c = connector(sent, httpClient = http)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.delete("s-99")

        assertEquals(listOf("s-99"), http.deleteCalls)
        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Deleted("s-99")), events)
        assertTrue(sent.isEmpty(), "delete must NOT send WS frame, sent=$sent")
    }

    @Test
    fun delete_does_not_fan_out_on_rest_failure() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val http = FakeSessionsHttpClient(deleteSuccess = false)
        val c = connector(sent, httpClient = http)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.delete("s-99")

        assertEquals(listOf("s-99"), http.deleteCalls, "REST call must still be attempted")
        assertEquals(emptyList(), events, "no fan-out when REST call fails")
        assertTrue(sent.isEmpty(), "delete must NOT send WS frame, sent=$sent")
    }

    @Test
    fun rename_delegates_to_httpClient_and_fans_out() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val http = FakeSessionsHttpClient(renameSuccess = true)
        val c = connector(sent, httpClient = http)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.rename("s-5", "My Chat")

        assertEquals(listOf("s-5" to "My Chat"), http.renameCalls)
        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Renamed("s-5", "My Chat")), events)
        assertTrue(sent.isEmpty(), "rename must NOT send WS frame, sent=$sent")
    }

    @Test
    fun rename_does_not_fan_out_on_rest_failure() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val http = FakeSessionsHttpClient(renameSuccess = false)
        val c = connector(sent, httpClient = http)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.rename("s-5", "My Chat")

        assertEquals(listOf("s-5" to "My Chat"), http.renameCalls, "REST call must still be attempted")
        assertEquals(emptyList(), events, "no fan-out when REST call fails")
        assertTrue(sent.isEmpty(), "rename must NOT send WS frame, sent=$sent")
    }

    @Test
    fun ignores_unowned_frames() {
        val c = connector(mutableListOf())
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.Pong)

        assertEquals(emptyList(), events)
    }
}
