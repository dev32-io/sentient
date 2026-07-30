// ---------------------------------------------------------------------------
// ProfileModels — kotlinx.serialization mirror of the gateway ProfileV1 schema
// (gateway/src/profile-store/profile-types.ts `profileV1Schema`), field-for-field.
//
// Enum-like fields (model.provider, voice.provider, audio.channel,
// advanced.reasoningEffort) are typed as String, NOT Kotlin enums, so an unknown
// value the gateway adds later (a new provider / reasoning level) decodes cleanly
// and round-trips through updateMe untouched — mirroring the web-sdk resilience
// contract. Canonical value sets live in [ProfileEnums] for the UI layer.
//
// Optional zod fields (tools.toolsets) are nullable with null defaults;
// settingsBodyJson omits nulls on the way back out so `.optional()` validation
// passes. A snake_case wire field would need an explicit @SerialName.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.Serializable

/** Canonical value sets for the string-typed profile fields (UI selectors). */
object ProfileEnums {
    val modelProviders: List<String> = listOf("openrouter", "ollama-cloud", "custom")
    const val VOICE_PROVIDER: String = "local-tts"
    val audioChannels: List<String> = listOf("voice", "text")
    val reasoningEfforts: List<String> = listOf("none", "minimal", "low", "medium", "high", "xhigh")
}

/** GET/PUT /api/v1/profile/me body. Mirrors gateway ProfileV1 exactly. */
@Serializable
data class ProfileV1(
    val schemaVersion: Int,
    val userId: String,
    val model: ProfileModelRef,
    val voice: ProfileVoiceRef,
    val audio: ProfileAudio,
    val persona: ProfilePersona,
    val tools: ProfileTools,
    val compression: ProfileCompression,
    val advanced: ProfileAdvanced,
)

@Serializable
data class ProfileModelRef(val provider: String, val id: String)

@Serializable
data class ProfileVoiceRef(val provider: String, val id: String)

@Serializable
data class ProfileAudio(val ttsEnabled: Boolean, val channel: String)

@Serializable
data class ProfilePersona(val template: String, val overrides: String)

/**
 * `enabled`: per-MCP-server tool whitelist (server name → narrowed tool names;
 * `[]` = inherit the operator default). `toolsets`: enabled Hermes built-in
 * toolset names; optional (null when absent — the renderer falls back to a lean
 * default). Modelled as nullable + null default so it is omitted, never sent as
 * `null`, on updateMe.
 */
@Serializable
data class ProfileTools(
    val enabled: Map<String, List<String>>,
    val toolsets: List<String>? = null,
)

@Serializable
data class ProfileCompression(val threshold: Double)

@Serializable
data class ProfileAdvanced(
    val extraSystemPrompt: String,
    val maxTokens: Int,
    val reasoningEffort: String,
)
