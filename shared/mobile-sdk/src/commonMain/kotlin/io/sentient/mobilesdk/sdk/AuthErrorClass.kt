package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsRequestException

/** WS auth.error codes that are TERMINAL (token/user invalid) → route to login,
 *  vs transient/unknown codes that stay on the reconnect path. */
private val TERMINAL_AUTH_CODES = setOf("auth-required", "token-validation-failed", "user-not-found")

fun isTerminalAuthError(code: String?): Boolean = code != null && code in TERMINAL_AUTH_CODES

/**
 * Classify an uncaught [Throwable] surfacing on a connection scope: terminal auth
 * (→ route to login) vs transient (→ reconnect supervisor recovers). Only a
 * [SessionsRequestException] carries the gateway's auth code; everything else
 * (transport drops, timeouts, generic throws) is transient. Delegates to the
 * code-based classifier so [TERMINAL_AUTH_CODES] stays the single source of truth.
 */
fun isTerminalAuthError(error: Throwable): Boolean =
    error is SessionsRequestException && isTerminalAuthError(error.code)
