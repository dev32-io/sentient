// ---------------------------------------------------------------------------
// AdminRepository — stateless mapper over the admin datasource (AdminHttpClient):
// member management + integration-secrets STATUS. Every op maps its AuthResult
// into the module envelope. Key material is write-only and never surfaced (the
// client never logs it; GET returns booleans only).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.AdminHttpClient
import io.sentient.mobilesdk.settings.CreateUserRequest
import io.sentient.mobilesdk.settings.SecretsStatus
import io.sentient.mobilesdk.settings.UserSummary

/** Stateless admin surface — members + secrets status. */
interface AdminRepository {
    suspend fun listUsers(): SentientResult<List<UserSummary>>
    suspend fun createUser(request: CreateUserRequest): SentientResult<UserSummary>
    suspend fun setUserAdmin(userId: String, isAdmin: Boolean): SentientResult<UserSummary>
    suspend fun deleteUser(userId: String): SentientResult<Unit>
    suspend fun resetPin(userId: String, pin: String): SentientResult<Unit>
    suspend fun getSecretsStatus(): SentientResult<SecretsStatus>
    suspend fun setLlmProviderKey(provider: String, value: String?, baseUrl: String?): SentientResult<Unit>
    suspend fun setActiveLlmProvider(provider: String): SentientResult<Unit>
}

class SdkAdminRepository(private val admin: AdminHttpClient) : AdminRepository {
    override suspend fun listUsers(): SentientResult<List<UserSummary>> = admin.listUsers().toEnvelope()

    override suspend fun createUser(request: CreateUserRequest): SentientResult<UserSummary> =
        admin.createUser(request).toEnvelope()

    override suspend fun setUserAdmin(userId: String, isAdmin: Boolean): SentientResult<UserSummary> =
        admin.setUserAdmin(userId, isAdmin).toEnvelope()

    override suspend fun deleteUser(userId: String): SentientResult<Unit> = admin.deleteUser(userId).toEnvelope()

    override suspend fun resetPin(userId: String, pin: String): SentientResult<Unit> =
        admin.resetPin(userId, pin).toEnvelope()

    override suspend fun getSecretsStatus(): SentientResult<SecretsStatus> = admin.getSecretsStatus().toEnvelope()

    override suspend fun setLlmProviderKey(provider: String, value: String?, baseUrl: String?): SentientResult<Unit> =
        admin.setLlmProviderKey(provider, value, baseUrl).toEnvelope()

    override suspend fun setActiveLlmProvider(provider: String): SentientResult<Unit> =
        admin.setActiveLlmProvider(provider).toEnvelope()
}
