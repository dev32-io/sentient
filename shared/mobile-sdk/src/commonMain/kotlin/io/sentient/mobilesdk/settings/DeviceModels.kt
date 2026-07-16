// ---------------------------------------------------------------------------
// DeviceModels — mirror of the /api/v1/devices* response shapes
// (gateway/src/api/handlers/devices.ts). Signal is the only platform today.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Signal pairing state embedded in the devices list + profile.devices. */
@Serializable
data class DeviceSignal(
    val paired: Boolean = false,
    @SerialName("account_masked") val accountMasked: String? = null,
    @SerialName("linked_at") val linkedAt: String? = null,
)

@Serializable
data class DevicesPlatforms(val signal: DeviceSignal = DeviceSignal())

/** GET /api/v1/devices → {platforms:{signal:{...}}}. */
@Serializable
data class DevicesResponse(val platforms: DevicesPlatforms = DevicesPlatforms())

/**
 * POST /api/v1/devices/signal/link → {qrDataUrl, expiresAt}. `qrDataUrl` is a
 * data: URI PNG of the linking QR (also usable as the sgnl:// deep-link target
 * on the same device). `expiresAt` is epoch ms.
 */
@Serializable
data class SignalLinkStartResponse(val qrDataUrl: String, val expiresAt: Long? = null)

/**
 * GET /api/v1/devices/signal/link/status → {state, account_masked?, error?}.
 * `state` is one of the pairing-coordinator states plus "idle" / "linked".
 */
@Serializable
data class SignalLinkStatusResponse(
    val state: String,
    @SerialName("account_masked") val accountMasked: String? = null,
    val error: String? = null,
)
