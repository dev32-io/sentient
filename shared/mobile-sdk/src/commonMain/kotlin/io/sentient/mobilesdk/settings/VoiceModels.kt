// ---------------------------------------------------------------------------
// VoiceModels — mirror of the /api/v1/voices response shapes
// (gateway/src/api/handlers/voices.ts + providers/tts/local-tts-protocol.ts
// LocalTtsVoiceInfo). Also carries the create-form field caps so the UI can
// enforce them client-side (the gateway TRUNCATES over-cap metadata rather than
// rejecting — see field-limits.ts — so client-side enforcement is cosmetic).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.Serializable

/**
 * One voice pack. `createdAt` is Unix epoch SECONDS (float) — the TTS service's
 * `time.time()`, NOT milliseconds. `source` is "builtin" | "user".
 */
@Serializable
data class VoiceSummary(
    val voiceId: String,
    val name: String,
    val description: String = "",
    val tags: List<String> = emptyList(),
    val language: String = "",
    val source: String = "user",
    val createdAt: Double = 0.0,
    val refDurationMs: Double = 0.0,
)

/** GET /api/v1/voices → {voices:[...]}. */
@Serializable
internal data class VoiceListResponse(val voices: List<VoiceSummary> = emptyList())

/**
 * POST /api/v1/voices → {voiceId, name} or {voiceId, name, warning:"not-activated"}.
 * `warning` present = created service-side but the local activation write failed;
 * the pack exists — surface a non-fatal notice, never a failure.
 */
@Serializable
data class VoiceCreateResult(val voiceId: String, val name: String, val warning: String? = null)

/**
 * DELETE /api/v1/voices/:id → {voiceId} or {voiceId, warning:"profile-not-updated"}.
 */
@Serializable
data class VoiceDeleteResult(val voiceId: String, val warning: String? = null)

/**
 * Voice create-form field caps. Defaults mirror shared/config ttsConfigSchema
 * (`voice_description_max_len` / `voice_tag_max_len` / `voice_max_tags`) and the
 * `VOICE_NAME_MAX_LEN` code constant. Operators can override the server-side
 * values; because over-cap input truncates rather than rejects, using these
 * defaults client-side is always safe.
 */
object VoiceFieldCaps {
    const val NAME_MAX_LEN: Int = 64
    const val DESCRIPTION_MAX_LEN: Int = 12000
    const val TAG_MAX_LEN: Int = 24
    const val MAX_TAGS: Int = 8
}
