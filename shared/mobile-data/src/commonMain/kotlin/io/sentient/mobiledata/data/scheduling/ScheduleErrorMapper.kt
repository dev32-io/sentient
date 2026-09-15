package io.sentient.mobiledata.data.scheduling

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.result.SentientError

internal fun <T : Any> AuthResult<T>.toScheduleResult(): SentientResult<T> = when (this) {
    is AuthResult.Success -> SentientResult.Success(value)
    is AuthResult.Failure -> SentientResult.Failure(when (val failure = error) {
        AuthError.InvalidCredentials -> SentientError.Auth("Your session expired. Please sign in again.", terminal = true)
        is AuthError.Network -> SentientError.Connection("Connection lost before the scheduling request outcome was confirmed. Reload to verify current state.")
        is AuthError.Unknown -> SentientError.Protocol("The server returned an invalid scheduling response.")
        is AuthError.Server -> when {
            failure.status == 401 -> SentientError.Auth("Your session expired. Please sign in again.", terminal = true)
            failure.status == 409 -> SentientError.Protocol("This schedule changed. Refresh and try again.")
            failure.status in 400..499 -> SentientError.Protocol("The schedule request is invalid.")
            else -> SentientError.Connection("Scheduling is temporarily unavailable.")
        }
    })
}
