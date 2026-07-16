// ---------------------------------------------------------------------------
// DevicesRepository — stateless mapper over the Signal device-linking datasource
// (DevicesHttpClient). Every op maps its AuthResult into the module envelope. The
// status-poll LOOP is a usecase concern, not here — this only exposes one-shot ops.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.DevicesHttpClient
import io.sentient.mobilesdk.settings.DevicesResponse
import io.sentient.mobilesdk.settings.SignalLinkStartResponse
import io.sentient.mobilesdk.settings.SignalLinkStatusResponse

/** Stateless devices/Signal-linking surface. */
interface DevicesRepository {
    suspend fun getDevices(): SentientResult<DevicesResponse>
    suspend fun signalLinkStart(): SentientResult<SignalLinkStartResponse>
    suspend fun signalLinkCancel(): SentientResult<Unit>
    suspend fun signalLinkStatus(): SentientResult<SignalLinkStatusResponse>
    suspend fun signalUnlink(): SentientResult<Unit>
}

class SdkDevicesRepository(private val devices: DevicesHttpClient) : DevicesRepository {
    override suspend fun getDevices(): SentientResult<DevicesResponse> = devices.getDevices().toEnvelope()

    override suspend fun signalLinkStart(): SentientResult<SignalLinkStartResponse> =
        devices.signalLinkStart().toEnvelope()

    override suspend fun signalLinkCancel(): SentientResult<Unit> = devices.signalLinkCancel().toEnvelope()

    override suspend fun signalLinkStatus(): SentientResult<SignalLinkStatusResponse> =
        devices.signalLinkStatus().toEnvelope()

    override suspend fun signalUnlink(): SentientResult<Unit> = devices.signalUnlink().toEnvelope()
}
