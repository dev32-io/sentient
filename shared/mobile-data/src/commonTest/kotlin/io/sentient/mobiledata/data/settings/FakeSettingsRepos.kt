// ---------------------------------------------------------------------------
// FakeSettingsRepos — in-memory repo fakes for the settings usecase tests. Fakes
// record calls into inspectable properties and return programmed results (the
// same contract the real repos honour). No MockEngine here — the usecases are
// tested against the repo interfaces per the module's fakes-over-mocks discipline.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthResponse
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.protocol.AuthUser
import io.sentient.mobilesdk.settings.ApplyResult
import io.sentient.mobilesdk.settings.CloneFromFishRequest
import io.sentient.mobilesdk.settings.CloneFromFishResult
import io.sentient.mobilesdk.settings.CreateUserRequest
import io.sentient.mobilesdk.settings.DevicesResponse
import io.sentient.mobilesdk.settings.FishResult
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.FishVoicePage
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.MemoryDoc
import io.sentient.mobilesdk.settings.MemorySlot
import io.sentient.mobilesdk.settings.ModelCatalog
import io.sentient.mobilesdk.settings.PersonalityList
import io.sentient.mobilesdk.settings.ProfileAdvanced
import io.sentient.mobilesdk.settings.ProfileAudio
import io.sentient.mobilesdk.settings.ProfileCompression
import io.sentient.mobilesdk.settings.ProfileModelRef
import io.sentient.mobilesdk.settings.ProfilePersona
import io.sentient.mobilesdk.settings.ProfileTools
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ProfileVoiceRef
import io.sentient.mobilesdk.settings.SecretsStatus
import io.sentient.mobilesdk.settings.ServicesVersions
import io.sentient.mobilesdk.settings.ServicesVersionsFeatures
import io.sentient.mobilesdk.settings.SignalLinkStartResponse
import io.sentient.mobilesdk.settings.SignalLinkStatusResponse
import io.sentient.mobilesdk.settings.SoulDefaultDoc
import io.sentient.mobilesdk.settings.SoulDoc
import io.sentient.mobilesdk.settings.UserSummary
import io.sentient.mobilesdk.settings.VoiceCreateResult
import io.sentient.mobilesdk.settings.VoiceDeleteResult
import io.sentient.mobilesdk.settings.VoiceSummary
import kotlinx.coroutines.delay

/** A fully-populated ProfileV1 for tests. Vary the args to build a diff. */
fun sampleProfile(
    ttsEnabled: Boolean = true,
    channel: String = "voice",
    modelId: String = "model-a",
    voiceId: String = "v1",
): ProfileV1 = ProfileV1(
    schemaVersion = 1,
    userId = "u1",
    model = ProfileModelRef(provider = "openrouter", id = modelId),
    voice = ProfileVoiceRef(provider = "local-tts", id = voiceId),
    audio = ProfileAudio(ttsEnabled = ttsEnabled, channel = channel),
    persona = ProfilePersona(template = "default", overrides = ""),
    tools = ProfileTools(enabled = emptyMap(), toolsets = null),
    compression = ProfileCompression(threshold = 0.5),
    advanced = ProfileAdvanced(extraSystemPrompt = "", maxTokens = 1024, reasoningEffort = "minimal"),
    devices = null,
)

/** ProfileRepository fake — programmable per-op, records calls + args for assertions. */
class FakeProfileRepository : ProfileRepository {
    // Programmable outcomes
    var getProfileResult: SentientResult<ProfileV1> = SentientResult.Success(sampleProfile())
    var putProfileResult: SentientResult<ProfileV1> = SentientResult.Success(sampleProfile())
    var applyResult: ApplyResult = ApplyResult.Ready(elapsedMs = 1_200)
    var soulResult: ApplyResult = ApplyResult.Ready(elapsedMs = 1_200)
    var memoryResult: ApplyResult = ApplyResult.Ready(elapsedMs = 1_200)
    var personalityWriteResult: ApplyResult = ApplyResult.Ready(elapsedMs = 1_200)
    var setActiveResult: SentientResult<Unit> = SentientResult.Success(Unit)
    /** When > 0, apply() suspends this long (virtual time) before returning — a slow-but-healthy restart. */
    var applyDelayMs: Long = 0

    // Recorders
    var putProfileCalls = 0
    var applyCalls = 0
    var lastPutProfile: ProfileV1? = null

    override suspend fun getProfile(): SentientResult<ProfileV1> = getProfileResult
    override suspend fun putProfile(profile: ProfileV1): SentientResult<ProfileV1> {
        putProfileCalls++
        lastPutProfile = profile
        return putProfileResult
    }
    override suspend fun apply(): ApplyResult {
        applyCalls++
        if (applyDelayMs > 0) delay(applyDelayMs)
        return applyResult
    }
    override suspend fun getSoul() = SentientResult.Success(SoulDoc(content = "soul"))
    override suspend fun getSoulDefault() = SentientResult.Success(SoulDefaultDoc(content = "default"))
    override suspend fun putSoul(content: String): ApplyResult = soulResult
    override suspend fun getMemory(slot: MemorySlot) =
        SentientResult.Success(MemoryDoc(content = "", charLimit = 2000))
    override suspend fun putMemory(slot: MemorySlot, content: String): ApplyResult = memoryResult
    override suspend fun listPersonalities() = SentientResult.Success(PersonalityList())
    override suspend fun createPersonality(name: String, body: String): ApplyResult = personalityWriteResult
    override suspend fun updatePersonality(name: String, body: String): ApplyResult = personalityWriteResult
    override suspend fun deletePersonality(name: String): ApplyResult = personalityWriteResult
    override suspend fun setActivePersonality(name: String): SentientResult<Unit> = setActiveResult
    override suspend fun getMcpCatalog() = SentientResult.Success(McpCatalogView())
    override suspend fun listModels() = SentientResult.Success(ModelCatalog())
}

