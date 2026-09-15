package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

sealed class PushLifecycleStoreRead {
    data object Missing : PushLifecycleStoreRead()
    data class Value(val value: String) : PushLifecycleStoreRead()
    data object Failure : PushLifecycleStoreRead()
}

/** Secure installation-level persistence; implementations must never log stored values. */
interface PushLifecycleStore {
    fun load(): PushLifecycleStoreRead
    /** True only when [value] reached durable storage. */
    fun save(value: String): Boolean
    fun clear()
}

sealed class PushLifecycleState {
    data object Unlinked : PushLifecycleState()
    data class Linked(val binding: PushBinding, val activationPending: Boolean) : PushLifecycleState()
    data class PendingUnlink(val deliveryMayContinue: Boolean = true) : PushLifecycleState()
    data class RegistrationUncertain(val deliveryMayContinue: Boolean = true) : PushLifecycleState()
    data class UnlinkFailed(val deliveryMayContinue: Boolean = true, val retryable: Boolean) : PushLifecycleState()
    data object StorageUnavailable : PushLifecycleState()
    data object StorageWriteFailed : PushLifecycleState()
    data object AuthorityUnavailable : PushLifecycleState()
}

/** Backend and TLS policy that originally issued a revoke-only capability. */
@Serializable
data class PushTransportAuthority(
    val gatewayWsUrl: String,
    val allowSelfSignedDevHost: Boolean,
)

@Serializable
private data class StoredPushLifecycle(
    val ownerFence: String,
    val origin: PushTransportAuthority? = null,
    val binding: PushBinding? = null,
    val revocation: PushRevocationAuthority? = null,
    val pendingUnlink: PushRevokeRequest? = null,
    val pendingRegistration: PushRegistrationRequest? = null,
    val registrationUncertain: Boolean = false,
)

private sealed class LocalRead {
    data object Missing : LocalRead()
    data class Value(val value: StoredPushLifecycle) : LocalRead()
    data object Failure : LocalRead()
}

private data class RegistrationOperation(val epoch: Long, val ownerFence: String)

/**
 * Installation-owned lifecycle, intentionally independent of authenticated user scope.
 * Local transitions use [localMutex]; network serialization never blocks logout preparation.
 */
