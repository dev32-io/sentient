// ---------------------------------------------------------------------------
// FakeWebSocketEngine — scriptable WebSocketEngine that mints a fresh
// WebSocketSession per open() (B1-faithful).
//
// Each open() returns a DISTINCT [Session] owning its own incoming channel, so
// closing an OLD session (e.g. the deferred close in SdkLifecycle.teardown())
// never clobbers the channel of a session a later open() created. This mirrors
// a real engine where every open() yields an independent socket — the property
// the B1 caveat depends on for the reconnect path.
//
// Engine-side observation (openedUrls / openedAllowSelfSigned) accumulates
// across opens. Session-side accessors (sentText / sentBinary / closed) and the
// incoming-frame controls (emit / closeIncoming / failIncoming) delegate to the
// CURRENT (most-recently-opened) session, so single-open tests read naturally:
//
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
 * In-memory [WebSocketEngine] test double that mints a fresh [Session] per
 * [open]. A single session is "current" at a time; the engine-level helpers
 * operate on it.
 */
class FakeWebSocketEngine : WebSocketEngine {

    // -----------------------------------------------------------------------
    // Engine-side observation (accumulates across opens)
    // -----------------------------------------------------------------------

    /** All URLs passed to [open] in order, for assertion. */
    val openedUrls: MutableList<String> = mutableListOf()

    /** All `allowSelfSignedDevHost` values passed to [open], in order. */
    val openedAllowSelfSigned: MutableList<Boolean> = mutableListOf()

    /** The session minted by the most recent [open], or `null` before the first. */
    var current: Session? = null
        private set

    // -----------------------------------------------------------------------
    // Session-side accessors — delegate to the current session
    // -----------------------------------------------------------------------

    /** All text frames sent by the SUT on the current session. */
    val sentText: MutableList<String> get() = current?.sentText ?: mutableListOf()

    /** All binary frames sent by the SUT on the current session. */
    val sentBinary: MutableList<ByteArray> get() = current?.sentBinary ?: mutableListOf()

    /** The (code, reason) of the current session's [close], or `null`. */
    val closed: Pair<Int, String>? get() = current?.closed

    // -----------------------------------------------------------------------
    // Incoming-frame control — drives the current session's "server" side
    // -----------------------------------------------------------------------

    /** Pushes a server frame into the current session's [incoming] flow. */
    suspend fun emit(frame: WsIncoming) {
        current?.emit(frame)
    }

    /** Emits a clean [WsIncoming.Closed] on the current session and completes it. */
    suspend fun closeIncoming(code: Int = 1000, reason: String = "normal") {
        current?.closeIncoming(code, reason)
    }

    /** Emits a [WsIncoming.Failure] on the current session and completes it. */
    suspend fun failIncoming(error: String) {
        current?.failIncoming(error)
    }

    // -----------------------------------------------------------------------
    // WebSocketEngine
    // -----------------------------------------------------------------------

    /** Mints + returns a fresh [Session]; records the open for assertion. */
    override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession {
        openedUrls += url
        openedAllowSelfSigned += allowSelfSignedDevHost
        val session = Session()
        current = session
        return session
    }

    /**
     * One open WebSocket session. Owns its own incoming channel + send records,
     * so [close] on this instance affects only this session's channel — never a
     * later session minted by a subsequent [open].
     */
    class Session : WebSocketSession {
        val sentText: MutableList<String> = mutableListOf()
        val sentBinary: MutableList<ByteArray> = mutableListOf()
        var closed: Pair<Int, String>? = null
            private set

        private val channel: Channel<WsIncoming> = Channel(Channel.UNLIMITED)

        suspend fun emit(frame: WsIncoming) {
            channel.send(frame)
        }

        suspend fun closeIncoming(code: Int, reason: String) {
            channel.send(WsIncoming.Closed(code, reason))
            channel.close()
        }

        suspend fun failIncoming(error: String) {
            channel.send(WsIncoming.Failure(error))
            channel.close()
        }

        override val incoming: Flow<WsIncoming> get() = channel.receiveAsFlow()

        override suspend fun sendText(text: String) {
            sentText += text
        }

        override suspend fun sendBinary(bytes: ByteArray) {
            sentBinary += bytes
        }

        override suspend fun close(code: Int, reason: String) {
            closed = Pair(code, reason)
            channel.close()
        }
    }
}
