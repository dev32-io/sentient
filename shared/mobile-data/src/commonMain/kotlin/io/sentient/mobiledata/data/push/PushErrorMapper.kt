package io.sentient.mobiledata.data.push

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.AuthServerErrorCode
import io.sentient.mobilesdk.result.SentientError

internal fun <T : Any> AuthResult<T>.toPushResult(): SentientResult<T> = when (this) {
    is AuthResult.Success -> SentientResult.Success(value)
    is AuthResult.Failure -> SentientResult.Failure(when (val failure = error) {
        AuthError.InvalidCredentials -> SentientError.Auth("Your session expired. Please sign in again.", terminal = true)
        is AuthError.Network -> SentientError.Connection("Network unavailable. Try notification settings again.")
        is AuthError.Unknown -> SentientError.Protocol("The server returned an invalid notification settings response.")
        is AuthError.Server -> when {
            failure.status == 401 -> SentientError.Auth("Your session expired. Please sign in again.", terminal = true)
            failure.status == 409 -> SentientError.Protocol("Notification settings changed elsewhere. Review the latest settings and try again.")
            failure.code == AuthServerErrorCode.PROVIDER_UNAVAILABLE -> SentientError.Connection("Push delivery provider is unavailable.")
            failure.status in 400..499 -> SentientError.Protocol("The notification settings request is invalid.")
            else -> SentientError.Connection("Notification settings are temporarily unavailable.")
        }
    })
}
