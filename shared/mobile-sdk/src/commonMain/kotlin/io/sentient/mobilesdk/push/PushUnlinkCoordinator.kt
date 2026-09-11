package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Secure installation-level persistence; implementations must never log [value]. */
interface PushLifecycleStore {
    fun load(): String?
    fun save(value: String)
    fun clear()
}

sealed class PushLifecycleState {
    data object Unlinked : PushLifecycleState()
    data class Linked(val binding: PushBinding, val activationPending: Boolean) : PushLifecycleState()
    data class PendingUnlink(val deliveryMayContinue: Boolean = true) : PushLifecycleState()
    data class UnlinkFailed(val deliveryMayContinue: Boolean = true, val retryable: Boolean) : PushLifecycleState()
}

@Serializable
private data class StoredPushLifecycle(
    val ownerFence: String,
    val binding: PushBinding? = null,
    val revocation: PushRevocationAuthority? = null,
    val pendingUnlink: PushRevokeRequest? = null,
    val pendingRegistration: PushRegistrationRequest? = null,
)

/**
 * Installation-owned lifecycle, intentionally independent of an authenticated user scope.
 * Only an opaque owner fence, binding metadata and revoke-only authority survive logout.
 */
class PushUnlinkCoordinator(
    private val client: PushHttpClient,
    private val store: PushLifecycleStore,
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(readState())
    val state: StateFlow<PushLifecycleState> = _state.asStateFlow()

    suspend fun register(ownerFence: String, request: PushRegistrationRequest): AuthResult<PushBinding> = mutex.withLock {
        require(ownerFence.isNotBlank()); request.validate()
        if (hasUnreadableState()) return@withLock AuthResult.Failure(AuthError.Unknown("push-state-invalid"))
        var current = readStored()
        if (current?.pendingUnlink != null) {
            when (val retried = revokeStored(current)) {
                is AuthResult.Failure -> return@withLock retried
                is AuthResult.Success -> current = null
            }
        }
        val previous = current?.binding
        val replacement = request.replaces
        if (previous != null && (current.ownerFence != ownerFence || replacement == null || previous.generation != replacement.generation || previous.bindingId != replacement.bindingId)) {
            val pending = current.toPendingUnlink()
            persist(pending)
            when (val revoked = revokeStored(pending)) {
                is AuthResult.Failure -> return@withLock revoked
                is AuthResult.Success -> current = null
            }
        }
        when (val result = client.register(request)) {
            is AuthResult.Failure -> result
            is AuthResult.Success -> {
                val issued = result.value
                val stored = StoredPushLifecycle(
                    ownerFence = ownerFence,
                    binding = issued.binding,
                    revocation = issued.revocation,
                    pendingRegistration = request.takeIf { issued.binding.state == PushBindingState.PENDING_OLD_BINDING_DISABLE },
                )
                persist(stored)
                AuthResult.Success(issued.binding)
            }
        }
    }

    /** Local logout may complete immediately after this call, regardless of its result. */
    suspend fun unlink(ownerFence: String): AuthResult<PushRevokeAcknowledgement?> = mutex.withLock {
        if (hasUnreadableState()) return@withLock AuthResult.Failure(AuthError.Unknown("push-state-invalid"))
        val current = readStored() ?: return@withLock AuthResult.Success(null)
        if (current.ownerFence != ownerFence) return@withLock AuthResult.Failure(AuthError.Unknown("account-fence-mismatch"))
        val pending = if (current.pendingUnlink != null) current else current.toPendingUnlink()
        persist(pending)
        revokeStored(pending)
    }

    /** Invoke on connectivity restoration. It uses no login token. */
    suspend fun retryPendingUnlink(): AuthResult<PushRevokeAcknowledgement?> = mutex.withLock {
        if (hasUnreadableState()) return@withLock AuthResult.Failure(AuthError.Unknown("push-state-invalid"))
        val current = readStored() ?: return@withLock AuthResult.Success(null)
        if (current.pendingUnlink == null) return@withLock AuthResult.Success(null)
        revokeStored(current)
    }

    /** Replays the exact logical registration after a stale old-binding view. */
    suspend fun reconcileActivation(ownerFence: String): AuthResult<PushBinding?> = mutex.withLock {
        if (hasUnreadableState()) return@withLock AuthResult.Failure(AuthError.Unknown("push-state-invalid"))
        val current = readStored() ?: return@withLock AuthResult.Success(null)
        if (current.ownerFence != ownerFence) return@withLock AuthResult.Failure(AuthError.Unknown("account-fence-mismatch"))
        val request = current.pendingRegistration ?: return@withLock AuthResult.Success(current.binding)
        when (val result = client.register(request)) {
            is AuthResult.Failure -> result
            is AuthResult.Success -> {
                val next = current.copy(binding = result.value.binding, revocation = result.value.revocation,
                    pendingRegistration = request.takeIf { result.value.binding.state == PushBindingState.PENDING_OLD_BINDING_DISABLE })
                persist(next); AuthResult.Success(result.value.binding)
            }
        }
    }

    private suspend fun revokeStored(stored: StoredPushLifecycle): AuthResult<PushRevokeAcknowledgement?> {
        val request = stored.pendingUnlink ?: return AuthResult.Success(null)
        return when (val result = client.revoke(request)) {
            is AuthResult.Failure -> { _state.value = PushLifecycleState.UnlinkFailed(retryable = result.error.isRetryableUnlink()); result }
            is AuthResult.Success -> {
                // Exact-generation match is validated by PushHttpClient. A stale acknowledgement can never clear a successor.
                store.clear(); _state.value = PushLifecycleState.Unlinked; AuthResult.Success(result.value)
            }
        }
    }

    private fun StoredPushLifecycle.toPendingUnlink(): StoredPushLifecycle {
        val authority = requireNotNull(revocation)
        val request = PushRevokeRequest(
            idempotencyKey = "unlink-${authority.bindingId}-${authority.generation}",
            bindingId = authority.bindingId,
            generation = authority.generation,
            revocationCredential = authority.credential,
        )
        return copy(binding = null, revocation = null, pendingUnlink = request, pendingRegistration = null)
    }

    private fun persist(value: StoredPushLifecycle) {
        store.save(pushJson.encodeToString(StoredPushLifecycle.serializer(), value))
        _state.value = value.toPublicState()
    }
    private fun readStored(): StoredPushLifecycle? = store.load()?.let {
        runCatching { pushJson.decodeFromString(StoredPushLifecycle.serializer(), it) }.getOrNull()
    }
    private fun hasUnreadableState(): Boolean = store.load() != null && readStored() == null
    private fun readState(): PushLifecycleState = when {
        hasUnreadableState() -> PushLifecycleState.UnlinkFailed(deliveryMayContinue = true, retryable = false)
        else -> readStored()?.toPublicState() ?: PushLifecycleState.Unlinked
    }
    private fun StoredPushLifecycle.toPublicState(): PushLifecycleState = when {
        pendingUnlink != null -> PushLifecycleState.PendingUnlink()
        binding != null -> PushLifecycleState.Linked(binding, pendingRegistration != null)
        else -> PushLifecycleState.Unlinked
    }
}

private fun AuthError.isRetryableUnlink(): Boolean = when (this) {
    is AuthError.Network -> true
    is AuthError.Server -> status >= 500
    else -> false
}
