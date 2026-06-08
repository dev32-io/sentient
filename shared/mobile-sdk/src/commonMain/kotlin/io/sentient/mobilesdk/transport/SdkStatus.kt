// ---------------------------------------------------------------------------
// SdkStatus — SDK connection state machine enum + LastErrorKind discriminator.
//
// Mirrors web-sdk connector-types.ts SDKStatus union and the error-kind
// union used by ReconnectController / sentient-sdk.ts.
//
// Values are intentional 1-to-1 matches with the web-sdk string literals so
// status comparisons across the two SDK implementations stay in sync.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

/**
 * SDK connection status.
 *
 * - [DISCONNECTED] — no live WS. Either initial state, idle-closed, or reconnect-exhausted.
 * - [CONNECTING] — WS handshake in flight.
 * - [AUTHENTICATING] — WS open, auth frame sent, waiting for auth.ok.
 * - [READY] — session.ready received, connectors attached, traffic flows.
 * - [RECONNECTING] — last connection dropped unexpectedly; SDK is in its backoff
 *   loop. Distinct from CONNECTING so the UI can render "Reconnecting…".
 * - [ERROR] — terminal auth failure or session-ready timeout.
 *   Consumer must call forceReconnect() to retry.
 */
enum class SdkStatus {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    READY,
    RECONNECTING,
    ERROR,
}

/**
 * Discriminates the most recent connect-attempt failure kind.
 * Mirrors web-sdk's `ErrorKind = "auth" | "network" | "timeout" | null`.
 */
enum class LastErrorKind {
    NONE,
    AUTH,
    TIMEOUT,
    NETWORK,
}

// ---------------------------------------------------------------------------
// WebSocket close codes — must match gateway sentient-sdk.ts exactly.
// ---------------------------------------------------------------------------

/** Normal voluntary closure (e.g. user called disconnect()). */
const val WS_NORMAL_CLOSURE: Int = 1000

/**
 * Close code the SDK CLIENT sends when ITS OWN auth timeout fires
 * (no `auth.ok` within [AUTH_TIMEOUT_MS]). Mirrors sentient-sdk.ts
 * `this.ws?.close(WS_AUTH_TIMEOUT_CODE, "Auth timeout")`. The gateway does
 * NOT send this code — it is a client-initiated close on a local timeout.
 */
const val WS_AUTH_TIMEOUT_CODE: Int = 4001

/**
 * Close code the SDK CLIENT sends when ITS OWN session.ready timeout fires
 * (no `session.ready` within [READY_TIMEOUT_MS]). Mirrors sentient-sdk.ts
 * `this.ws?.close(WS_READY_TIMEOUT_CODE, "Session ready timeout")`. The
 * gateway does NOT send this code — it is a client-initiated close on a
 * local timeout.
 */
const val WS_READY_TIMEOUT_CODE: Int = 4002

// ---------------------------------------------------------------------------
// SDK timing constants — must match web-sdk sdk-timers.ts / sentient-sdk.ts.
// ---------------------------------------------------------------------------

/**
 * Timeout (ms) waiting for auth.ok after sending the auth frame.
 * Mirrors AUTH_TIMEOUT_MS in sdk-timers.ts.
 */
const val AUTH_TIMEOUT_MS: Long = 10_000L

/**
 * Timeout (ms) waiting for session.ready after auth.ok.
 * Mirrors READY_TIMEOUT_MS in sdk-timers.ts.
 */
const val READY_TIMEOUT_MS: Long = 10_000L
