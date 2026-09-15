package io.sentient.mobilesdk.push

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlin.test.*

class PushLifecycleTest {
    private val root = Json.parseToJsonElement(PushGoldenFixture.JSON).jsonObject
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = false; explicitNulls = false }
    private val originA = PushTransportAuthority("wss://a.example/api/v1/ws", false)
    private val originB = PushTransportAuthority("wss://b.example/api/v1/ws", true)

    @Test fun goldenRegistrationAndIssuanceMatchProtocolFixture() {
        val request = request()
        val issued = issued()
        request.validate(); issued.validate()
        assertEquals(root.getValue("registration"), json.encodeToJsonElement(PushRegistrationRequest.serializer(), request))
        assertEquals(PushPreviewMode.HIDDEN, issued.binding.preferences.previewMode)
        json.decodeFromJsonElement(PushPendingUnlink.serializer(), root.getValue("pendingUnlink")).validate()
        json.decodeFromJsonElement(PushDeliveryPayload.serializer(), root.getValue("hiddenPayload")).validate()
        json.decodeFromJsonElement(PushDeliveryPayload.serializer(), root.getValue("contentPayload")).validate()
    }

    @Test fun offlineLogoutPersistsOnlyOriginBoundRevokeAndRetriesAfterRecreation() = runTest {
        val store = MemoryStore()
        val offline = FakePushClient(registerResult = AuthResult.Success(issued()), revokeResult = AuthResult.Failure(AuthError.Network("offline")))
        val first = coordinator(offline, store)
        assertIs<AuthResult.Success<PushBinding>>(first.register("account-fence-a", request()))
        assertIs<AuthResult.Success<Boolean>>(first.prepareUnlink("account-fence-a"))
        assertEquals(0, offline.revokeCalls, "local preparation must not touch network")
        assertIs<AuthResult.Failure>(first.retryPendingUnlink())
        val persisted = assertNotNull(store.value)
        assertTrue(persisted.contains("a.example"))
        assertFalse(persisted.contains("apnsDeviceToken"))

        val selectedOrigins = mutableListOf<PushTransportAuthority>()
        val online = FakePushClient(revokeResult = AuthResult.Success(acknowledgement()))
        val second = coordinator(FakePushClient(), store, originB) { selectedOrigins += it; online }
        assertIs<AuthResult.Success<Boolean>>(second.preparePersistedUnlink())
        assertIs<AuthResult.Success<PushRevokeAcknowledgement?>>(second.retryPendingUnlink())
        assertEquals(listOf(originA), selectedOrigins)
        assertIs<PushLifecycleState.Unlinked>(second.state.value)
    }

    @Test fun lateSuccessfulRegistrationAfterLogoutIsDurablyPendingAcrossRecreation() = runTest {
        val store = MemoryStore()
        val blocked = BlockingRegisterClient()
        val first = coordinator(blocked, store)
        val registration = async { first.register("account-a", request()) }
        blocked.started.await()

        assertIs<AuthResult.Failure>(first.prepareUnlink("account-a"))
        blocked.complete(issued())
        assertIs<AuthResult.Failure>(registration.await())
        assertIs<PushLifecycleState.PendingUnlink>(first.state.value)

        val online = FakePushClient(revokeResult = AuthResult.Success(acknowledgement()))
        val recreated = coordinator(FakePushClient(), store, originB) { authority ->
            assertEquals(originA, authority)
            online
        }
        assertIs<AuthResult.Success<Boolean>>(recreated.preparePersistedUnlink())
        assertIs<AuthResult.Success<PushRevokeAcknowledgement?>>(recreated.retryPendingUnlink())
        assertIs<PushLifecycleState.Unlinked>(recreated.state.value)
    }

    @Test fun cancellationResistantRegistrationNeverBlocksLocalPreparation() = runTest {
        val blocked = BlockingRegisterClient()
        val coordinator = coordinator(blocked, MemoryStore())
        val registration = async { coordinator.register("account-a", request()) }
        blocked.started.await()

        assertIs<AuthResult.Failure>(coordinator.prepareUnlink("account-a"))
        assertIs<PushLifecycleState.RegistrationUncertain>(coordinator.state.value)
        registration.cancel()
        blocked.complete(issued())
    }

    @Test fun legacyGrantWithoutOriginFailsClosedAndNeverUsesUnrelatedBackend() = runTest {
        val fence = "${originA.gatewayWsUrl}|u_deadbeef"
        val store = MemoryStore()
        val first = coordinator(FakePushClient(registerResult = AuthResult.Success(issued())), store)
        assertIs<AuthResult.Success<PushBinding>>(first.register(fence, request()))
        val legacy = store.value!!.replace(Regex(",?\"origin\":\\{[^}]+}"), "")
        store.value = legacy
        val unrelatedBackend = FakePushClient(revokeResult = AuthResult.Success(acknowledgement()))
        val recreated = coordinator(unrelatedBackend, store, originB)

        assertIs<PushLifecycleState.AuthorityUnavailable>(recreated.state.value)
        assertIs<AuthResult.Failure>(recreated.preparePersistedUnlink())
        assertIs<AuthResult.Failure>(recreated.retryPendingUnlink())
        assertEquals(0, unrelatedBackend.registerCalls)
        assertEquals(0, unrelatedBackend.revokeCalls)
        assertEquals(legacy, store.value)
    }

    @Test fun failedPreflightWriteMakesNoRemoteCallAndRegistrationRetriesAfterRecovery() = runTest {
        val store = MemoryStore(failSaveCalls = mutableSetOf(1))
        val client = FakePushClient(registerResult = AuthResult.Success(issued()))
        val coordinator = coordinator(client, store)

        assertIs<AuthResult.Failure>(coordinator.register("account-a", request()))
        assertEquals(0, client.registerCalls)
        assertIs<PushLifecycleState.StorageWriteFailed>(coordinator.state.value)

        assertIs<AuthResult.Success<PushBinding>>(coordinator.register("account-a", request()))
        assertEquals(1, client.registerCalls)
        assertIs<PushLifecycleState.Linked>(coordinator.state.value)
    }

    @Test fun concurrentRetryRevokesLateReplacementBeforeReportingTerminalSuccess() = runTest {
        val firstIssued = issued()
        val secondIssued = PushRegistrationResponse(
            binding = firstIssued.binding.copy(bindingId = "bind_2", generation = 8),
            revocation = firstIssued.revocation.copy(bindingId = "bind_2", generation = 8),
            replayed = false,
        )
        val client = SecondRegistrationBlockingClient(firstIssued, secondIssued)
        val coordinator = coordinator(client, MemoryStore())
        assertIs<AuthResult.Success<PushBinding>>(coordinator.register("account-a", request()))

        val replacement = async {
            coordinator.register("account-a", request().copy(idempotencyKey = "replacement", replaces = reference()))
        }
        client.secondStarted.await()
        assertIs<AuthResult.Success<Boolean>>(coordinator.prepareUnlink("account-a"))
        val retry = async { coordinator.retryPendingUnlink() }
        yield()
        assertFalse(retry.isCompleted)
        assertTrue(client.revokedBindingIds.isEmpty())

        client.completeSecond()
        assertIs<AuthResult.Failure>(replacement.await())
        assertIs<AuthResult.Success<PushRevokeAcknowledgement?>>(retry.await())
        assertEquals(listOf("bind_2"), client.revokedBindingIds)
        assertIs<PushLifecycleState.Unlinked>(coordinator.state.value)
    }

    @Test fun lifecycleReadFailureNeverReportsUnlinkedAndRetriesAfterRecovery() = runTest {
        val store = MemoryStore(readFails = true)
        val coordinator = coordinator(FakePushClient(), store)
        assertIs<PushLifecycleState.StorageUnavailable>(coordinator.state.value)
        assertIs<AuthResult.Failure>(coordinator.preparePersistedUnlink())
        store.readFails = false
        assertIs<AuthResult.Success<Boolean>>(coordinator.preparePersistedUnlink())
        assertIs<PushLifecycleState.Unlinked>(coordinator.state.value)
    }

    @Test fun registrationResponseLossRemainsDurablyUncertain() = runTest {
        val store = MemoryStore()
        val coordinator = coordinator(FakePushClient(registerResult = AuthResult.Failure(AuthError.Network("response-lost"))), store)
        assertIs<AuthResult.Failure>(coordinator.register("account-a", request()))
        assertIs<PushLifecycleState.RegistrationUncertain>(coordinator.state.value)
        val persisted = assertNotNull(store.value)
        assertFalse(persisted.contains("apnsDeviceToken"))
        assertFalse(persisted.contains("token"))
        assertIs<PushLifecycleState.RegistrationUncertain>(coordinator(FakePushClient(), store).state.value)
    }

    @Test fun staleAcknowledgementCannotClearPendingGrant() = runTest {
        val stale = acknowledgement().copy(generation = issued().binding.generation + 1)
        val store = MemoryStore()
        val coordinator = coordinator(FakePushClient(AuthResult.Success(issued()), AuthResult.Success(stale)), store)
        coordinator.register("account-a", request())
        assertIs<AuthResult.Failure>(coordinator.unlink("account-a"))
        assertNotNull(store.value)
        assertIs<PushLifecycleState.UnlinkFailed>(coordinator.state.value)
    }

    @Test fun accountSwitchRemovesReplacementFenceAfterOldBindingIsRevoked() = runTest {
        val client = FakePushClient(AuthResult.Success(issued()), AuthResult.Success(acknowledgement()))
        val coordinator = coordinator(client, MemoryStore())
        assertIs<AuthResult.Success<PushBinding>>(coordinator.register("account-a", request()))
        val nextBinding = issued().binding.copy(bindingId = "bind_2", generation = 8)
        client.registerResult = AuthResult.Success(PushRegistrationResponse(nextBinding, issued().revocation.copy(bindingId = "bind_2", generation = 8), false))

        val switched = coordinator.register("account-b", request().copy(idempotencyKey = "account-b", replaces = reference()))
        assertIs<AuthResult.Success<PushBinding>>(switched)
        assertNull(client.registerRequests.last().replaces)
        assertEquals(nextBinding, (coordinator.state.value as PushLifecycleState.Linked).binding)
    }

    @Test fun accountSwitchIsFencedWhileOldUnlinkFails() = runTest {
        val client = FakePushClient(AuthResult.Success(issued()), AuthResult.Failure(AuthError.Network("offline")))
        val coordinator = coordinator(client, MemoryStore())
        coordinator.register("account-a", request())
        assertIs<AuthResult.Failure>(coordinator.register("account-b", request().copy(idempotencyKey = "account-b")))
        assertEquals(1, client.registerCalls)
        assertIs<PushLifecycleState.UnlinkFailed>(coordinator.state.value)
    }

    private fun request() = json.decodeFromJsonElement(PushRegistrationRequest.serializer(), root.getValue("registration"))
    private fun issued() = json.decodeFromJsonElement(PushRegistrationResponse.serializer(), root.getValue("issued"))
    private fun acknowledgement() = json.decodeFromJsonElement(PushRevokeAcknowledgement.serializer(), root.getValue("revokeAcknowledgement"))
    private fun reference() = PushBindingReference(issued().binding.bindingId, issued().binding.generation)
    private fun coordinator(
        client: PushHttpClient,
        store: MemoryStore,
        origin: PushTransportAuthority = originA,
        revocationClient: (PushTransportAuthority) -> PushHttpClient = { client },
    ) = PushUnlinkCoordinator(client, origin, store, revocationClient)
}

