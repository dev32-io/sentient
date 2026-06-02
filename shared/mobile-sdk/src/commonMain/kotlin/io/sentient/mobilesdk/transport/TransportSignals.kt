// ---------------------------------------------------------------------------
// TransportSignals — transport-lifecycle sealed types consumed by the
// reconnect layer.
//
// Split out of WsTransport.kt to keep that file under the clean-code budget
// and to give the reconnect controller a flat, SKIE-friendly sealed surface.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

/**
 * A WS lifecycle event the transport surfaces to the reconnect layer.
 *
 * Mirrors the web-sdk split between `onclose` (clean / coded close) and
 * `onerror` (transport failure). The reconnect controller consumes these to
 * decide retry vs abort; per error-handling.md, transport failures are
 * signals, never thrown exceptions escaping the stream.
 */
sealed class TransportSignal {
    /** Server (or local) close handshake completed with [code] + [reason]. */
    data class Closed(val code: Int, val reason: String) : TransportSignal()

    /** Transport-level failure (network drop, TLS rejection). [error] is a message. */
    data class Failure(val error: String) : TransportSignal()
}

/**
 * Outcome of a single connect/auth/session.ready attempt, fed to
 * [ReconnectController]'s loop.
 *
 * Mirrors the web-sdk pattern where `connect()` resolves on `ready` and the
 * controller reads `getLastErrorKind()` after a reject. Here the kind travels
 * with the failure so the loop has no out-of-band getter to consult.
 */
sealed class ConnectResult {
    /** Reached session.ready. The loop stops, status flips to READY upstream. */
    data object Success : ConnectResult()

    /** Attempt failed with the given [kind]; the loop decides retry vs abort. */
    data class Failure(val kind: LastErrorKind) : ConnectResult()
}
