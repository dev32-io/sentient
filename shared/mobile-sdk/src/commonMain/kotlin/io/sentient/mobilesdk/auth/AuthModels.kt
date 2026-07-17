package io.sentient.mobilesdk.auth

import io.sentient.mobilesdk.protocol.AuthUser
import kotlinx.serialization.Serializable

// ── Request DTOs ──

@Serializable
data class LoginRequest(val userId: String, val pin: String)

/** PUT /api/v1/auth/me body — rename the caller's display name. */
@Serializable
data class UpdateMeRequest(val displayName: String)

/** PUT /api/v1/auth/me/pin body — change PIN. Values are NEVER logged. */
@Serializable
data class ChangePinRequest(val currentPin: String, val newPin: String)

// ── Response DTOs ──

/**
 * A single user entry from GET /api/v1/auth/users.
 * avatarTint has a default so older gateway versions without it decode cleanly.
 */
@Serializable
data class AuthUserLite(
    val userId: String,
    val displayName: String,
    val avatarTint: String = "",
)

/**
 * POST /api/v1/auth/login → 200 body.
 * GET  /api/v1/auth/me   → 200 body (refreshed token).
 */
@Serializable
data class AuthResponse(val token: String, val user: AuthUser)

// ── Result type ──

/**
 * Typed non-throwing result for all AuthClient operations.
 * Sealed so callers get exhaustive `when` coverage.
 */
sealed class AuthResult<out T> {

    data class Success<T>(val value: T) : AuthResult<T>()

    data class Failure(val error: AuthError) : AuthResult<Nothing>()
}

sealed class AuthError {
    /** Server returned 401 with body { error: "invalid-credentials" } */
    data object InvalidCredentials : AuthError()

    /** Network or connection failure — no server response available. */
    data class Network(val cause: String) : AuthError()

    /** Server returned 5xx or an unexpected non-2xx status. */
    data class Server(val status: Int, val body: String) : AuthError()

    /** Unexpected response structure or decode failure. */
    data class Unknown(val cause: String) : AuthError()
}
