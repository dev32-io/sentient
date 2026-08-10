// ---------------------------------------------------------------------------
// AudioViewModel — Audio settings page. FAST save: a full-profile PUT whose only
// diff is `audio`, so ApplyProfileChangeUseCase takes the no-restart fast path and
// pushes a live WS preference patch. Holds `original` (server truth) + `draft`
// (local edits); dirty is derived. Thin: loads via profileRepository, saves via the
// one FSM usecase, folds its ApplyState flow into flat progress fields.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.audio

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.toPutBody
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Audio page state. `original` is the last server truth; `draft` carries local edits. */
data class AudioUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: ProfileV1? = null,
    val draft: ProfileV1? = null,
    val saving: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    /** Dirty iff the audio section of the draft diverges from the server truth. */
    val dirty: Boolean
        get() = original != null && draft != null && draft.audio != original.audio
}

class AudioViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "audio-vm")

    private val _ui = MutableStateFlow(AudioUiState())
    val ui: StateFlow<AudioUiState> = _ui.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, loadError = null) }
            when (val r = component.profileRepository.getProfile()) {
                is SentientResult.Success ->
                    _ui.update { it.copy(loading = false, original = r.data, draft = r.data) }
                is SentientResult.Failure -> {
                    log.warn("load.failed", mapOf("kind" to r.error.kind))
                    _ui.update { it.copy(loading = false, loadError = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun setTts(on: Boolean) = editDraft { it.copy(audio = it.audio.copy(ttsEnabled = on)) }

    fun setChannel(channel: String) = editDraft { it.copy(audio = it.audio.copy(channel = channel)) }

    private inline fun editDraft(transform: (ProfileV1) -> ProfileV1) {
        _ui.update { s ->
            val draft = s.draft ?: return@update s
            s.copy(draft = transform(draft), alreadyApplying = false, applyError = null)
        }
    }

    fun save() {
        val state = _ui.value
        val previous = state.original ?: return
        val next = state.draft ?: return
        if (!state.dirty || state.saving) return
        log.info("save", mapOf("tts" to next.audio.ttsEnabled, "channel" to next.audio.channel))
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutProfile(previous, next.toPutBody())).collect { st ->
                _ui.update { it.foldApply(st) }
                if (st is ApplyState.Ready) refetch()
            }
        }
    }

    private suspend fun refetch() {
        when (val r = component.profileRepository.getProfile()) {
            is SentientResult.Success -> _ui.update { it.copy(original = r.data, draft = r.data) }
            is SentientResult.Failure -> log.warn("refetch.failed", mapOf("kind" to r.error.kind))
            is SentientResult.Loading -> Unit
        }
    }
}

/** Fold one FSM transition into flat progress fields (fast path never emits Restarting). */
internal fun AudioUiState.foldApply(state: ApplyState): AudioUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = true)
    is ApplyState.Ready -> copy(saving = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
