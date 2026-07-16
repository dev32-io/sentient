// ---------------------------------------------------------------------------
// AdminUseCases — admin member + secrets ops. Thin passthroughs over
// AdminRepository, plus the pure household-slot cap helper the "Add member" button
// gates on. The cap is enforced server-side (the provisioner rejects at capacity);
// [canAddUser] is the cosmetic client-side disable, mirroring webui members-pane.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.AdminRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.CreateUserRequest
import io.sentient.mobilesdk.settings.SecretsStatus
import io.sentient.mobilesdk.settings.UserSummary

/** Household worker-slot pool size — mirrors webui members-pane POOL_SIZE (gateway slot pool). */
const val HOUSEHOLD_POOL_SIZE: Int = 3

class AdminUseCases(private val admin: AdminRepository) {
    private val log = createLogger("data", "settings", "admin")

    suspend fun listUsers(): SentientResult<List<UserSummary>> = admin.listUsers()

    suspend fun createUser(request: CreateUserRequest): SentientResult<UserSummary> {
        log.info("createUser", mapOf("isAdmin" to request.isAdmin)) // displayName/pin never logged
        return admin.createUser(request)
    }

    suspend fun setUserAdmin(userId: String, isAdmin: Boolean): SentientResult<UserSummary> =
        admin.setUserAdmin(userId, isAdmin)

    suspend fun deleteUser(userId: String): SentientResult<Unit> = admin.deleteUser(userId)

    suspend fun resetPin(userId: String, pin: String): SentientResult<Unit> = admin.resetPin(userId, pin)

    suspend fun getSecretsStatus(): SentientResult<SecretsStatus> = admin.getSecretsStatus()

    suspend fun setLlmProviderKey(provider: String, value: String?, baseUrl: String?): SentientResult<Unit> {
        log.info("setLlmProviderKey", mapOf("provider" to provider, "hasKey" to (value != null))) // key never logged
        return admin.setLlmProviderKey(provider, value, baseUrl)
    }

    suspend fun setActiveLlmProvider(provider: String): SentientResult<Unit> = admin.setActiveLlmProvider(provider)
}

/** Free household slots given the current member count. */
fun householdSlotsFree(userCount: Int): Int = (HOUSEHOLD_POOL_SIZE - userCount).coerceAtLeast(0)

/** True when another member can be added (cap not reached). */
fun canAddUser(userCount: Int): Boolean = userCount < HOUSEHOLD_POOL_SIZE
