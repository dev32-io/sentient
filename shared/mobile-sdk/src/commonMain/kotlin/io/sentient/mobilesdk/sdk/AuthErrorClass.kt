package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsRequestException

/**
 * Auth-error classification. Two callers, two opposite safe-defaults:
 *
 *  - The connect-handshake `auth.error` FRAME ([isTerminalAuthError] String overload):
 *    a frame IS an auth rejection, so the safe default is TERMINAL (route to login).
 *    Only a short, explicit allow-list of transient auth codes stays on the reconnect
 *    path. An unrecognised / future code routes to login rather than looping forever.
 *
 *  - A `sessions.error` surfaced as a [Throwable] ([isTerminalAuthError] Throwable
 *    overload): a sessions error is usually NOT an auth failure (e.g. not-found,
 *    rate-limited), so the safe default is NON-terminal. Only a known credential-invalid
 *    code logs the user out (allow-list).
 */

/** auth.error frame codes that are RETRYABLE — a reconnect may clear them. Everything
 *  else on an auth.error frame is terminal. Mirrors the gateway's transient auth-gate
 *  codes (ws-auth-gate.ts: session-limit, auth-timeout) plus rate-limited. */
private val RETRYABLE_AUTH_CODES = setOf("auth-timeout", "session-limit", "rate-limited")

/** Credential-invalid codes that mean "re-login" wherever they appear (sessions errors).
 *  Mirrors gateway TokenError (expired/malformed/signature-invalid/wrong-purpose) +
 *  auth-gate terminal codes (auth-required, user-not-found) + the SDK's legacy
 *  token-validation-failed. */
private val TERMINAL_AUTH_CODES = setOf(
    "auth-required",
    "user-not-found",
    "token-validation-failed",
    "expired",
    "malformed",
    "signature-invalid",
    "wrong-purpose",
)

/**
 * Classify an `auth.error` HANDSHAKE frame code. Terminal (→ route to login) unless the
 * code is explicitly retryable. A null code (malformed frame) is treated as non-terminal
 * so the bounded reconnect loop still runs rather than logging out on a wire glitch.
 */
fun isTerminalAuthError(code: String?): Boolean = code != null && code !in RETRYABLE_AUTH_CODES

/**
 * Classify an uncaught [Throwable] on a connection scope. Only a [SessionsRequestException]
 * carrying a KNOWN credential-invalid code is terminal; every other throw (transport drops,
 * timeouts, generic throws, non-auth sessions errors) is transient → the reconnect
 * supervisor recovers.
 */
fun isTerminalAuthError(error: Throwable): Boolean =
    error is SessionsRequestException && error.code in TERMINAL_AUTH_CODES
