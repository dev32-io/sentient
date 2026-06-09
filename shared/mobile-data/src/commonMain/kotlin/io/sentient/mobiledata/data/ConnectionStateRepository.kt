package io.sentient.mobiledata.data

import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.flow.StateFlow

/** Stateless connection-state surface (transport + voice axis). */
interface ConnectionStateRepository {
    val state: StateFlow<ConnectionState>
}

/** SDK-backed passthrough. */
class SdkConnectionStateRepository(private val sdk: SentientSdk) : ConnectionStateRepository {
    override val state: StateFlow<ConnectionState> get() = sdk.connection
}
