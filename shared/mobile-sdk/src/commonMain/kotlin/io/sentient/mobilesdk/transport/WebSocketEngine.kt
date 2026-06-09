// ---------------------------------------------------------------------------
// WebSocketEngine — platform-agnostic WebSocket boundary interface.
//
// This is the platform shim boundary for transport. Production implementations
// live in androidMain / iosMain behind this interface. NO platform types cross
// this boundary: only ByteArray, String, Int, and Flow.
//
// WsIncoming.Binary uses reference equality for ByteArray (data class does not
// provide structural ByteArray equality). Tests MUST NOT rely on structural
// equality of Binary frames; compare contents via contentEquals() explicitly.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import kotlinx.coroutines.flow.Flow

/**
 * Incoming frames from the remote WebSocket server.
 *
 * Sealed so callers get exhaustive `when` dispatch.
 *
 * NOTE: [Binary] is a data class wrapping a [ByteArray]. Kotlin data classes
 * delegate equals/hashCode to ByteArray, which uses **reference** equality.
 * Callers that need structural comparison must use [Binary.data].contentEquals().
 */
sealed class WsIncoming {
    /** A UTF-8 text frame from the server. */
    data class Text(val data: String) : WsIncoming()

    /**
     * A binary frame from the server.
     *
     * equals/hashCode use reference identity on [data] (ByteArray default).
     * For structural comparison call [data].contentEquals(other.data).
     */
    data class Binary(val data: ByteArray) : WsIncoming() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Binary) return false
            return data.contentEquals(other.data)
        }

        override fun hashCode(): Int = data.contentHashCode()
    }

    /** Server closed the connection cleanly. */
    data class Closed(val code: Int, val reason: String) : WsIncoming()

    /**
     * Transport-level failure (network error, TLS rejection, etc.).
     *
     * The stream MUST complete after emitting this frame. The reconnect layer
     * above consumes it to decide the next state transition.
     */
    data class Failure(val error: String) : WsIncoming()
}

/**
 * An open WebSocket session returned by [WebSocketEngine.open].
 *
 * Lifecycle: [incoming] emits frames until a [WsIncoming.Closed] or
 * [WsIncoming.Failure] is received, at which point the flow completes.
 * Calling [close] before the remote side closes is always safe.
 */
interface WebSocketSession {
    /** Hot flow of frames arriving from the server. Completes on close/failure. */
    val incoming: Flow<WsIncoming>

    /** Sends a UTF-8 text frame. Suspends until the frame is enqueued. */
    suspend fun sendText(text: String)

    /** Sends a binary frame. Suspends until the frame is enqueued. */
    suspend fun sendBinary(bytes: ByteArray)

    /**
     * Initiates a clean close handshake.
     *
     * @param code  WebSocket close code (e.g. [WS_NORMAL_CLOSURE]).
     * @param reason Human-readable close reason (≤123 UTF-8 bytes per RFC 6455).
     */
    suspend fun close(code: Int, reason: String)
}

/**
 * Platform-provided WebSocket factory.
 *
 * Injected into the transport layer so unit tests can substitute
 * [FakeWebSocketEngine][io.sentient.mobilesdk.fakes.FakeWebSocketEngine]
 * without a platform or network.
 */
interface WebSocketEngine {
    /**
     * Opens a WebSocket connection to [url].
     *
     * @param url Full WebSocket URL (`ws://` or `wss://`).
     * @param allowSelfSignedDevHost When `true`, disables TLS certificate
     *   validation for the dev host only (debug builds). MUST be `false` in
     *   release builds.
     * @return An open [WebSocketSession] ready to send and receive frames.
     * @throws Exception if the connection cannot be established (the reconnect
     *   layer catches this and feeds it to its failure path).
     */
    suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession
}
