package io.sentient.mobilesdk.push

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class PushLifecycleTest {
    private val root = Json.parseToJsonElement(PushGoldenFixture.JSON).jsonObject
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = false; explicitNulls = false }

    @Test fun goldenRegistrationAndIssuanceMatchProtocolFixture() {
        val request = json.decodeFromJsonElement(PushRegistrationRequest.serializer(), root.getValue("registration"))
        val issued = json.decodeFromJsonElement(PushRegistrationResponse.serializer(), root.getValue("issued"))
        request.validate(); issued.validate()
        assertEquals(root.getValue("registration"), json.encodeToJsonElement(PushRegistrationRequest.serializer(), request))
        assertEquals(PushPreviewMode.HIDDEN, issued.binding.preferences.previewMode)
        json.decodeFromJsonElement(PushPendingUnlink.serializer(), root.getValue("pendingUnlink")).validate()
        json.decodeFromJsonElement(PushDeliveryPayload.serializer(), root.getValue("hiddenPayload")).validate()
        json.decodeFromJsonElement(PushDeliveryPayload.serializer(), root.getValue("contentPayload")).validate()
    }

    @Test fun offlineLogoutPersistsOnlyRevokeGrantAndRetriesAfterRecreation() = runTest {
        val store = MemoryStore()
        val issued = json.decodeFromJsonElement(PushRegistrationResponse.serializer(), root.getValue("issued"))
        val request = json.decodeFromJsonElement(PushRegistrationRequest.serializer(), root.getValue("registration"))
        val offline = FakePushClient(registerResult = AuthResult.Success(issued), revokeResult = AuthResult.Failure(AuthError.Network("offline")))
        val first = PushUnlinkCoordinator(offline, store)
        assertIs<AuthResult.Success<PushBinding>>(first.register("account-fence-a", request))
        assertIs<AuthResult.Failure>(first.unlink("account-fence-a"))
        assertIs<PushLifecycleState.UnlinkFailed>(first.state.value)
        val persisted = assertNotNull(store.value)
        assertFalse(persisted.contains("account token"))
        assertFalse(persisted.contains("apnsDeviceToken"))

        val acknowledgement = json.decodeFromJsonElement(PushRevokeAcknowledgement.serializer(), root.getValue("revokeAcknowledgement"))
        val second = PushUnlinkCoordinator(FakePushClient(revokeResult = AuthResult.Success(acknowledgement)), store)
        assertIs<AuthResult.Success<PushRevokeAcknowledgement?>>(second.retryPendingUnlink())
        assertIs<PushLifecycleState.Unlinked>(second.state.value)
        assertNull(store.value)
    }

    @Test fun accountSwitchIsFencedWhileOldUnlinkFails() = runTest {
        val store = MemoryStore()
        val issued = json.decodeFromJsonElement(PushRegistrationResponse.serializer(), root.getValue("issued"))
        val request = json.decodeFromJsonElement(PushRegistrationRequest.serializer(), root.getValue("registration"))
        val client = FakePushClient(AuthResult.Success(issued), AuthResult.Failure(AuthError.Network("offline")))
        val coordinator = PushUnlinkCoordinator(client, store)
        coordinator.register("account-a", request)
        val switched = coordinator.register("account-b", request.copy(idempotencyKey = "account-b"))
        assertIs<AuthResult.Failure>(switched)
        assertEquals(1, client.registerCalls)
        assertTrue(coordinator.state.value is PushLifecycleState.UnlinkFailed)
    }
}

private class MemoryStore : PushLifecycleStore {
    var value: String? = null
    override fun load() = value
    override fun save(value: String) { this.value = value }
    override fun clear() { value = null }
}
private class FakePushClient(
    private val registerResult: AuthResult<PushRegistrationResponse> = AuthResult.Failure(AuthError.Network("unused")),
    private val revokeResult: AuthResult<PushRevokeAcknowledgement> = AuthResult.Failure(AuthError.Network("unused")),
) : PushHttpClient(HttpClient(MockEngine { respondOk() }), "wss://example.test/api/v1/ws", { error("login token must not be read") }) {
    var registerCalls = 0
    override suspend fun register(request: PushRegistrationRequest): AuthResult<PushRegistrationResponse> { registerCalls++; return registerResult }
    override suspend fun revoke(request: PushRevokeRequest): AuthResult<PushRevokeAcknowledgement> = revokeResult
}
