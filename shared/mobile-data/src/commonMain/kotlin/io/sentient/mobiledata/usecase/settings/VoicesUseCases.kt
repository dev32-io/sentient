// ---------------------------------------------------------------------------
// VoicesUseCases — voice-library business logic: list+filter, preview, pick-active
// (read-modify-write profile), create, delete, and the gated Fish browse/clone.
//
// pick-active is a FAST op: it PUTs the profile's voice only — NO worker restart
// and NO live-preference patch (the gateway refreshes the active voice server-side
// on the profile PUT; verified against webui use-voices setActiveVoice). The pure
// filter (filterVoices) is unit-tested in VoiceFilter's tests, not here.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.data.settings.VoicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.CloneFromFishRequest
import io.sentient.mobilesdk.settings.CloneFromFishResult
import io.sentient.mobilesdk.settings.FishResult
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.FishVoicePage
import io.sentient.mobilesdk.settings.ProfileEnums
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ProfileVoiceRef
import io.sentient.mobilesdk.settings.VoiceCreateResult
import io.sentient.mobilesdk.settings.VoiceDeleteResult
import io.sentient.mobilesdk.settings.VoiceSummary
import io.sentient.mobilesdk.settings.toPutBody

class VoicesUseCases(
    private val voices: VoicesRepository,
    private val profile: ProfileRepository,
) {
    private val log = createLogger("data", "settings", "voices")

    /** Fetch the shared library and apply the client-side [filter] (search / tags / language). */
    suspend fun listFiltered(filter: VoiceFilterState = VoiceFilterState()): SentientResult<List<VoiceSummary>> =
        when (val r = voices.listVoices()) {
            is SentientResult.Success -> {
                val filtered = filterVoices(r.data, filter)
                log.debug("listFiltered", mapOf("total" to r.data.size, "shown" to filtered.size))
                SentientResult.Success(filtered)
            }
            is SentientResult.Failure -> r
            is SentientResult.Loading -> r
        }

    /** Fetch a live-synth WAV preview for [voiceId] in [lang] (bytes, never logged). */
    suspend fun preview(voiceId: String, lang: String): SentientResult<ByteArray> = voices.previewVoice(voiceId, lang)

    /**
     * Pick the active voice: read the profile, swap `voice.id`, PUT it. FAST — no
     * restart, no live patch (server refreshes the active voice on the PUT). Returns
     * the saved profile so the VM can re-anchor its draft.
     */
    suspend fun pickActive(voiceId: String): SentientResult<ProfileV1> =
        when (val cur = profile.getProfile()) {
            is SentientResult.Success -> {
                log.info("pickActive", mapOf("voiceId" to voiceId))
                val next = cur.data.copy(voice = ProfileVoiceRef(ProfileEnums.VOICE_PROVIDER, voiceId))
                profile.putProfile(next.toPutBody())
            }
            is SentientResult.Failure -> cur
            is SentientResult.Loading -> cur
        }

    /** Create a voice from a recorded/uploaded WAV clip (creating activates it server-side). */
    suspend fun create(
        name: String,
        audioWav: ByteArray,
        description: String,
        tags: List<String>,
        language: String,
    ): SentientResult<VoiceCreateResult> = voices.createVoice(name, audioWav, description, tags, language)

    suspend fun delete(voiceId: String): SentientResult<VoiceDeleteResult> = voices.deleteVoice(voiceId)

    // ── Gated Fish Audio browse/clone (FishResult carries FeatureDisabled) ──

    suspend fun fishBrowse(title: String? = null, page: Int? = null): FishResult<FishVoicePage> =
        voices.fishListVoices(title, page)

    suspend fun fishGet(id: String): FishResult<FishVoiceEntry> = voices.fishGetVoice(id)

    suspend fun fishClone(fishVoiceId: String, request: CloneFromFishRequest): FishResult<CloneFromFishResult> =
        voices.fishClone(fishVoiceId, request)
}
