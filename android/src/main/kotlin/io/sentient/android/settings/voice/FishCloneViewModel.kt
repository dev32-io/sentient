// ---------------------------------------------------------------------------
// FishCloneViewModel — thin state-holder for the gated "Clone from Fish" sub-page.
// Debounced title search → paged Fish library browse (load-more, id-deduped) →
// play external sample → pick → prefill name/tags/language → clone. Mirrors the
// webui FishClonePanel + AddVoiceModal clone path.
//
// FishResult folds exhaustively: FeatureDisabled → gate message (normally
// unreachable — the Voice page only shows the entry when the flag is on), Failure →
// inline error + retry. Sample audio is the external previewAudioUrl, streamed
// directly (the gateway does not proxy Fish samples). Never logs audio / ids beyond
// lengths + counts.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.usecase.settings.VoicesUseCases
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.CloneFromFishRequest
import io.sentient.mobilesdk.settings.FishResult
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.VoiceFieldCaps
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val SEARCH_DEBOUNCE_MS: Long = 300L
private const val HTTP_UNPROCESSABLE = 422
private const val CLIP_TOO_SHORT_MARKER = "too short"

/** Render state for the Fish clone page. `selected != null` opens the clone form. */
data class FishCloneUiState(
    val loading: Boolean = true,
    val featureDisabled: Boolean = false,
    val errorMessage: String? = null,
    val query: String = "",
    val voices: List<FishVoiceEntry> = emptyList(),
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val playingId: String? = null,
    val selected: FishVoiceEntry? = null,
    val name: String = "",
    val description: String = "",
    val tags: List<String> = emptyList(),
    val language: String = "",
    val cloning: Boolean = false,
    val done: Boolean = false,
)

