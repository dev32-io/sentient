package io.sentient.mobilesdk.sdk

/** WS auth.error codes that are TERMINAL (token/user invalid) → route to login,
 *  vs transient/unknown codes that stay on the reconnect path. */
private val TERMINAL_AUTH_CODES = setOf("auth-required", "token-validation-failed", "user-not-found")

fun isTerminalAuthError(code: String?): Boolean = code != null && code in TERMINAL_AUTH_CODES