private class MemoryStore(
    private val failSaveCalls: MutableSet<Int> = mutableSetOf(),
    var readFails: Boolean = false,
) : PushLifecycleStore {
    var value: String? = null
    private var saveCalls = 0
    override fun load(): PushLifecycleStoreRead = when {
        readFails -> PushLifecycleStoreRead.Failure
        value == null -> PushLifecycleStoreRead.Missing
        else -> PushLifecycleStoreRead.Value(value!!)
    }
    override fun save(value: String): Boolean {
        saveCalls++
        if (saveCalls in failSaveCalls) return false
        this.value = value
        return true
    }
    override fun clear() { value = null }
}

private open class FakePushClient(
    var registerResult: AuthResult<PushRegistrationResponse> = AuthResult.Failure(AuthError.Network("unused")),
    var revokeResult: AuthResult<PushRevokeAcknowledgement> = AuthResult.Failure(AuthError.Network("unused")),
) : PushHttpClient(HttpClient(MockEngine { respondOk() }), "wss://example.test/api/v1/ws", { error("login token must not be read") }) {
    var registerCalls = 0
    var revokeCalls = 0
    val registerRequests = mutableListOf<PushRegistrationRequest>()
    override suspend fun register(request: PushRegistrationRequest): AuthResult<PushRegistrationResponse> {
        registerCalls++
        registerRequests += request
        return registerResult
    }
    override suspend fun revoke(request: PushRevokeRequest): AuthResult<PushRevokeAcknowledgement> {
        revokeCalls++
        return revokeResult
    }
}

