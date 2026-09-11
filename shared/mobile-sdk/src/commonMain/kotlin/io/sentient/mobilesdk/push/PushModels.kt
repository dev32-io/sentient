package io.sentient.mobilesdk.push

import io.sentient.mobilesdk.secure.DeviceIdProvider
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.time.Instant

const val PUSH_REGISTRATIONS_ROUTE = "/api/v1/push/registrations"
const val PUSH_PREFERENCES_ROUTE = "/api/v1/push/preferences"
const val PUSH_REVOCATIONS_ROUTE = "/api/v1/push/revocations"

@Serializable enum class PushPreviewMode { @SerialName("hidden") HIDDEN, @SerialName("content") CONTENT }
@Serializable enum class PushBindingState {
    @SerialName("active") ACTIVE,
    @SerialName("disabled") DISABLED,
    @SerialName("pending-old-binding-disable") PENDING_OLD_BINDING_DISABLE,
}
@Serializable data class PushPreferences(val enabled: Boolean, val previewMode: PushPreviewMode, val revision: Int)
@Serializable data class PushBindingReference(val bindingId: String, val generation: Int)
@Serializable data class PushBinding(
    val bindingId: String,
    val installationId: String,
    val platform: String,
    val generation: Int,
    val state: PushBindingState,
    val replaces: PushBindingReference? = null,
    val preferences: PushPreferences,
    val createdAt: String,
    val updatedAt: String,
)
@Serializable data class PushRevocationAuthority(val bindingId: String, val generation: Int, val credential: String, val expiresAt: String)
@Serializable data class PushRegistrationRequest(
    val idempotencyKey: String,
    val installationId: String,
    val platform: String,
    val apnsDeviceToken: String,
    val replaces: PushBindingReference? = null,
)
@Serializable data class PushRegistrationResponse(val binding: PushBinding, val revocation: PushRevocationAuthority, val replayed: Boolean)
@Serializable data class PushPreferenceGetResponse(val binding: PushBinding)
@Serializable data class PushPreferenceChanges(val enabled: Boolean? = null, val previewMode: PushPreviewMode? = null)
@Serializable data class PushPreferencePatchRequest(
    val bindingId: String,
    val generation: Int,
    val expectedRevision: Int,
    val changes: PushPreferenceChanges,
)
@Serializable data class PushPreferencePatchResponse(val binding: PushBinding)
@Serializable data class PushRevokeRequest(
    val idempotencyKey: String,
    val bindingId: String,
    val generation: Int,
    val revocationCredential: String,
)
@Serializable enum class PushRevocationStatus { @SerialName("revoked") REVOKED, @SerialName("already-revoked") ALREADY_REVOKED }
@Serializable data class PushRevokeAcknowledgement(
    val bindingId: String,
    val generation: Int,
    val status: PushRevocationStatus,
    val acknowledgedAt: String,
)
@Serializable data class PushPendingUnlink(
    val state: String,
    val request: PushRevokeRequest,
    val deliveryMayContinue: Boolean,
)
@Serializable data class PushDeliveryPayload(
    val bindingId: String,
    val generation: Int,
    val sessionId: String,
    val title: String,
    val mode: PushPreviewMode,
    val body: String? = null,
)

/** Platform-neutral settings hooks. Permission and APNs operations remain native-owned. */
enum class PushPermissionStatus { NOT_DETERMINED, DENIED, AUTHORIZED, PROVISIONAL, UNAVAILABLE }
data class PushNativeStatus(val permission: PushPermissionStatus, val tokenAvailable: Boolean, val registrationPending: Boolean)
fun interface PushRegistrationRequester { fun requestRegistration() }
fun interface PushSystemSettingsOpener { fun openSettings() }
data class PushSessionDestination(val sessionId: String) { init { require(sessionId.isNotBlank()) } }

/** Builds registration requests from the established installation identifier. */
class PushRegistrationRequestFactory(private val deviceIdProvider: DeviceIdProvider) {
    fun create(
        idempotencyKey: String,
        apnsDeviceToken: String,
        replaces: PushBindingReference? = null,
    ): PushRegistrationRequest = PushRegistrationRequest(
        idempotencyKey = idempotencyKey,
        installationId = deviceIdProvider.getOrCreate(),
        platform = "ios",
        apnsDeviceToken = apnsDeviceToken,
        replaces = replaces,
    ).also(PushRegistrationRequest::validate)
}

internal fun PushBindingReference.validate() { require(bindingId.isNotBlank() && generation > 0) }
internal fun PushBinding.validate() {
    require(bindingId.isNotBlank() && installationId.isNotBlank() && installationId.length <= 200 && platform == "ios" && generation > 0)
    require(preferences.revision > 0 && createdAt.isPushInstant() && updatedAt.isPushInstant())
    when (state) {
        PushBindingState.ACTIVE -> replaces?.validate()
        PushBindingState.DISABLED -> require(replaces == null)
        PushBindingState.PENDING_OLD_BINDING_DISABLE -> requireNotNull(replaces).validate()
    }
}
internal fun PushRegistrationRequest.validate() {
    require(idempotencyKey.isNotBlank() && idempotencyKey.length <= 200)
    require(installationId.isNotBlank() && installationId.length <= 200 && platform == "ios")
    require(Regex("^[A-Fa-f0-9]{64,200}$").matches(apnsDeviceToken)); replaces?.validate()
}
internal fun PushRegistrationResponse.validate() {
    binding.validate(); require(revocation.bindingId == binding.bindingId && revocation.generation == binding.generation)
    require(revocation.credential.isNotBlank() && revocation.expiresAt.isPushInstant())
}
internal fun PushPreferencePatchRequest.validate() {
    require(bindingId.isNotBlank() && generation > 0 && expectedRevision > 0)
    require(changes.enabled != null || changes.previewMode != null)
}
internal fun PushRevokeRequest.validate() { require(idempotencyKey.isNotBlank() && idempotencyKey.length <= 200 && bindingId.isNotBlank() && generation > 0 && revocationCredential.isNotBlank()) }
internal fun PushRevokeAcknowledgement.validate() { require(bindingId.isNotBlank() && generation > 0 && acknowledgedAt.isPushInstant()) }
internal fun PushPendingUnlink.validate() { require(state == "pending-unlink" && deliveryMayContinue); request.validate() }
internal fun PushDeliveryPayload.validate() {
    require(bindingId.isNotBlank() && generation > 0 && sessionId.isNotBlank() && title == "New message")
    require(if (mode == PushPreviewMode.HIDDEN) body == null else !body.isNullOrBlank() && body.length <= 280)
}
private fun String.isPushInstant() =
    Regex("^\\d{4}-\\d{2}-\\d{2}T.+(?:Z|[+-]\\d{2}:\\d{2})$").matches(this) && runCatching { Instant.parse(this) }.isSuccess
