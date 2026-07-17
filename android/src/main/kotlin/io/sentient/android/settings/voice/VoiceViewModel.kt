// ---------------------------------------------------------------------------
// VoiceViewModel — thin state-holder for the Voice settings list. Mirrors the webui
// VoicesPanel: load the shared library once, filter client-side (search / source /
// tags / language), preview / pick / delete per pack, and gate the "Clone from Fish"
// entry on the fish-browse feature flag.
//
// The active voice id comes from a direct profile read — SettingsComponent exposes
// its repos "for the rare direct read", and there is no dedicated active-voice
// usecase (webui reads profile.voice.id the same way). Every op folds the result
// envelope / FishResult exhaustively; audio bytes are never logged (usecase-side).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ObserveSettingsAccessUseCase
import io.sentient.mobiledata.usecase.settings.VoiceFilterState
import io.sentient.mobiledata.usecase.settings.VoicesUseCases
import io.sentient.mobiledata.usecase.settings.deriveLanguageOptions
import io.sentient.mobiledata.usecase.settings.deriveTagOptions
import io.sentient.mobiledata.usecase.settings.filterVoices
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.VoiceSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Render state for the Voice list page. `shown` is the filtered view of `allVoices`. */
data class VoiceUiState(
    val loading: Boolean = true,
    val errorMessage: String? = null,
    val allVoices: List<VoiceSummary> = emptyList(),
    val shown: List<VoiceSummary> = emptyList(),
    val allTags: List<String> = emptyList(),
    val allLanguages: List<String> = emptyList(),
    val activeVoiceId: String = "",
    val filter: VoiceFilterState = VoiceFilterState(),
    val fishEnabled: Boolean = false,
    val previewLoadingId: String? = null,
    val previewPlayingId: String? = null,
    val busyId: String? = null,
    val pendingDelete: VoiceSummary? = null,
    val notice: String? = null,
)

class VoiceViewModel(
    private val voices: VoicesUseCases,
    private val profile: ProfileRepository,
    private val observeAccess: ObserveSettingsAccessUseCase,
    private val player: VoicePreviewPlayer,
) : ViewModel() {
    private val log = createLogger("android", "settings", "voice-vm")

    private val _state = MutableStateFlow(VoiceUiState())
    val state: StateFlow<VoiceUiState> = _state.asStateFlow()

    init {
        refresh()
        loadAccess()
    }

    /** Reload the library + active voice; recompute the filtered view + facet options. */
    fun refresh() {
        _state.update { it.copy(loading = true, errorMessage = null) }
        viewModelScope.launch {
            val active = loadActiveVoiceId()
            when (val r = voices.listFiltered(VoiceFilterState())) {
                is SentientResult.Success -> applyLoaded(r.data, active)
                is SentientResult.Failure -> {
                    log.warn("list.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(loading = false, errorMessage = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    private fun applyLoaded(all: List<VoiceSummary>, active: String?) {
        log.info("list.loaded", mapOf("count" to all.size))
        _state.update { s ->
            s.copy(
                loading = false,
                allVoices = all,
                shown = filterVoices(all, s.filter),
                allTags = deriveTagOptions(all),
                allLanguages = deriveLanguageOptions(all),
                activeVoiceId = active ?: s.activeVoiceId,
            )
        }
    }

    private suspend fun loadActiveVoiceId(): String? =
        when (val p = profile.getProfile()) {
            is SentientResult.Success -> p.data.voice.id
            else -> null
        }

    private fun loadAccess() {
        viewModelScope.launch {
            when (val r = observeAccess()) {
                is SentientResult.Success -> _state.update { it.copy(fishEnabled = r.data.fishBrowseEnabled) }
                else -> Unit
            }
        }
    }

    fun setQuery(q: String) = updateFilter { it.copy(query = q) }

    fun setSource(source: String) = updateFilter { it.copy(source = source) }

    fun setLanguage(language: String) = updateFilter { it.copy(language = language) }

    fun toggleTag(tag: String) =
        updateFilter { f -> f.copy(tags = if (tag in f.tags) f.tags - tag else f.tags + tag) }

    private fun updateFilter(transform: (VoiceFilterState) -> VoiceFilterState) {
        _state.update { s ->
            val next = transform(s.filter)
            s.copy(filter = next, shown = filterVoices(s.allVoices, next))
        }
    }

    /** Play (or stop) a live-synth preview for [voice] in the pack's own language. */
    fun togglePreview(voice: VoiceSummary) {
        val s = _state.value
        if (s.previewPlayingId == voice.voiceId || s.previewLoadingId == voice.voiceId) {
            player.stop()
            _state.update { it.copy(previewPlayingId = null, previewLoadingId = null) }
            return
        }
        _state.update { it.copy(previewLoadingId = voice.voiceId) }
        viewModelScope.launch {
            when (val r = voices.preview(voice.voiceId, voice.language)) {
                is SentientResult.Success -> {
                    _state.update { it.copy(previewLoadingId = null, previewPlayingId = voice.voiceId) }
                    player.playBytes(r.data) { onPreviewEnded(voice.voiceId) }
                }
                is SentientResult.Failure -> {
                    log.warn("preview.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(previewLoadingId = null, notice = "Couldn't play preview") }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    private fun onPreviewEnded(id: String) {
        _state.update { if (it.previewPlayingId == id) it.copy(previewPlayingId = null) else it }
    }

    /** Set [voice] as the active reply voice (fast op — no restart). */
    fun pick(voice: VoiceSummary) {
        if (voice.voiceId == _state.value.activeVoiceId) return
        _state.update { it.copy(busyId = voice.voiceId) }
        viewModelScope.launch {
            when (val r = voices.pickActive(voice.voiceId)) {
                is SentientResult.Success ->
                    _state.update { it.copy(busyId = null, activeVoiceId = r.data.voice.id) }
                is SentientResult.Failure -> {
                    log.warn("pick.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(busyId = null, notice = "Couldn't switch voice") }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun requestDelete(voice: VoiceSummary) = _state.update { it.copy(pendingDelete = voice) }

    fun cancelDelete() = _state.update { it.copy(pendingDelete = null) }

    /** Delete the pack awaiting confirmation, then refetch the list. */
    fun confirmDelete() {
        val target = _state.value.pendingDelete ?: return
        _state.update { it.copy(pendingDelete = null, busyId = target.voiceId) }
        viewModelScope.launch {
            when (val r = voices.delete(target.voiceId)) {
                is SentientResult.Success -> {
                    _state.update { it.copy(busyId = null, notice = "Voice deleted") }
                    refresh()
                }
                is SentientResult.Failure -> {
                    log.warn("delete.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(busyId = null, notice = "Couldn't delete voice") }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun clearNotice() = _state.update { it.copy(notice = null) }

    override fun onCleared() {
        player.release()
    }
}
