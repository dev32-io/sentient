// ---------------------------------------------------------------------------
// SdkProfileRepository — SDK-backed ProfileRepository. Pure delegation: each op
// forwards to one client call and maps the AuthResult arm into the envelope (or
// passes the ApplyResult through). No state, no fold, no combine.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.ApplyResult
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.MemoryDoc
import io.sentient.mobilesdk.settings.MemorySlot
import io.sentient.mobilesdk.settings.ModelCatalog
import io.sentient.mobilesdk.settings.PersonalityList
import io.sentient.mobilesdk.settings.ProfileEditHttpClient
import io.sentient.mobilesdk.settings.ProfileHttpClient
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ProvidersHttpClient
import io.sentient.mobilesdk.settings.SoulDefaultDoc
import io.sentient.mobilesdk.settings.SoulDoc

class SdkProfileRepository(
    private val profile: ProfileHttpClient,
    private val edit: ProfileEditHttpClient,
    private val providers: ProvidersHttpClient,
) : ProfileRepository {

    override suspend fun getProfile(): SentientResult<ProfileV1> = profile.getMe().toEnvelope()

    override suspend fun putProfile(profile: ProfileV1): SentientResult<ProfileV1> =
        this.profile.updateMe(profile).toEnvelope()

    override suspend fun apply(): ApplyResult = profile.apply()

    override suspend fun getSoul(): SentientResult<SoulDoc> = edit.getSoul().toEnvelope()

    override suspend fun getSoulDefault(): SentientResult<SoulDefaultDoc> = edit.getSoulDefault().toEnvelope()

    override suspend fun putSoul(content: String): ApplyResult = edit.putSoul(content)

    override suspend fun getMemory(slot: MemorySlot): SentientResult<MemoryDoc> =
        edit.getMemory(slot).toEnvelope()

    override suspend fun putMemory(slot: MemorySlot, content: String): ApplyResult =
        edit.putMemory(slot, content)

    override suspend fun listPersonalities(): SentientResult<PersonalityList> =
        edit.listPersonalities().toEnvelope()

    override suspend fun createPersonality(name: String, body: String): ApplyResult =
        edit.createPersonality(name, body)

    override suspend fun updatePersonality(name: String, body: String): ApplyResult =
        edit.updatePersonality(name, body)

    override suspend fun deletePersonality(name: String): ApplyResult = edit.deletePersonality(name)

    override suspend fun setActivePersonality(name: String): SentientResult<Unit> =
        edit.setActivePersonality(name).toEnvelope()

    override suspend fun getMcpCatalog(): SentientResult<McpCatalogView> = profile.getMcpCatalog().toEnvelope()

    override suspend fun listModels(): SentientResult<ModelCatalog> = providers.listModels().toEnvelope()
}
