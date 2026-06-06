package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map

class ConnectionRepository(private val connection: StateFlow<ConnectionState>) {
    val status: Flow<SentientResult<ConnectionState>> = connection.map { c ->
        when {
            c.authExpired -> SentientResult.Failure(SentientError.Auth("Session expired", terminal = true))
            c.connectionLost -> SentientResult.Failure(SentientError.Connection("Connection lost"))
            c.status == SdkStatus.READY -> SentientResult.Success(c)
            c.status == SdkStatus.ERROR -> SentientResult.Failure(SentientError.Unknown("Connection error"))
            else -> SentientResult.Loading(partial = c)
        }
    }
}