private class SecondRegistrationBlockingClient(
    private val first: PushRegistrationResponse,
    private val second: PushRegistrationResponse,
) : FakePushClient() {
    val secondStarted = CompletableDeferred<Unit>()
    val revokedBindingIds = mutableListOf<String>()
    private val releaseSecond = CompletableDeferred<Unit>()

    override suspend fun register(request: PushRegistrationRequest): AuthResult<PushRegistrationResponse> {
        registerCalls++
        registerRequests += request
        if (registerCalls == 1) return AuthResult.Success(first)
        secondStarted.complete(Unit)
        withContext(NonCancellable) { releaseSecond.await() }
        return AuthResult.Success(second)
    }

    override suspend fun revoke(request: PushRevokeRequest): AuthResult<PushRevokeAcknowledgement> {
        revokeCalls++
        revokedBindingIds += request.bindingId
        return AuthResult.Success(PushRevokeAcknowledgement(
            bindingId = request.bindingId,
            generation = request.generation,
            status = PushRevocationStatus.REVOKED,
            acknowledgedAt = "2026-01-01T00:00:00Z",
        ))
    }

    fun completeSecond() { releaseSecond.complete(Unit) }
}

private class BlockingRegisterClient : FakePushClient() {
    val started = CompletableDeferred<Unit>()
    private val result = CompletableDeferred<PushRegistrationResponse>()
    override suspend fun register(request: PushRegistrationRequest): AuthResult<PushRegistrationResponse> {
        registerCalls++
        registerRequests += request
        started.complete(Unit)
        return AuthResult.Success(withContext(NonCancellable) { result.await() })
    }
    fun complete(value: PushRegistrationResponse) { result.complete(value) }
}
