// ---------------------------------------------------------------------------
// SdkVoicesRepository — SDK-backed VoicesRepository. Pure delegation: household
// voice ops map their AuthResult into the envelope; Fish ops pass FishResult
// through; services-versions maps into the envelope. No state, no fold.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.CloneFromFishRequest
import io.sentient.mobilesdk.settings.CloneFromFishResult
import io.sentient.mobilesdk.settings.FishHttpClient
import io.sentient.mobilesdk.settings.FishResult
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.FishVoicePage
import io.sentient.mobilesdk.settings.ServicesVersions
import io.sentient.mobilesdk.settings.ServicesVersionsHttpClient
import io.sentient.mobilesdk.settings.VoiceCreateResult
import io.sentient.mobilesdk.settings.VoiceDeleteResult
import io.sentient.mobilesdk.settings.VoiceSummary
import io.sentient.mobilesdk.settings.VoicesHttpClient

class SdkVoicesRepository(
    private val voices: VoicesHttpClient,
    private val fish: FishHttpClient,
    private val servicesVersions: ServicesVersionsHttpClient,
) : VoicesRepository {

    override suspend fun listVoices(): SentientResult<List<VoiceSummary>> = voices.list().toEnvelope()

    override suspend fun createVoice(
        name: String,
        audioWav: ByteArray,
        description: String,
        tags: List<String>,
        language: String,
    ): SentientResult<VoiceCreateResult> =
        voices.create(name, audioWav, description, tags, language).toEnvelope()

    override suspend fun deleteVoice(voiceId: String): SentientResult<VoiceDeleteResult> =
        voices.delete(voiceId).toEnvelope()

    override suspend fun previewVoice(voiceId: String, lang: String): SentientResult<ByteArray> =
        voices.preview(voiceId, lang).toEnvelope()

    override suspend fun fishListVoices(title: String?, page: Int?): FishResult<FishVoicePage> =
        fish.listVoices(title, page)

    override suspend fun fishGetVoice(id: String): FishResult<FishVoiceEntry> = fish.getVoice(id)

    override suspend fun fishClone(fishVoiceId: String, request: CloneFromFishRequest): FishResult<CloneFromFishResult> =
        fish.clone(fishVoiceId, request)

    override suspend fun servicesVersions(): SentientResult<ServicesVersions> = servicesVersions.get().toEnvelope()
}
