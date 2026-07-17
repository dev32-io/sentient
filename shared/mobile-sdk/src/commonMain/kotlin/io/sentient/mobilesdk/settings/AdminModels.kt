// ---------------------------------------------------------------------------
// AdminModels — mirror of the /api/v1/admin/* wire shapes
// (gateway/src/api/handlers/admin.ts + secrets.ts). Admin-only surface: member
// management + LLM/integration secrets STATUS (never key material — GET returns
// booleans only; PUT bodies are write-only and never logged).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One member row. `port` is the user's Hermes worker slot; `createdAt` is ISO-8601. */
@Serializable
data class UserSummary(
    val userId: String,
    val displayName: String,
    val isAdmin: Boolean,
    val avatarTint: String = "",
    val port: Int = 0,
    val createdAt: String = "",
)

/** GET /api/v1/admin/users → {users:[...]}. */
@Serializable
internal data class UserListResponse(val users: List<UserSummary> = emptyList())

/** POST/PATCH admin user → {user:{...}}. */
@Serializable
internal data class UserEnvelope(val user: UserSummary)

/**
 * Profile body for POST /api/v1/admin/users — ProfileV1 minus the server-stamped
 * `userId` + `schemaVersion` (both spliced in by the gateway). The provisioner
 * runs applyProfileDefaults afterward, filling tools/toolsets if absent.
 */
@Serializable
data class ProfileBody(
    val model: ProfileModelRef,
    val voice: ProfileVoiceRef,
    val audio: ProfileAudio,
    val persona: ProfilePersona,
    val tools: ProfileTools,
    val compression: ProfileCompression,
    val advanced: ProfileAdvanced,
)

/** POST /api/v1/admin/users body: {displayName, pin, isAdmin, profile}. */
@Serializable
data class CreateUserRequest(
    val displayName: String,
    val pin: String,
    val isAdmin: Boolean,
    val profile: ProfileBody,
)

/** PATCH /api/v1/admin/users/:id body: {isAdmin}. */
@Serializable
internal data class PatchUserRequest(val isAdmin: Boolean)

/** POST /api/v1/admin/users/:id/reset-pin body: {pin}. */
@Serializable
internal data class ResetPinRequest(val pin: String)

/** Presence flags for one LLM provider — NEVER the key value. */
@Serializable
data class LlmProviderStatus(
    @SerialName("has_key") val hasKey: Boolean = false,
    @SerialName("has_base_url") val hasBaseUrl: Boolean = false,
)

@Serializable
data class LlmSecretsStatus(
    val active: String,
    @SerialName("ollama_cloud") val ollamaCloud: LlmProviderStatus = LlmProviderStatus(),
    val openrouter: LlmProviderStatus = LlmProviderStatus(),
    val custom: LlmProviderStatus = LlmProviderStatus(),
)

@Serializable
data class TokenPresence(@SerialName("has_token") val hasToken: Boolean = false)

@Serializable
data class HomeAssistantStatus(
    val url: String? = null,
    @SerialName("observe_token") val observeToken: TokenPresence = TokenPresence(),
    @SerialName("mcp_server_token") val mcpServerToken: TokenPresence = TokenPresence(),
)

@Serializable
data class MusicAssistantStatus(
    val url: String? = null,
    @SerialName("has_token") val hasToken: Boolean = false,
)

/** GET /api/v1/admin/secrets — boolean presence only, no key material. */
@Serializable
data class SecretsStatus(
    val llm: LlmSecretsStatus,
    @SerialName("home_assistant") val homeAssistant: HomeAssistantStatus = HomeAssistantStatus(),
    @SerialName("music_assistant") val musicAssistant: MusicAssistantStatus = MusicAssistantStatus(),
)

/**
 * PUT /api/v1/admin/secrets/llm/{provider} body. At least one of value/base_url
 * must be present; "" clears that field, undefined (null → omitted) leaves it.
 * Write-only — never logged.
 */
@Serializable
internal data class LlmKeyPatchRequest(
    val value: String? = null,
    @SerialName("base_url") val baseUrl: String? = null,
)

/** PUT /api/v1/admin/secrets/llm/active body: {provider}. */
@Serializable
internal data class ActiveProviderRequest(val provider: String)
