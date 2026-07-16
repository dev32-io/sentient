// ---------------------------------------------------------------------------
// FishModels — mirror of the gated Fish Audio voice-library browse/clone routes
// (gateway/src/api/handlers/fish/fish-browse.ts + fish-clone.ts; webui
// gateway/webui/src/services/fish-api.ts). Every route 404s when the feature is
// disabled — modelled as the typed [FishResult.FeatureDisabled] state.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.sentient.mobilesdk.auth.AuthError
import kotlinx.serialization.Serializable

/** One Fish voice-library entry (mirror of gateway VoiceEntry). */
@Serializable
data class FishVoiceEntry(
    val id: String,
    val title: String,
    val description: String = "",
    val languages: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val coverImageUrl: String? = null,
    val previewAudioUrl: String? = null,
    val visibility: String = "public",
    val taskCount: Int = 0,
    val createdAt: String = "",
)

/** GET /api/v1/providers/voices → {voices, hasMore, stale}. */
@Serializable
data class FishVoicePage(
    val voices: List<FishVoiceEntry> = emptyList(),
    val hasMore: Boolean = false,
    val stale: Boolean = false,
)

/** GET /api/v1/providers/voices/:id → {voice:{...}}. */
@Serializable
internal data class FishVoiceEnvelope(val voice: FishVoiceEntry)

/** POST /api/v1/providers/voices/:fishVoiceId/clone body: {name, description, tags, language}. */
@Serializable
data class CloneFromFishRequest(
    val name: String,
    val description: String = "",
    val tags: List<String> = emptyList(),
    val language: String = "",
)

/**
 * Clone response → {voiceId, name} or {voiceId, name, warning:"not-activated"}.
 * `warning` present = cloned service-side but the local activation write failed;
 * the pack exists — a non-fatal notice, never a failure.
 */
@Serializable
data class CloneFromFishResult(val voiceId: String, val name: String, val warning: String? = null)

/**
 * Typed result for the gated Fish surface. [FeatureDisabled] is the 404-with-a
 * non-JSON body case (the gateway 404s all Fish routes when fishBrowseEnabled is
 * false); a JSON error 404 (voice-not-found) and every other non-2xx map to
 * [Failure].
 */
sealed class FishResult<out T> {
    data class Success<T>(val value: T) : FishResult<T>()

    /** 404 with a non-JSON body — the Fish browse/clone feature is off on this gateway. */
    data object FeatureDisabled : FishResult<Nothing>()

    data class Failure(val error: AuthError) : FishResult<Nothing>()
}
