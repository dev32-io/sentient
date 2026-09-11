package io.sentient.mobilesdk.push

import io.ktor.client.HttpClient
import io.sentient.mobilesdk.secure.DeviceIdProvider
import io.sentient.mobilesdk.secure.IosDeviceIdStore
import io.sentient.mobilesdk.settings.createSettingsHttpClient

/** Swift-friendly installation owner. Keep this object above authenticated user sessions. */
class IosPushLifecycle internal constructor(
    private val httpClient: HttpClient,
    val coordinator: PushUnlinkCoordinator,
    val registrationRequests: PushRegistrationRequestFactory,
) {
    fun close() = httpClient.close()
}

fun createIosPushLifecycle(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    token: () -> String,
): IosPushLifecycle {
    val http = createSettingsHttpClient(allowSelfSignedDevHost)
    return IosPushLifecycle(
        httpClient = http,
        coordinator = PushUnlinkCoordinator(
            client = PushHttpClient(http, gatewayWsUrl, token),
            store = IosPushLifecycleStore(),
        ),
        registrationRequests = PushRegistrationRequestFactory(DeviceIdProvider(IosDeviceIdStore())),
    )
}
