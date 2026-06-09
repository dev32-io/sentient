// ---------------------------------------------------------------------------
// SessionsConnectorTest — ported VERBATIM from web-sdk
// sessions-connector.test.ts. Pins the request/response correlation contract
// at the gateway↔SDK boundary: each op sends the right frame with a generated
// requestId; the matching *.result frame resolves by requestId; sessions.error
// rejects; broadcast frames fire onSessionsChanged; a timeout fails the call.
// Wire/protocol contract → keeper per .claude/rules/testing.md.
//
// KMP-specific test harness vs web-sdk:
//   - requestId generation is INJECTED as a deterministic counter (not
//     crypto.randomUUID) so assertions are stable.
//   - timeout uses kotlinx-coroutines-test runTest virtual time (advanceTimeBy)
//     so the 5s default never makes the test wait real time; we also inject a
//     short timeout to exercise the boundary explicitly.
//   - On timeout the suspend fn throws the typed SessionsTimeoutException; on
//     gateway error it throws the typed SessionsRequestException.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SessionsConnectorTest {

    /** Deterministic monotonic id generator: r0, r1, r2, … */
    private fun counterIds(): () -> String {
        var n = 0
        return { "r${n++}" }
    }

    private fun row(id: String) = SessionRow(
        sessionId = id,
        rootId = null,
        title = "t-$id",
        startedAt = 0L,
        lastActiveAt = 0L,
        messageCount = 0,
        isActive = false,
    )

    private fun connector(
        sent: MutableList<ClientMessage>,
        timeoutMs: Long = 5_000L,
    ): SessionsConnector =
        SessionsConnector(send = { sent += it }, newId = counterIds(), clock = Clock { 0L }, timeoutMs = timeoutMs)

    @Test
    fun has_capability_sessions() {
        assertEquals("sessions", connector(mutableListOf()).capability)
    }

    @Test
    fun list_sends_frame_and_resolves_on_matching_requestId() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.list(limit = 20, offset = 0) }
        runCurrent()

        val frame = sent[0] as ClientMessage.SessionsList
        assertEquals(20, frame.limit)
        assertEquals(0, frame.offset)
        c.handle(
            ServerMessage.SessionsListResult(
                requestId = frame.requestId,
                items = listOf(row("s1")),
                total = 1,
                hasMore = false,
            ),
        )

        assertEquals(SessionsListPage(listOf(row("s1")), total = 1, hasMore = false), deferred.await())
    }

    @Test
    fun list_rejects_on_sessions_error_matching_requestId() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        // Catch inside the coroutine so the failure does not propagate to the
        // runTest scope (structured concurrency cancels the parent otherwise).
        val captured = async { runCatching { c.list(limit = 20, offset = 0) } }
        runCurrent()

        val frame = sent[0] as ClientMessage.SessionsList
        c.handle(ServerMessage.SessionsError(requestId = frame.requestId, code = "internal", message = "boom"))

        val ex = captured.await().exceptionOrNull()
        assertTrue(ex is SessionsRequestException)
        assertEquals("internal", ex.code)
        assertTrue(ex.message.contains("boom"))
    }

    @Test
    fun search_sends_frame_and_resolves_with_items() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.search(q = "hi", limit = 10) }
        runCurrent()

        val frame = sent[0] as ClientMessage.SessionsSearch
        assertEquals("hi", frame.q)
        assertEquals(10, frame.limit)
        c.handle(ServerMessage.SessionsSearchResult(requestId = frame.requestId, items = listOf(row("s2"))))

        assertEquals(listOf(row("s2")), deferred.await())
    }

    @Test
    fun delete_resolves_on_delete_result_matching_requestId() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.delete("s1") }
        runCurrent()

        val frame = sent[0] as ClientMessage.SessionsDelete
        assertEquals("s1", frame.sessionId)
        c.handle(ServerMessage.SessionsDeleteResult(requestId = frame.requestId, sessionId = "s1"))

        deferred.await() // resolves Unit, no throw
    }

    @Test
    fun delete_broadcasts_change_event_on_sessions_deleted() {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.SessionsDeleted(sessionId = "s1"))

        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Deleted("s1")), events)
    }

    @Test
    fun rename_resolves_on_rename_result_matching_requestId() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.rename("s1", "New Title") }
        runCurrent()

        val frame = sent[0] as ClientMessage.SessionsRename
        assertEquals("s1", frame.sessionId)
        assertEquals("New Title", frame.title)
        c.handle(ServerMessage.SessionsRenameResult(requestId = frame.requestId, sessionId = "s1", title = "New Title"))

        deferred.await() // resolves Unit, no throw
    }

    @Test
    fun rename_broadcasts_change_event_on_sessions_renamed() {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.SessionsRenamed(sessionId = "s1", title = "Renamed"))

        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Renamed("s1", "Renamed")), events)
    }

    @Test
    fun switchTo_resolves_on_session_switched_broadcast() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }
        val deferred = async { c.switchTo("s1") }
        runCurrent()

        assertTrue(sent[0] is ClientMessage.SessionSwitch)
        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))

        deferred.await() // resolves Unit
        assertEquals(listOf<SessionsChangeEvent>(SessionsChangeEvent.Switched("s1", null, 1L)), events)
    }

    @Test
    fun newChat_resolves_with_sessionId_on_session_created() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val deferred = async { c.newChat() }
        runCurrent()

        assertTrue(sent[0] is ClientMessage.SessionNew)
        c.handle(ServerMessage.SessionCreated(sessionId = "s2", ts = 1L))

        assertEquals("s2", deferred.await())
    }

    @Test
    fun request_times_out_and_throws_typed_timeout_exception() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent, timeoutMs = 50L)
        val captured = async { runCatching { c.list(limit = 20, offset = 0) } }
        runCurrent()
        advanceTimeBy(60L)
        runCurrent()

        val ex = captured.await().exceptionOrNull()
        assertTrue(ex is SessionsTimeoutException)
        assertEquals("sessions.list", ex.frameType)
    }

    @Test
    fun reset_fails_in_flight_requests() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val captured = async { runCatching { c.list(limit = 20, offset = 0) } }
        runCurrent()

        c.reset()

        assertTrue(captured.await().exceptionOrNull() is SessionsTimeoutException)
    }

    @Test
    fun ignores_unowned_frames() {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent)
        val events = mutableListOf<SessionsChangeEvent>()
        c.onSessionsChanged { events += it }

        c.handle(ServerMessage.Pong)

        assertEquals(emptyList(), events)
        assertEquals(emptyList(), sent)
    }
}
