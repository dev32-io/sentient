package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.ErrorKind
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ConnectionRepositoryTest {
    @Test
    fun authExpired_maps_to_terminal_auth_failure() = runTest {
        val src = MutableStateFlow(ConnectionState(status = SdkStatus.ERROR, authExpired = true))
        val repo = ConnectionRepository(connection = src)
        val r = repo.status.first()
        assertTrue(r is SentientResult.Failure)
        assertEquals(ErrorKind.AUTH, (r as SentientResult.Failure).error.kind)
    }

    @Test
    fun ready_maps_to_success() = runTest {
        val src = MutableStateFlow(ConnectionState(status = SdkStatus.READY, hasSession = true))
        val repo = ConnectionRepository(connection = src)
        val r = repo.status.first()
        assertTrue(r is SentientResult.Success)
    }
}
