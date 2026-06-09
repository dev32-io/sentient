package io.sentient.mobiledata.result

import io.sentient.mobilesdk.result.SentientError

sealed class SentientResult<out T : Any> {
    data class Loading<out T : Any>(val partial: T? = null) : SentientResult<T>()
    data class Success<out T : Any>(val data: T) : SentientResult<T>()
    data class Failure(val error: SentientError) : SentientResult<Nothing>()
}
