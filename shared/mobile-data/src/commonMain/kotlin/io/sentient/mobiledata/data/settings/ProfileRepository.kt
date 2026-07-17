// ---------------------------------------------------------------------------
// ProfileRepository — stateless mapper over the profile-config datasource surface
// (ProfileHttpClient + ProfileEditHttpClient + ProvidersHttpClient).
//
// Reads/writes that carry a plain success/failure map into the module envelope
// [SentientResult]. Restart mutations (apply, soul/memory PUT, personality CRUD)
// pass their richer [ApplyResult] domain type THROUGH unchanged — 429
// apply-in-progress is a first-class product state the FSM folds, not an error the
// envelope can express. No combine, no accumulation here (that lives in usecases).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.ApplyResult
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.MemoryDoc
import io.sentient.mobilesdk.settings.MemorySlot
import io.sentient.mobilesdk.settings.ModelCatalog
import io.sentient.mobilesdk.settings.PersonalityList
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.SoulDefaultDoc
import io.sentient.mobilesdk.settings.SoulDoc

/** Stateless profile-config surface. Envelope for plain ops, [ApplyResult] for restart ops. */
interface ProfileRepository {
    // Core profile
    suspend fun getProfile(): SentientResult<ProfileV1>
    suspend fun putProfile(profile: ProfileV1): SentientResult<ProfileV1>
    suspend fun apply(): ApplyResult

    // Soul (system prompt)
    suspend fun getSoul(): SentientResult<SoulDoc>
    suspend fun getSoulDefault(): SentientResult<SoulDefaultDoc>
    suspend fun putSoul(content: String): ApplyResult

    // Memory (MEMORY.md / USER.md)
    suspend fun getMemory(slot: MemorySlot): SentientResult<MemoryDoc>
    suspend fun putMemory(slot: MemorySlot, content: String): ApplyResult

    // Personalities
    suspend fun listPersonalities(): SentientResult<PersonalityList>
    suspend fun createPersonality(name: String, body: String): ApplyResult
    suspend fun updatePersonality(name: String, body: String): ApplyResult
    suspend fun deletePersonality(name: String): ApplyResult
    suspend fun setActivePersonality(name: String): SentientResult<Unit>

    // Catalogs
    suspend fun getMcpCatalog(): SentientResult<McpCatalogView>
    suspend fun listModels(): SentientResult<ModelCatalog>
}