class PushUnlinkCoordinator(
    private val registrationClient: PushHttpClient,
    private val registrationOrigin: PushTransportAuthority,
    private val store: PushLifecycleStore,
    private val revocationClient: (PushTransportAuthority) -> PushHttpClient = { registrationClient },
) {
    private val localMutex = Mutex()
    private val networkMutex = Mutex()
    private var volatileState: StoredPushLifecycle? = null
    private var epoch = 0L
    private var acceptingRegistrations = true
    private var registrationInFlight: RegistrationOperation? = null
    private val _state = MutableStateFlow(readState())
    val state: StateFlow<PushLifecycleState> = _state.asStateFlow()

    suspend fun register(ownerFence: String, request: PushRegistrationRequest): AuthResult<PushBinding> = networkMutex.withLock {
        require(ownerFence.isNotBlank()); request.validate()

        var disabledBinding: PushBindingReference? = null
        while (true) {
            val pending = localMutex.withLock {
                when (val loaded = readLocal()) {
                    LocalRead.Failure -> return@withLock localReadFailure()
                    LocalRead.Missing -> AuthResult.Success(null)
                    is LocalRead.Value -> {
                        val current = loaded.value
                        if (!acceptingRegistrations) return@withLock lifecycleClosed()
                        if (current.registrationUncertain) return@withLock registrationUncertain()
                        if (current.pendingUnlink != null) return@withLock AuthResult.Success(current)
                        val previous = current.binding
                        val replacement = request.replaces
                        if (previous != null && (current.ownerFence != ownerFence || replacement == null || previous.generation != replacement.generation || previous.bindingId != replacement.bindingId)) {
                            val frozen = current.toPendingUnlinkOrNull() ?: return@withLock authorityFailure()
                            if (!persist(frozen)) return@withLock storageFailure()
                            AuthResult.Success(frozen)
                        } else {
                            AuthResult.Success(null)
                        }
                    }
                }
            }
            when (pending) {
                is AuthResult.Failure -> return@withLock pending
                is AuthResult.Success -> {
                    val frozen = pending.value ?: break
                    val requestToDisable = frozen.pendingUnlink!!
                    when (val revoked = revokeStored(frozen)) {
                        is AuthResult.Failure -> return@withLock revoked
                        is AuthResult.Success -> disabledBinding = PushBindingReference(requestToDisable.bindingId, requestToDisable.generation)
                    }
                }
            }
        }

        val registrationRequest = request.copy(replaces = request.replaces.takeUnless { it == disabledBinding })
        submitRegistration(ownerFence, registrationRequest)
    }

    /** Freezes local revoke/uncertainty state. Never waits for network. */
    suspend fun prepareUnlink(ownerFence: String): AuthResult<Boolean> = localMutex.withLock {
        acceptingRegistrations = false
        epoch++
        when (val loaded = readLocal()) {
            LocalRead.Failure -> localReadFailure()
            LocalRead.Missing -> AuthResult.Success(false).also { _state.value = PushLifecycleState.Unlinked }
            is LocalRead.Value -> prepareLoaded(loaded.value, ownerFence)
        }
    }

    /** Logged-out restart path: trusts only persisted owner and origin authority. */
    suspend fun preparePersistedUnlink(): AuthResult<Boolean> = localMutex.withLock {
        acceptingRegistrations = false
        epoch++
        when (val loaded = readLocal()) {
            LocalRead.Failure -> localReadFailure()
            LocalRead.Missing -> AuthResult.Success(false).also { _state.value = PushLifecycleState.Unlinked }
            is LocalRead.Value -> prepareLoaded(loaded.value, ownerFence = null)
        }
    }

    /** Compatibility path for settings unlink: durable prepare, then network revoke. */
    suspend fun unlink(ownerFence: String): AuthResult<PushRevokeAcknowledgement?> {
        val prepared = localMutex.withLock {
            epoch++
            when (val loaded = readLocal()) {
                LocalRead.Failure -> localReadFailure()
                LocalRead.Missing -> AuthResult.Success(null)
                is LocalRead.Value -> {
                    if (loaded.value.ownerFence != ownerFence) return@withLock accountMismatch()
                    if (loaded.value.registrationUncertain) return@withLock registrationUncertain()
                    val pending = if (loaded.value.pendingUnlink != null) loaded.value
                    else loaded.value.toPendingUnlinkOrNull() ?: return@withLock authorityFailure()
                    if (!persist(pending)) return@withLock storageFailure()
                    AuthResult.Success(pending)
                }
            }
        }
        return when (prepared) {
            is AuthResult.Failure -> prepared
            is AuthResult.Success -> if (prepared.value == null) AuthResult.Success(null)
            else networkMutex.withLock { drainPendingUnlinks() }
        }
    }

    /** Invoke on connectivity restoration. Uses persisted origin and no login token. */
    suspend fun retryPendingUnlink(): AuthResult<PushRevokeAcknowledgement?> =
        networkMutex.withLock { drainPendingUnlinks() }

    /** Replays exact logical registration after stale old-binding view. */
    suspend fun reconcileActivation(ownerFence: String): AuthResult<PushBinding?> = networkMutex.withLock {
        val request = localMutex.withLock {
            when (val loaded = readLocal()) {
                LocalRead.Failure -> localReadFailure()
                LocalRead.Missing -> AuthResult.Success(null)
                is LocalRead.Value -> {
                    if (!acceptingRegistrations) return@withLock lifecycleClosed()
                    if (loaded.value.ownerFence != ownerFence) return@withLock accountMismatch()
                    AuthResult.Success(loaded.value.pendingRegistration)
                }
            }
        }
        when (request) {
            is AuthResult.Failure -> request
            is AuthResult.Success -> request.value?.let { submitRegistration(ownerFence, it) } ?: currentBinding(ownerFence)
        }
    }

    private suspend fun submitRegistration(ownerFence: String, request: PushRegistrationRequest): AuthResult<PushBinding> {
        val operation = localMutex.withLock {
            if (!acceptingRegistrations) return@withLock lifecycleClosed()
            if (registrationInFlight != null) return@withLock AuthResult.Failure(AuthError.Unknown("push-registration-in-progress"))
            val current = when (val loaded = readLocal()) {
                LocalRead.Failure -> return@withLock localReadFailure()
                LocalRead.Missing -> null
                is LocalRead.Value -> loaded.value
            }
            val uncertain = (current ?: StoredPushLifecycle(ownerFence = ownerFence, origin = registrationOrigin)).copy(
                ownerFence = ownerFence,
                origin = registrationOrigin,
                registrationUncertain = true,
            )
            if (!persistPreflight(uncertain, current)) return@withLock storageFailure()
            RegistrationOperation(++epoch, ownerFence).also { registrationInFlight = it }.let { AuthResult.Success(it) }
        }
        if (operation is AuthResult.Failure) return operation
        operation as AuthResult.Success

        val result = registrationClient.register(request)
        return localMutex.withLock {
            val op = operation.value
            if (registrationInFlight == op) registrationInFlight = null
            when (result) {
                is AuthResult.Failure -> {
                    if (result.error !is AuthError.Network && epoch == op.epoch && acceptingRegistrations) {
                        val current = readLocalValue()
                        if (current != null) persist(current.copy(registrationUncertain = false))
                    }
                    result
                }
                is AuthResult.Success -> {
                    val issued = result.value
                    var stored = StoredPushLifecycle(
                        ownerFence = ownerFence,
                        origin = registrationOrigin,
                        binding = issued.binding,
                        revocation = issued.revocation,
                        pendingRegistration = request.takeIf { issued.binding.state == PushBindingState.PENDING_OLD_BINDING_DISABLE },
                    )
                    val fenced = epoch != op.epoch || !acceptingRegistrations
                    if (fenced) stored = stored.toPendingUnlinkOrNull()!!
                    if (!persist(stored)) return@withLock storageFailure()
                    if (fenced) AuthResult.Failure(AuthError.Unknown("push-registration-fenced"))
                    else AuthResult.Success(issued.binding)
                }
            }
        }
    }

    private fun prepareLoaded(current: StoredPushLifecycle, ownerFence: String?): AuthResult<Boolean> {
        if (ownerFence != null && current.ownerFence != ownerFence) return accountMismatch()
        val withUncertainty = current.copy(
            registrationUncertain = current.registrationUncertain || registrationInFlight?.ownerFence == current.ownerFence,
        )
        val pending = when {
            withUncertainty.pendingUnlink != null -> withUncertainty
            withUncertainty.revocation != null -> withUncertainty.toPendingUnlinkOrNull() ?: return authorityFailure()
            withUncertainty.registrationUncertain -> withUncertainty
            withUncertainty.binding != null -> return authorityFailure()
            else -> return AuthResult.Success(false)
        }
        if ((pending.pendingUnlink != null || pending.revocation != null) && pending.origin == null) return authorityFailure()
        if (!persist(pending)) return storageFailure()
        return if (pending.pendingUnlink == null && pending.registrationUncertain) registrationUncertain() else AuthResult.Success(true)
    }

    /** Called only while [networkMutex] is held; re-reads after every acknowledgement. */
    private suspend fun drainPendingUnlinks(): AuthResult<PushRevokeAcknowledgement?> {
        var lastAcknowledgement: PushRevokeAcknowledgement? = null
        while (true) {
            val pending = localMutex.withLock {
                when (val loaded = readLocal()) {
                    LocalRead.Failure -> localReadFailure()
                    LocalRead.Missing -> AuthResult.Success(null)
                    is LocalRead.Value -> {
                        val current = loaded.value
                        if (current.binding != null && current.revocation == null) return@withLock authorityFailure()
                        if ((current.pendingUnlink != null || current.revocation != null) && current.origin == null) return@withLock authorityFailure()
                        if (current.pendingUnlink == null && current.registrationUncertain) return@withLock registrationUncertain()
                        AuthResult.Success(current.takeIf { it.pendingUnlink != null })
                    }
                }
            }
            when (pending) {
                is AuthResult.Failure -> return pending
                is AuthResult.Success -> {
                    val snapshot = pending.value ?: return AuthResult.Success(lastAcknowledgement)
                    when (val revoked = revokeStored(snapshot)) {
                        is AuthResult.Failure -> return revoked
                        is AuthResult.Success -> lastAcknowledgement = revoked.value ?: lastAcknowledgement
                    }
                }
            }
        }
    }

    private suspend fun revokeStored(snapshot: StoredPushLifecycle): AuthResult<PushRevokeAcknowledgement?> {
        val request = snapshot.pendingUnlink ?: return AuthResult.Success(null)
        val origin = snapshot.origin ?: return localMutex.withLock { authorityFailure() }
        val result = revocationClient(origin).revoke(request)
        return localMutex.withLock {
            when (result) {
                is AuthResult.Failure -> {
                    _state.value = PushLifecycleState.UnlinkFailed(retryable = result.error.isRetryableUnlink())
                    result
                }
                is AuthResult.Success -> {
                    val acknowledgement = result.value
                    if (acknowledgement.bindingId != request.bindingId || acknowledgement.generation != request.generation) {
                        _state.value = PushLifecycleState.UnlinkFailed(retryable = false)
                        AuthResult.Failure(AuthError.Unknown("stale-revocation-acknowledgement"))
                    } else when (val loaded = readLocal()) {
                        LocalRead.Failure -> localReadFailure()
                        LocalRead.Missing -> AuthResult.Success(acknowledgement)
                        is LocalRead.Value -> {
                            val current = loaded.value
                            if (current.pendingUnlink != request || current.origin != origin) {
                                AuthResult.Success(acknowledgement)
                            } else if (current.registrationUncertain) {
                                val uncertain = StoredPushLifecycle(
                                    ownerFence = current.ownerFence,
                                    origin = current.origin,
                                    registrationUncertain = true,
                                )
                                if (!persist(uncertain)) storageFailure() else AuthResult.Success(acknowledgement)
                            } else {
                                volatileState = null
                                store.clear()
                                _state.value = PushLifecycleState.Unlinked
                                AuthResult.Success(acknowledgement)
                            }
                        }
                    }
                }
            }
        }
    }

    private fun StoredPushLifecycle.toPendingUnlinkOrNull(): StoredPushLifecycle? {
        val authority = revocation ?: return null
        if (origin == null) return null
        return copy(
            binding = null,
            revocation = null,
            pendingUnlink = PushRevokeRequest(
                idempotencyKey = "unlink-${authority.bindingId}-${authority.generation}",
                bindingId = authority.bindingId,
                generation = authority.generation,
                revocationCredential = authority.credential,
            ),
            pendingRegistration = null,
        )
    }

    private fun persistPreflight(value: StoredPushLifecycle, previous: StoredPushLifecycle?): Boolean {
        if (!store.save(pushJson.encodeToString(StoredPushLifecycle.serializer(), value))) {
            volatileState = previous
            _state.value = PushLifecycleState.StorageWriteFailed
            return false
        }
        volatileState = null
        _state.value = value.toPublicState()
        return true
    }

    private fun persist(value: StoredPushLifecycle): Boolean {
        if (!store.save(pushJson.encodeToString(StoredPushLifecycle.serializer(), value))) {
            volatileState = value
            _state.value = if (value.registrationUncertain) PushLifecycleState.RegistrationUncertain()
            else PushLifecycleState.StorageWriteFailed
            return false
        }
        volatileState = null
        _state.value = value.toPublicState()
        return true
    }

    private fun readLocal(): LocalRead = when (val stored = store.load()) {
        PushLifecycleStoreRead.Failure -> LocalRead.Failure
        PushLifecycleStoreRead.Missing -> volatileState?.let(LocalRead::Value) ?: LocalRead.Missing
        is PushLifecycleStoreRead.Value -> {
            val decoded = runCatching { pushJson.decodeFromString(StoredPushLifecycle.serializer(), stored.value) }.getOrNull()
                ?: return LocalRead.Failure
            LocalRead.Value(volatileState ?: decoded)
        }
    }

    private fun readLocalValue(): StoredPushLifecycle? = (readLocal() as? LocalRead.Value)?.value

    private fun readState(): PushLifecycleState = when (val loaded = readLocal()) {
        LocalRead.Failure -> PushLifecycleState.StorageUnavailable
        LocalRead.Missing -> PushLifecycleState.Unlinked
        is LocalRead.Value -> loaded.value.toPublicState()
    }

    private fun StoredPushLifecycle.toPublicState(): PushLifecycleState = when {
        binding != null && revocation == null -> PushLifecycleState.AuthorityUnavailable
        (pendingUnlink != null || revocation != null) && origin == null -> PushLifecycleState.AuthorityUnavailable
        registrationUncertain -> PushLifecycleState.RegistrationUncertain()
        pendingUnlink != null -> PushLifecycleState.PendingUnlink()
        binding != null -> PushLifecycleState.Linked(binding, pendingRegistration != null)
        else -> PushLifecycleState.Unlinked
    }

    private fun localReadFailure(): AuthResult.Failure {
        _state.value = PushLifecycleState.StorageUnavailable
        return AuthResult.Failure(AuthError.Unknown("push-state-read-failed"))
    }
    private fun authorityFailure(): AuthResult.Failure {
        _state.value = PushLifecycleState.AuthorityUnavailable
        return AuthResult.Failure(AuthError.Unknown("push-revocation-origin-missing"))
    }
    private fun storageFailure(): AuthResult.Failure = AuthResult.Failure(AuthError.Unknown("push-state-save-failed"))
    private fun accountMismatch(): AuthResult.Failure = AuthResult.Failure(AuthError.Unknown("account-fence-mismatch"))
    private fun lifecycleClosed(): AuthResult.Failure = AuthResult.Failure(AuthError.Unknown("push-lifecycle-closed"))
    private fun registrationUncertain(): AuthResult.Failure = AuthResult.Failure(AuthError.Unknown("push-registration-uncertain"))

    private fun currentBinding(ownerFence: String): AuthResult<PushBinding?> = when (val loaded = readLocal()) {
        LocalRead.Failure -> localReadFailure()
        LocalRead.Missing -> AuthResult.Success(null)
        is LocalRead.Value -> if (loaded.value.ownerFence == ownerFence) AuthResult.Success(loaded.value.binding) else accountMismatch()
    }
}

private fun AuthError.isRetryableUnlink(): Boolean = when (this) {
    is AuthError.Network -> true
    is AuthError.Server -> status >= 500
    else -> false
}