class FishCloneViewModel(
    private val voices: VoicesUseCases,
    private val player: VoicePreviewPlayer,
) : ViewModel() {
    private val log = createLogger("android", "settings", "fish-clone-vm")

    private val _state = MutableStateFlow(FishCloneUiState())
    val state: StateFlow<FishCloneUiState> = _state.asStateFlow()

    private var page = 1
    private var searchJob: Job? = null

    init {
        browse()
    }

    fun setQuery(query: String) {
        _state.update { it.copy(query = query) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(SEARCH_DEBOUNCE_MS)
            browse()
        }
    }

    fun retry() = browse()

    /** (Re)load page 1 for the current query. */
    fun browse() {
        _state.update { it.copy(loading = true, errorMessage = null, featureDisabled = false) }
        page = 1
        viewModelScope.launch {
            when (val r = voices.fishBrowse(currentQuery(), page)) {
                is FishResult.Success -> {
                    log.info("browse.ok", mapOf("count" to r.value.voices.size, "hasMore" to r.value.hasMore))
                    _state.update { it.copy(loading = false, voices = r.value.voices, hasMore = r.value.hasMore) }
                }
                FishResult.FeatureDisabled -> {
                    log.warn("browse.feature-disabled")
                    _state.update { it.copy(loading = false, featureDisabled = true) }
                }
                is FishResult.Failure -> {
                    log.warn("browse.failed", mapOf("kind" to (r.error::class.simpleName ?: "unknown")))
                    _state.update { it.copy(loading = false, errorMessage = "Couldn't load voices.") }
                }
            }
        }
    }

    fun loadMore() {
        val s = _state.value
        if (!s.hasMore || s.loadingMore || s.loading) return
        _state.update { it.copy(loadingMore = true) }
        val next = page + 1
        viewModelScope.launch {
            when (val r = voices.fishBrowse(currentQuery(), next)) {
                is FishResult.Success -> {
                    page = next
                    _state.update { cur ->
                        cur.copy(loadingMore = false, voices = dedup(cur.voices, r.value.voices), hasMore = r.value.hasMore)
                    }
                }
                FishResult.FeatureDisabled -> {
                    log.warn("loadMore.feature-disabled")
                    _state.update { it.copy(loadingMore = false, featureDisabled = true) }
                }
                is FishResult.Failure -> {
                    log.warn("loadMore.failed", mapOf("kind" to (r.error::class.simpleName ?: "unknown")))
                    _state.update { it.copy(loadingMore = false, errorMessage = "Couldn't load more voices.") }
                }
            }
        }
    }

    /** Play (or stop) an entry's external sample; no-op when it has no previewAudioUrl. */
    fun togglePlay(entry: FishVoiceEntry) {
        val url = entry.previewAudioUrl
        val wasPlayingThis = _state.value.playingId == entry.id
        player.stop()
        if (wasPlayingThis || url == null) {
            _state.update { it.copy(playingId = null) }
            return
        }
        player.playUrl(url) { onPlayEnded(entry.id) }
        _state.update { it.copy(playingId = entry.id) }
    }

    private fun onPlayEnded(id: String) =
        _state.update { if (it.playingId == id) it.copy(playingId = null) else it }

    /** Open the clone form for [entry], prefilling name / tags / language from Fish. */
    fun pickForClone(entry: FishVoiceEntry) {
        player.stop()
        _state.update {
            it.copy(
                playingId = null,
                selected = entry,
                name = cap(entry.title, VoiceFieldCaps.NAME_MAX_LEN),
                description = cap(entry.description, VoiceFieldCaps.DESCRIPTION_MAX_LEN),
                tags = entry.tags.take(VoiceFieldCaps.MAX_TAGS),
                language = normalizeVoiceLanguage(entry.languages.firstOrNull() ?: ""),
                errorMessage = null,
            )
        }
    }

    fun backToList() = _state.update { it.copy(selected = null, errorMessage = null) }

    fun setName(name: String) = _state.update { it.copy(name = cap(name, VoiceFieldCaps.NAME_MAX_LEN)) }

    fun setDescription(text: String) =
        _state.update { it.copy(description = cap(text, VoiceFieldCaps.DESCRIPTION_MAX_LEN)) }

    fun setLanguage(language: String) = _state.update { it.copy(language = language) }

    fun addTag(raw: String) {
        val tag = cap(raw.trim(), VoiceFieldCaps.TAG_MAX_LEN)
        _state.update { s ->
            if (tag.isEmpty() || tag in s.tags || s.tags.size >= VoiceFieldCaps.MAX_TAGS) s
            else s.copy(tags = s.tags + tag)
        }
    }

    fun removeTag(tag: String) = _state.update { it.copy(tags = it.tags - tag) }

    /** Clone the selected Fish voice into a local pack (creating activates it server-side). */
    fun clone() {
        val entry = _state.value.selected ?: return
        val name = _state.value.name.trim()
        if (name.isEmpty()) return
        val s = _state.value
        _state.update { it.copy(cloning = true, errorMessage = null) }
        viewModelScope.launch {
            val req = CloneFromFishRequest(name, s.description.trim(), s.tags, s.language)
            when (val r = voices.fishClone(entry.id, req)) {
                is FishResult.Success -> {
                    log.info("clone.ok", mapOf("warning" to (r.value.warning ?: "none")))
                    _state.update { it.copy(cloning = false, done = true) }
                }
                FishResult.FeatureDisabled ->
                    _state.update { it.copy(cloning = false, featureDisabled = true, selected = null) }
                is FishResult.Failure -> {
                    log.warn("clone.failed", mapOf("kind" to (r.error::class.simpleName ?: "unknown")))
                    _state.update { it.copy(cloning = false, errorMessage = fishErrorMessage(r.error)) }
                }
            }
        }
    }

    fun clearError() = _state.update { it.copy(errorMessage = null) }

    private fun currentQuery(): String? = _state.value.query.trim().ifEmpty { null }

    override fun onCleared() {
        player.release()
    }
}

/** Append [additions] to [existing], dropping ids already present (Fish paginates by score). */
private fun dedup(existing: List<FishVoiceEntry>, additions: List<FishVoiceEntry>): List<FishVoiceEntry> {
    val ids = existing.mapTo(HashSet()) { it.id }
    return existing + additions.filter { it.id !in ids }
}

/** The clone route's only pre-build 422 is a too-short reference clip — map it precisely. */
private fun fishErrorMessage(error: AuthError): String = when (error) {
    is AuthError.Server ->
        if (error.status == HTTP_UNPROCESSABLE && error.body.contains(CLIP_TOO_SHORT_MARKER)) {
            "That sample is too short to clone — try another voice."
        } else {
            "Couldn't clone this voice."
        }
    is AuthError.Network -> "Couldn't reach the voice service — try again."
    else -> "Couldn't clone this voice."
}

private fun cap(value: String, max: Int): String = if (value.length > max) value.take(max) else value
