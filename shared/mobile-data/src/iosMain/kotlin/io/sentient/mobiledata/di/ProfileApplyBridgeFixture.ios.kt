package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyProfileChangeUseCase
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.*

/** IO-free native regression fixture. No session, auth, transport or runtime policy.
 * PUT commits before the real shared usecase emits Restarting; Apply can fail later.
 * The concrete permission patch below is synthetic storage, not a permission resolver.
 */
class ProfileApplyBridgeFixture(initial: ProfileV1) {
    var stored: ProfileV1 = initial
        private set
    var putCalls: Int = 0
        private set
    var applyCalls: Int = 0
        private set
    var failRead: Boolean = false
    var failPut: Boolean = false
    var outcome: ApplyResult = ApplyResult.Failed(422, "render-error")

    fun read(): SentientResult<ProfileV1> = if (failRead) {
        SentientResult.Failure(SentientError.Connection("Synthetic read failure"))
    } else {
        SentientResult.Success(stored)
    }

    val useCase = ApplyProfileChangeUseCase(object : ProfileRepository {
        override suspend fun getProfile() = read()
        override suspend fun putProfile(profile: ProfileV1PutBody): SentientResult<ProfileV1> {
            putCalls++
            if (failPut) return SentientResult.Failure(SentientError.Connection("Synthetic PUT failure"))
            val permissions = profile.tools.permissions?.mapValues { (_, tools) ->
                tools.mapNotNull { (name, permission) -> permission?.let { name to it } }.toMap()
            }
            stored = ProfileV1(
                profile.schemaVersion, profile.userId, profile.model, profile.voice,
                profile.audio, profile.persona, ProfileTools(permissions, profile.tools.toolsets),
                profile.compression, profile.advanced, profile.auxiliaryModels, profile.memory,
            )
            return SentientResult.Success(stored)
        }
        override suspend fun apply(): ApplyResult { applyCalls++; return outcome }
        override suspend fun getSoul(): SentientResult<SoulDoc> = error("Unused fixture boundary")
        override suspend fun getSoulDefault(): SentientResult<SoulDefaultDoc> = error("Unused fixture boundary")
        override suspend fun putSoul(content: String): ApplyResult = error("Unused fixture boundary")
        override suspend fun getMemory(slot: MemorySlot): SentientResult<MemoryDoc> = error("Unused fixture boundary")
        override suspend fun putMemory(slot: MemorySlot, content: String): ApplyResult = error("Unused fixture boundary")
        override suspend fun listPersonalities(): SentientResult<PersonalityList> = error("Unused fixture boundary")
        override suspend fun createPersonality(name: String, body: String): ApplyResult = error("Unused fixture boundary")
        override suspend fun updatePersonality(name: String, body: String): ApplyResult = error("Unused fixture boundary")
        override suspend fun deletePersonality(name: String): ApplyResult = error("Unused fixture boundary")
        override suspend fun setActivePersonality(name: String): SentientResult<Unit> = error("Unused fixture boundary")
        override suspend fun getMcpCatalog(): SentientResult<McpCatalogView> = error("Unused fixture boundary")
        override suspend fun listModels(): SentientResult<ModelCatalog> = error("Unused fixture boundary")
    }) { error("Non-audio fixture must use the two-stage boundary") }
}