/** VoicesRepository fake — only the bits the usecase tests exercise are programmable. */
class FakeVoicesRepository : VoicesRepository {
    var listResult: SentientResult<List<VoiceSummary>> = SentientResult.Success(emptyList())
    var servicesVersionsResult: SentientResult<ServicesVersions> =
        SentientResult.Success(ServicesVersions(features = ServicesVersionsFeatures(fishBrowseEnabled = true)))

    override suspend fun listVoices() = listResult
    override suspend fun createVoice(
        name: String,
        audioWav: ByteArray,
        description: String,
        tags: List<String>,
        language: String,
    ) = SentientResult.Success(VoiceCreateResult(voiceId = "v-new", name = name))
    override suspend fun deleteVoice(voiceId: String) = SentientResult.Success(VoiceDeleteResult(voiceId = voiceId))
    override suspend fun previewVoice(voiceId: String, lang: String) = SentientResult.Success(ByteArray(0))
    override suspend fun fishListVoices(title: String?, page: Int?): FishResult<FishVoicePage> =
        FishResult.Success(FishVoicePage())
    override suspend fun fishGetVoice(id: String): FishResult<FishVoiceEntry> =
        FishResult.Success(FishVoiceEntry(id = id, title = "t"))
    override suspend fun fishClone(fishVoiceId: String, request: CloneFromFishRequest): FishResult<CloneFromFishResult> =
        FishResult.Success(CloneFromFishResult(voiceId = "v-clone", name = request.name))
    override suspend fun servicesVersions() = servicesVersionsResult
}

/** AccountRepository fake. */
class FakeAccountRepository : AccountRepository {
    var meResult: SentientResult<AuthResponse> =
        SentientResult.Success(AuthResponse(token = "tok", user = AuthUser("u1", "Kev", isAdmin = false)))
    var updateResult: SentientResult<AuthResponse> = meResult
    var changePinResult: AuthResult<Unit> = AuthResult.Success(Unit)
    var logoutResult: SentientResult<Unit> = SentientResult.Success(Unit)

    override suspend fun me() = meResult
    override suspend fun updateDisplayName(displayName: String) = updateResult
    override suspend fun changePin(currentPin: String, newPin: String) = changePinResult
    override suspend fun logout() = logoutResult
}

/** DevicesRepository fake — pollLinkStatus reads programmed statuses in order. */
class FakeDevicesRepository(
    private val statuses: List<SentientResult<SignalLinkStatusResponse>> = emptyList(),
) : DevicesRepository {
    var statusCalls = 0

    override suspend fun getDevices() = SentientResult.Success(DevicesResponse())
    override suspend fun signalLinkStart() = SentientResult.Success(SignalLinkStartResponse(qrDataUrl = "data:x"))
    override suspend fun signalLinkCancel() = SentientResult.Success(Unit)
    override suspend fun signalLinkStatus(): SentientResult<SignalLinkStatusResponse> {
        val i = statusCalls.coerceAtMost(statuses.lastIndex)
        statusCalls++
        return statuses.getOrElse(i) { SentientResult.Success(SignalLinkStatusResponse(state = "idle")) }
    }
    override suspend fun signalUnlink() = SentientResult.Success(Unit)
}

/** AdminRepository fake — thin, all-success. */
class FakeAdminRepository : AdminRepository {
    override suspend fun listUsers() = SentientResult.Success(emptyList<UserSummary>())
    override suspend fun createUser(request: CreateUserRequest) =
        SentientResult.Success(UserSummary(userId = "u", displayName = request.displayName, isAdmin = request.isAdmin))
    override suspend fun setUserAdmin(userId: String, isAdmin: Boolean) =
        SentientResult.Success(UserSummary(userId = userId, displayName = "x", isAdmin = isAdmin))
    override suspend fun deleteUser(userId: String) = SentientResult.Success(Unit)
    override suspend fun resetPin(userId: String, pin: String) = SentientResult.Success(Unit)
    override suspend fun getSecretsStatus() = SentientResult.Success(sampleSecretsStatus())
    override suspend fun setLlmProviderKey(provider: String, value: String?, baseUrl: String?) =
        SentientResult.Success(Unit)
    override suspend fun setActiveLlmProvider(provider: String) = SentientResult.Success(Unit)
}

private fun sampleSecretsStatus(): SecretsStatus =
    SecretsStatus(llm = io.sentient.mobilesdk.settings.LlmSecretsStatus(active = "openrouter"))
