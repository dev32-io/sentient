// ---------------------------------------------------------------------------
// FakeWebSocketEngine — scriptable WebSocketEngine + WebSocketSession double.
//
// Both interfaces are collapsed into a single class so tests configure the
// fake once and share state between the "engine" side (what urls were opened)
// and the "session" side (what frames were sent, what the server emitted).
//
// Incoming frame control:
//   call fake.emit(WsIncoming.Text("...")) to push a server frame to the session.
//   The flow delivers frames in emission order, buffered by a Channel.
//
// Send recording:
//   fake.sentText   — all text frames sent by the SUT in order.
//   fake.sentBinary — all binary frames sent by the SUT in order.
//   fake.closed     — the (code, reason) pair if close() was called, else null.
//
// Usage in a test:
//   val fake = FakeWebSocketEngine()
//   val session = fake.open("ws://test", false)   // or let the SUT call open()
//   fake.emit(WsIncoming.Text("{\"type\":\"auth.ok\"}"))
//   assertEquals(listOf("{\"type\":\"auth\"}"), fake.sentText)
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * In-memory test double that implements both [WebSocketEngine] and
 * [WebSocketSession].
 *
 * The fake supports a single open session at a time. Calling [open] twice
 * resets the send records and incoming channel, emulating a fresh connection.
 */
class FakeWebSocketEngine : WebSocketEngine, WebSocketSession {

    // -----------------------------------------------------------------------
    // Engine-side observation
    // -----------------------------------------------------------------------

    /** All URLs passed to [open] in order, for assertion. */
    val openedUrls: MutableList<String> = mutableListOf()

    /** All `allowSelfSignedDevHost` values passed to [open], in order. */
    val openedAllowSelfSigned: MutableList<Boolean> = mutableListOf()

    // -----------------------------------------------------------------------
    // Session-side observation
    // -----------------------------------------------------------------------

    /** All text frames sent by the system-under-test via [sendText]. */
    val sentText: MutableList<String> = mutableListOf()

    /** All binary frames sent by the system-under-test via [sendBinary]. */
    val sentBinary: MutableList<ByteArray> = mutableListOf()

    /**
     * The (code, reason) pair from the most recent [close] call, or `null`
     * if [close] has not been called on the current session.
     */
    var closed: Pair<Int, String>? = null
        private set

    // -----------------------------------------------------------------------
    // Incoming frame channel — test drives the server side
    // -----------------------------------------------------------------------

    private var _incomingChannel: Channel<WsIncoming> = Channel(Channel.UNLIMITED)

    /**
     * Pushes a frame from the "server" into the session's [incoming] flow.
     * Suspends only if the channel buffer is full (which it won't be under
     * [Channel.UNLIMITED]).
     */
    suspend fun emit(frame: WsIncoming) {
        _incomingChannel.send(frame)
    }

    /**
     * Signals the server closed the connection by emitting [WsIncoming.Closed]
     * and completing the [incoming] flow.
     */
    suspend fun closeIncoming(code: Int = 1000, reason: String = "normal") {
        _incomingChannel.send(WsIncoming.Closed(code, reason))
        _incomingChannel.close()
    }

    /**
     * Signals a transport failure by emitting [WsIncoming.Failure] and
     * completing the [incoming] flow.
     */
    suspend fun failIncoming(error: String) {
        _incomingChannel.send(WsIncoming.Failure(error))
        _incomingChannel.close()
    }

    // -----------------------------------------------------------------------
    // WebSocketEngine
    // -----------------------------------------------------------------------

    /**
     * Records the [url] and [allowSelfSignedDevHost] flag and returns `this`
     * as the session. Resets send records and replaces the incoming channel so
     * each open is a clean slate.
     */
    override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession {
        openedUrls += url
        openedAllowSelfSigned += allowSelfSignedDevHost
        // Reset session state for the new connection
        sentText.clear()
        sentBinary.clear()
        closed = null
        _incomingChannel = Channel(Channel.UNLIMITED)
        return this
    }

    // -----------------------------------------------------------------------
    // WebSocketSession
    // -----------------------------------------------------------------------

    override val incoming: Flow<WsIncoming>
        get() = _incomingChannel.receiveAsFlow()

    override suspend fun sendText(text: String) {
        sentText += text
    }

    override suspend fun sendBinary(bytes: ByteArray) {
        sentBinary += bytes
    }

    override suspend fun close(code: Int, reason: String) {
        closed = Pair(code, reason)
        _incomingChannel.close()
    }
}
