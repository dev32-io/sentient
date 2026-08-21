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

enum class AuthServerErrorCode {
    CONFLICT,
    RECURRENCE_CONFLICT,
    FORBIDDEN,
    NOT_FOUND,
    OCCURRENCE_NOT_FOUND,
    INVALID_TIME,
    INVALID_RANGE,
    INVALID_SCOPE,
    INVALID_MUTATION_SCOPE,
    MALFORMED,
    UNKNOWN,
}

sealed class AuthError {
    /** Server returned 401 with body { error: "invalid-credentials" } */
    data object InvalidCredentials : AuthError()

    /** Network or connection failure — only a structural code crosses the boundary. */
    class Network(@Suppress("UNUSED_PARAMETER") cause: String) : AuthError() {
        val cause: String = "network-error"
    }

    /** Server returned 5xx or an unexpected non-2xx status; body is never retained. */
    class Server(
        val status: Int,
        body: String,
    ) : AuthError() {
        /** Stable allowlisted code; response content itself is never retained. */
        val code: AuthServerErrorCode = authServerErrorCode(body)
        /** Compatibility property is structural and content-free. */
        val body: String = "server-error"
    }

    /** Unexpected response structure or decode failure; exception text is discarded. */
    class Unknown(@Suppress("UNUSED_PARAMETER") cause: String) : AuthError() {
        val cause: String = "unknown-error"
    }
}

private fun authServerErrorCode(body: String): AuthServerErrorCode {
    val compact = body.filterNot(Char::isWhitespace)
    return when {
        compact.contains("\"code\":\"recurrence_conflict\"") -> AuthServerErrorCode.RECURRENCE_CONFLICT
        compact.contains("\"code\":\"conflict\"") -> AuthServerErrorCode.CONFLICT
        compact.contains("\"code\":\"forbidden\"") -> AuthServerErrorCode.FORBIDDEN
        compact.contains("\"code\":\"occurrence_not_found\"") -> AuthServerErrorCode.OCCURRENCE_NOT_FOUND
        compact.contains("\"code\":\"not_found\"") -> AuthServerErrorCode.NOT_FOUND
        compact.contains("\"code\":\"invalid_time\"") -> AuthServerErrorCode.INVALID_TIME
        compact.contains("\"code\":\"invalid_range\"") -> AuthServerErrorCode.INVALID_RANGE
        compact.contains("\"code\":\"invalid_scope\"") -> AuthServerErrorCode.INVALID_SCOPE
        compact.contains("\"code\":\"invalid_mutation_scope\"") -> AuthServerErrorCode.INVALID_MUTATION_SCOPE
        compact.contains("\"code\":\"malformed\"") -> AuthServerErrorCode.MALFORMED
        else -> AuthServerErrorCode.UNKNOWN
    }
}
