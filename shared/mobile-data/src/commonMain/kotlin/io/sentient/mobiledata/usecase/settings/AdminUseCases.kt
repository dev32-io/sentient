// ---------------------------------------------------------------------------
// AdminUseCases — admin member + secrets ops. createUser TEMPLATES a new
// member's ProfileBody off the caller's own live profile (ProfileRepository):
// the gateway requires model.id min-length 1 (profileV1Schema), but mobile's
// Add-member dialog collects only name + PIN — no model/voice picker like the
// webui AccountWizard has. Copying the caller's current model/voice/audio/
// compression/advanced verbatim guarantees a valid model.id; persona and
// extraSystemPrompt reset to a clean default so a new member never inherits
// the caller's persona or scratch prompt. Combining two repositories (Admin +
// Profile) belongs in a usecase per architecture.md, not a page ViewModel —
// see ios git history commit 57a1a43 for the prior VM-level version of this
// exact semantic, correctly flagged there as the VM reaching past its usecases.
//
// Plus the pure household-slot cap helper the "Add member" button gates on.
// The cap is enforced server-side (the provisioner rejects at capacity);
// [canAddUser] is the cosmetic client-side disable, mirroring webui
// members-pane.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.AdminRepository
import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.CreateUserRequest
import io.sentient.mobilesdk.settings.ProfileBody
import io.sentient.mobilesdk.settings.ProfilePersona
import io.sentient.mobilesdk.settings.ProfileTools
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.SecretsStatus
import io.sentient.mobilesdk.settings.UserSummary

/** Household worker-slot pool size — mirrors webui members-pane POOL_SIZE (gateway slot pool). */
const val HOUSEHOLD_POOL_SIZE: Int = 3

/** Persona template a new member starts from — never the caller's own persona/overrides. */
private const val NEW_MEMBER_PERSONA_TEMPLATE = "default"

class AdminUseCases(
    private val admin: AdminRepository,
    private val profile: ProfileRepository,
) {
    private val log = createLogger("data", "settings", "admin")

    suspend fun listUsers(): SentientResult<List<UserSummary>> = admin.listUsers()

    /**
     * Create a household member from name + PIN only. Templates the required
     * ProfileBody off the caller's own live profile (see file header). A
     * profile-fetch failure returns the typed failure unchanged and NEVER
     * falls through to a request with a blank model.id.
     */
    suspend fun createUser(displayName: String, pin: String, isAdmin: Boolean): SentientResult<UserSummary> {
        val template = when (val r = profile.getProfile()) {
            is SentientResult.Success -> r.data
            is SentientResult.Failure -> {
                log.warn("createUser.template.failed", mapOf("kind" to r.error.kind))
                return r
            }
            is SentientResult.Loading -> return SentientResult.Loading()
        }
        log.info("createUser", mapOf("isAdmin" to isAdmin)) // displayName/pin never logged
        val request = CreateUserRequest(
            displayName = displayName,
            pin = pin,
            isAdmin = isAdmin,
            profile = templateMemberProfile(template),
        )
        return admin.createUser(request)
    }

    suspend fun setUserAdmin(userId: String, isAdmin: Boolean): SentientResult<UserSummary> =
        admin.setUserAdmin(userId, isAdmin)

    suspend fun deleteUser(userId: String): SentientResult<Unit> = admin.deleteUser(userId)

    suspend fun resetPin(userId: String, pin: String): SentientResult<Unit> = admin.resetPin(userId, pin)

    suspend fun getSecretsStatus(): SentientResult<SecretsStatus> = admin.getSecretsStatus()

    suspend fun setLlmProviderKey(provider: String, value: String?, baseUrl: String?): SentientResult<Unit> {
        log.info("setLlmProviderKey", mapOf("provider" to provider, "hasKey" to (value != null))) // key never logged
        return admin.setLlmProviderKey(provider, value, baseUrl)
    }

    suspend fun setActiveLlmProvider(provider: String): SentientResult<Unit> = admin.setActiveLlmProvider(provider)
}

/** Free household slots given the current member count. */
fun householdSlotsFree(userCount: Int): Int = (HOUSEHOLD_POOL_SIZE - userCount).coerceAtLeast(0)

/** True when another member can be added (cap not reached). */
fun canAddUser(userCount: Int): Boolean = userCount < HOUSEHOLD_POOL_SIZE

/**
 * Build a new member's ProfileBody from the caller's live profile: keep
 * model/voice/audio/compression/advanced verbatim (guarantees a valid
 * model.id — the gateway requires min-length 1); reset persona to the default
 * template with no overrides and clear extraSystemPrompt, so a new member
 * never inherits the caller's persona or scratch prompt. tools.permissions
 * left UNSET (`null`, not `emptyMap()`) — a set-but-empty table would mean
 * "every server off"; `null` is "never configured", which is what lets the
 * gateway's applyProfileDefaults seed tools/toolsets for the new member
 * afterward (see ProfileTools.permissions's doc comment for the distinction).
 */
internal fun templateMemberProfile(from: ProfileV1): ProfileBody = ProfileBody(
    model = from.model,
    voice = from.voice,
    audio = from.audio,
    persona = ProfilePersona(template = NEW_MEMBER_PERSONA_TEMPLATE, overrides = ""),
    tools = ProfileTools(),
    compression = from.compression,
    advanced = from.advanced.copy(extraSystemPrompt = ""),
)
