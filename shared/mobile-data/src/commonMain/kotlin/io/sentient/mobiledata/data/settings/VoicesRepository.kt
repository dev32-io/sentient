// ---------------------------------------------------------------------------
// VoicesRepository — stateless mapper over the voice-library datasource
// (VoicesHttpClient + FishHttpClient + ServicesVersionsHttpClient).
//
// Household-voice ops map into the module envelope. The gated Fish surface passes
// its [FishResult] domain type THROUGH — FeatureDisabled is a first-class product
// state (feature off on this gateway), not an error the envelope can express; the
// usecase folds it. No combine here.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.CloneFromFishRequest
import io.sentient.mobilesdk.settings.CloneFromFishResult
import io.sentient.mobilesdk.settings.FishResult
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.FishVoicePage
import io.sentient.mobilesdk.settings.ServicesVersions
import io.sentient.mobilesdk.settings.VoiceCreateResult
import io.sentient.mobilesdk.settings.VoiceDeleteResult
import io.sentient.mobilesdk.settings.VoiceSummary

/** Stateless voice-library surface. Envelope for household voices, [FishResult] for the gated Fish routes. */
interface VoicesRepository {
    // Household voice library
    suspend fun listVoices(): SentientResult<List<VoiceSummary>>
    suspend fun createVoice(
        name: String,
        audioWav: ByteArray,
        description: String,
        tags: List<String>,
        language: String,
    ): SentientResult<VoiceCreateResult>
    suspend fun deleteVoice(voiceId: String): SentientResult<VoiceDeleteResult>
    suspend fun previewVoice(voiceId: String, lang: String): SentientResult<ByteArray>

    // Gated Fish Audio browse/clone
    suspend fun fishListVoices(title: String?, page: Int?): FishResult<FishVoicePage>
    suspend fun fishGetVoice(id: String): FishResult<FishVoiceEntry>
    suspend fun fishClone(fishVoiceId: String, request: CloneFromFishRequest): FishResult<CloneFromFishResult>

    // Feature flags + version chips
    suspend fun servicesVersions(): SentientResult<ServicesVersions>
}
