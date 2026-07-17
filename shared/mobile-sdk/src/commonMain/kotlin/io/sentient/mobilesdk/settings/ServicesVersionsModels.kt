// ---------------------------------------------------------------------------
// ServicesVersionsModels — mirror of GET /api/v1/services/versions
// (gateway/src/api/handlers/services-versions.ts). Mobile gates the Fish UI on
// features.fish_browse_enabled.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Namespaced feature-flag block. Unknown future flags decode away (client Json
 * uses ignoreUnknownKeys); add fields here as the gateway grows them.
 */
@Serializable
data class ServicesVersionsFeatures(
    @SerialName("fish_browse_enabled") val fishBrowseEnabled: Boolean = false,
)

/**
 * GET /api/v1/services/versions → {gateway, hermes, stt_service, tts_service, features}.
 * Any service field may be "unknown" when the orchestrator is unavailable.
 */
@Serializable
data class ServicesVersions(
    val gateway: String = "unknown",
    val hermes: String = "unknown",
    @SerialName("stt_service") val sttService: String = "unknown",
    @SerialName("tts_service") val ttsService: String = "unknown",
    val features: ServicesVersionsFeatures = ServicesVersionsFeatures(),
)
