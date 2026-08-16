// ---------------------------------------------------------------------------
// SessionsConnectorFireAndForgetTest — pins the A2 fire-and-forget command
// surface + the connection-scoped mint debounce.
//
// Wire/protocol contract at the gateway↔SDK boundary (per .claude/rules/testing.md):
//   - sendNew() emits exactly ONE session.new while a mint is in flight, so rapid
//     new-chat taps collapse to a single ACP mint (no phantom sessions).
//   - the debounce is connection-scoped: cleared on session.created (mint done)
//     AND on reset() (disconnect → fresh connection → fresh mint allowed).
//   - sendSwitch(id) always emits a session.switch (idempotent, never debounced).
//
// Drives the connector directly with a captured `send` + a deterministic
// FixedClock — no platform, no virtual-time scheduler needed (the ops are
// non-suspend fire-and-forget).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SessionsConnectorFireAndForgetTest {

    private val debounceMs = 3_000L

    /** Deterministic monotonic id generator: r0, r1, r2, … */
    private fun counterIds(): () -> String {
        var n = 0
        return { "r${n++}" }
    }

    private fun connector(
        sent: MutableList<ClientMessage>,
        clock: FixedClock,
    ): SessionsConnector = SessionsConnector(
        send = { sent += it },
        newId = counterIds(),
        clock = clock,
        mintDebounceMs = debounceMs,
    )

    @Test
    fun rapid_sendNew_within_window_mints_once() {
        val sent = mutableListOf<ClientMessage>()
        val clock = FixedClock(1_000L)
        val c = connector(sent, clock)

        // Three taps all STRICTLY inside the debounce window collapse to one mint.
        c.sendNew()
        clock.advance(1)
        c.sendNew()
        clock.advance(debounceMs - 2) // total elapsed = debounceMs - 1 < debounceMs
        c.sendNew()

        val news = sent.filterIsInstance<ClientMessage.SessionNew>()
        assertEquals(1, news.size, "rapid sendNew within window must mint once, sent=$sent")
    }

    @Test
    fun sendNew_after_window_elapses_mints_again() {
        val sent = mutableListOf<ClientMessage>()
        val clock = FixedClock(1_000L)
        val c = connector(sent, clock)

        c.sendNew()
        clock.advance(debounceMs) // window edge reached → debounce no longer holds
        c.sendNew()

        assertEquals(
            2,
            sent.filterIsInstance<ClientMessage.SessionNew>().size,
            "a mint at/after the window edge must emit again, sent=$sent",
        )
    }

    @Test
    fun sendNew_after_session_created_mints_again() {
        val sent = mutableListOf<ClientMessage>()
        val clock = FixedClock(1_000L)
        val c = connector(sent, clock)

        c.sendNew()
        // Mint completes: the gateway broadcasts session.created. This clears the
        // debounce so the next explicit new-chat is allowed even inside the window.
        c.handle(ServerMessage.SessionCreated(sessionId = "s-uuid", ts = 1L))
        clock.advance(10) // still well inside debounceMs
        c.sendNew()

        assertEquals(
            2,
            sent.filterIsInstance<ClientMessage.SessionNew>().size,
            "a mint after session.created must emit again, sent=$sent",
        )
    }

    @Test
    fun sendNew_after_reset_mints_again() {
        val sent = mutableListOf<ClientMessage>()
        val clock = FixedClock(1_000L)
        val c = connector(sent, clock)

        c.sendNew()
        // Disconnect → reset() → new connection → fresh mint allowed (connection-scoped).
        c.reset()
        clock.advance(10) // still inside debounceMs
        c.sendNew()

        assertEquals(
            2,
            sent.filterIsInstance<ClientMessage.SessionNew>().size,
            "a mint after reset() must emit again, sent=$sent",
        )
    }

    @Test
    fun sendSwitch_always_emits_conversation_activate() {
        val sent = mutableListOf<ClientMessage>()
        val clock = FixedClock(1_000L)
        val c = connector(sent, clock)

        c.sendSwitch("s-1")
        c.sendSwitch("s-2") // no debounce on switch

        val activates = sent.filterIsInstance<ClientMessage.ConversationActivate>()
        assertEquals(2, activates.size, "every sendSwitch must emit, sent=$sent")
        assertEquals(listOf("s-1", "s-2"), activates.map { it.sessionId })
    }

    @Test
    fun sendNew_emits_session_new_frame() {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent, FixedClock(0L))
        c.sendNew()
        assertTrue(sent.single() is ClientMessage.SessionNew, "first sendNew must emit session.new")
    }

    @Test
    fun startFreshChat_marks_session_new_explicit() {
        val sent = mutableListOf<ClientMessage>()
        val c = connector(sent, FixedClock(0L))
        c.startFreshChat()
        assertEquals("explicit", (sent.single() as ClientMessage.SessionNew).intent)
    }
}
