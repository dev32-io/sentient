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
//
// tools.permissions is the ONE exception to "nullable class property -> omit
// when null" above: its LEAVES (inside the map, not the field itself) carry
// meaning through kotlinx.serialization's Map encoding, which is untouched by
// settingsBodyJson's explicitNulls=false (that setting only ever skips a
// null-valued CLASS property; a Map entry's null value is always encoded
// literally). That is exactly the mechanism ProfileToolsPatch relies on to
// send an explicit clear — see its doc comment.
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

/**
 * GET /api/v1/profile/me response, and the return value of a PUT. Mirrors
 * gateway's STORED ProfileV1 exactly — `tools` is the concrete-leaf
 * [ProfileTools], never [ProfileToolsPatch]. To WRITE a profile, build a
 * [ProfileV1PutBody] via [toPutBody] rather than sending this type directly —
 * [ProfileHttpClient.updateMe] only accepts the PUT-body shape.
 */
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

/**
 * Wire body for `PUT /api/v1/profile/me`. Field-for-field identical to
 * [ProfileV1] except `tools`, which is the patch-shaped [ProfileToolsPatch] —
 * see its doc comment for why a PUT needs a wider type than a GET ever
 * returns. Build one from a loaded [ProfileV1] via [toPutBody]; `schemaVersion`
 * / `userId` are server-assigned identity fields a caller must round-trip
 * verbatim, never invent.
 *
 * HAND-DUPLICATED from [ProfileV1], not derived — Kotlin data classes have no
 * `.extend()` the way the mirrored gateway zod schema does
 * (`profileV1PutBodySchema = profileV1Schema.extend({ tools: ... })`). This is
 * a silent trap, not a compile-time-caught one: a field added to [ProfileV1]
 * later will NOT fail to compile here — [toPutBody] just won't carry it
 * through, and that field will silently never round-trip on a PUT. Any future
 * [ProfileV1] field addition MUST add the same field here (and to [toPutBody])
 * by hand.
 */
@Serializable
data class ProfileV1PutBody(
    val schemaVersion: Int,
    val userId: String,
    val model: ProfileModelRef,
    val voice: ProfileVoiceRef,
    val audio: ProfileAudio,
    val persona: ProfilePersona,
    val tools: ProfileToolsPatch,
    val compression: ProfileCompression,
    val advanced: ProfileAdvanced,
)

/**
 * The identity conversion used by every write that carries no explicit
 * permission CLEAR — audio/model/voice/persona/advanced saves, and ordinary
 * concrete per-tool permission edits, all flow through this unchanged. A
 * concrete [ToolPermission] already satisfies "a permission to write, never a
 * clear", so [ProfileTools.permissions] passes straight through into
 * [ProfileToolsPatch.permissions] with no remapping (a non-null leaf is
 * always a valid patch leaf). Layer an explicit clear on top with
 * `.copy(tools = base.tools.copy(permissions = ...))` for the one case that
 * needs one (e.g. a "reset to role default" control).
 */
fun ProfileV1.toPutBody(): ProfileV1PutBody = ProfileV1PutBody(
    schemaVersion = schemaVersion,
    userId = userId,
    model = model,
    voice = voice,
    audio = audio,
    persona = persona,
    tools = ProfileToolsPatch(permissions = tools.permissions, toolsets = tools.toolsets),
    compression = compression,
    advanced = advanced,
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
 * `permissions`: per-tool permission, keyed by MCP server name -> tool name
 * (or the catalog's `wildcardPermissionKey`) -> a CONCRETE [ToolPermission].
 * Mirrors gateway's STORED `ProfileV1["tools"]["permissions"]` exactly.
 * Replaces the retired `enabled` narrowing-array map.
 *
 * `null` (the field itself absent) and `emptyMap()` are DIFFERENT, deliberate
 * statements — never collapse them:
 *   - `permissions == null`: NEVER SET. Every tool resolves from this
 *     person's ROLE TEMPLATE. A freshly-seeded profile looks exactly like
 *     this until somebody touches a permission — this is why an
 *     `enabled`-less (now every) response must still decode cleanly rather
 *     than requiring the field.
 *   - `permissions == emptyMap()`: a table naming no server — every server is
 *     OFF. Never default this to `emptyMap()` when building a request.
 *   - a TOOL missing under a PRESENT server: the role template answers for
 *     that one tool.
 *   - a SERVER missing from a non-empty table: the WHOLE server is OFF,
 *     forever — the role template never answers for it again. This is why
 *     nothing in this codebase deletes a server key to mean "off".
 *
 * TURNING A WHOLE SERVER OFF is a named `OFF` for every tool the catalog lists
 * under it PLUS the wildcard key — `withServerMasterPermission`
 * (ToolPermissionPatch.kt) is the one implementation. Writing ONLY the wildcard
 * is a no-op on any real account: every account is seeded with a named entry
 * per catalog tool its role can execute, and the resolver reads a tool's own
 * name before the wildcard. (Never hardcode the wildcard literal — read it off
 * `McpCatalogView.wildcardPermissionKey`.)
 *
 * NEVER a nullable-leaf map here — see [ProfileToolsPatch] for the PUT-body
 * shape whose leaves may be `null`, and why the two must stay separate types
 * rather than one type serving both the patch and the stored shape.
 *
 * `toolsets`: enabled Hermes built-in toolset names; optional (null when
 * absent — the renderer falls back to a lean default). Modelled as nullable +
 * null default so it is omitted, never sent as `null`, on updateMe.
 */
@Serializable
data class ProfileTools(
    val permissions: ToolPermissionMap? = null,
    val toolsets: List<String>? = null,
)

/**
 * PUT-body-only counterpart to [ProfileTools]. Every field matches
 * [ProfileTools] except `permissions`, whose leaves are [ToolPermissionPatchMap]
 * (each one a permission to WRITE, or `null` to CLEAR that stored key back to
 * "no stored opinion, let the role template answer again").
 *
 * This is a GENUINELY SEPARATE type from [ProfileTools], not the same map
 * typed nullable and reused for both directions — a caller holding a
 * [ProfileTools] (e.g. a loaded/"original" profile) can never accidentally
 * carry a `null` into what every other reader assumes is a concrete, resolved
 * permission; a caller building a WRITE reaches for this type instead, and
 * only for the one leaf that needs to widen. See [ProfileV1.toPutBody].
 */
@Serializable
data class ProfileToolsPatch(
    val permissions: ToolPermissionPatchMap? = null,
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
