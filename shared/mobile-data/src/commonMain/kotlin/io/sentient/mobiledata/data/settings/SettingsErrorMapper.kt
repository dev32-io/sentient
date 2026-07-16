// ---------------------------------------------------------------------------
// SettingsErrorMapper — pure, stateless translation of the mobile-sdk transport
// result taxonomies (AuthError from AuthResult; the failure arms of ApplyResult /
// FishResult) into the module envelope's typed [SentientError].
//
// Kept context-parameterised for the ONE case where the same wire error means two
// different things: a 401 `invalid-credentials` from a token-validating read (me,
// getProfile) is TERMINAL (session expired → route to login), but the same 401
// from `changePin` means "wrong current PIN" — recoverable, NO token drop. Callers
// pass `terminalAuth = false` for the latter (see AccountUseCases.changePin).
//
// This file holds no state and does no folding — the UI-facing envelope fold lives
// in the usecases. It only maps one typed error to another.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.ApplyResult

private const val MSG_SESSION_EXPIRED = "Your session expired. Please sign in again."
private const val MSG_UNAUTHORIZED = "Not authorised."
private const val MSG_NETWORK = "Network unavailable. Check your connection and try again."
private const val MSG_SERVER = "The server rejected the request. Please try again."
private const val MSG_UNKNOWN = "Something went wrong. Please try again."
/** Shared with [io.sentient.mobiledata.usecase.settings.ApplyProfileChangeUseCase]'s elvis fallback. */
internal const val MSG_RESTART_FAILED = "Applying changes failed. Please try again."

/** AuthError → SentientError. `terminalAuth=false` maps a 401 to a recoverable auth error. */
internal fun AuthError.toSentientError(terminalAuth: Boolean = true): SentientError = when (this) {
    AuthError.InvalidCredentials ->
        SentientError.Auth(
            userMessage = if (terminalAuth) MSG_SESSION_EXPIRED else MSG_UNAUTHORIZED,
            terminal = terminalAuth,
        )
    is AuthError.Network -> SentientError.Connection(userMessage = MSG_NETWORK)
    is AuthError.Server -> SentientError.Protocol(userMessage = MSG_SERVER)
    is AuthError.Unknown -> SentientError.Unknown(userMessage = MSG_UNKNOWN)
}

/** The failure arm of a restart mutation → SentientError (used when the FSM folds a Failed/Network). */
internal fun ApplyResult.toSentientErrorOrNull(): SentientError? = when (this) {
    is ApplyResult.Failed -> SentientError.Protocol(userMessage = MSG_RESTART_FAILED)
    is ApplyResult.Network -> SentientError.Connection(userMessage = MSG_NETWORK)
    is ApplyResult.Ready, ApplyResult.InProgress -> null
}

/** Fold an [AuthResult] into the module envelope. Pure 1:1 map — no combine, no accumulation. */
internal fun <T : Any> AuthResult<T>.toEnvelope(terminalAuth: Boolean = true): SentientResult<T> = when (this) {
    is AuthResult.Success -> SentientResult.Success(value)
    is AuthResult.Failure -> SentientResult.Failure(error.toSentientError(terminalAuth))
}
