package io.sentient.mobilesdk.push

import io.ktor.client.HttpClient
import io.sentient.mobilesdk.secure.DeviceIdProvider
import io.sentient.mobilesdk.secure.IosDeviceIdStore
import io.sentient.mobilesdk.settings.createSettingsHttpClient

/** Swift-friendly installation owner. Keep this object above authenticated user sessions. */
class IosPushLifecycle internal constructor(
    private val httpClients: MutableMap<PushTransportAuthority, HttpClient>,
    val coordinator: PushUnlinkCoordinator,
    val registrationRequests: PushRegistrationRequestFactory,
) {
    fun close() {
        httpClients.values.forEach(HttpClient::close)
        httpClients.clear()
    }
}

fun createIosPushLifecycle(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    token: () -> String,
): IosPushLifecycle {
    val origin = PushTransportAuthority(gatewayWsUrl, allowSelfSignedDevHost)
    val httpClients = mutableMapOf<PushTransportAuthority, HttpClient>()
    fun client(authority: PushTransportAuthority): PushHttpClient {
        val http = httpClients.getOrPut(authority) {
            createSettingsHttpClient(authority.allowSelfSignedDevHost, followRedirects = false)
        }
        return PushHttpClient(http, authority.gatewayWsUrl, token)
    }
    return IosPushLifecycle(
        httpClients = httpClients,
        coordinator = PushUnlinkCoordinator(
            registrationClient = client(origin),
            registrationOrigin = origin,
            store = IosPushLifecycleStore(),
            revocationClient = ::client,
        ),
        registrationRequests = PushRegistrationRequestFactory(DeviceIdProvider(IosDeviceIdStore())),
    )
}
