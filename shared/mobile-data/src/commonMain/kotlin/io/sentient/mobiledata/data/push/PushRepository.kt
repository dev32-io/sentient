package io.sentient.mobiledata.data.push

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.push.*

/** Authenticated, stateless per-device settings transport. Logout coordination is installation-owned in the SDK. */
interface PushRepository {
    suspend fun register(request: PushRegistrationRequest): SentientResult<PushRegistrationResponse>
    suspend fun get(installationId: String): SentientResult<PushBinding>
    suspend fun patch(request: PushPreferencePatchRequest): SentientResult<PushBinding>
}
class SdkPushRepository(private val client: PushHttpClient) : PushRepository {
    override suspend fun register(request: PushRegistrationRequest) = client.register(request).toPushResult()
    override suspend fun get(installationId: String) = client.preferences(installationId).toPushResult().map { it.binding }
    override suspend fun patch(request: PushPreferencePatchRequest) = client.patchPreferences(request).toPushResult().map { it.binding }
}
private inline fun <T : Any, R : Any> SentientResult<T>.map(transform: (T) -> R): SentientResult<R> = when (this) {
    is SentientResult.Success -> SentientResult.Success(transform(data))
    is SentientResult.Failure -> this
    is SentientResult.Loading -> SentientResult.Loading(partial?.let(transform))
}
