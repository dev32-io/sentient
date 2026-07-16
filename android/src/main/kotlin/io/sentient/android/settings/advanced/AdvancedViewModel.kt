// ---------------------------------------------------------------------------
// AdvancedViewModel — Advanced settings page. SLOW save: a full-profile PUT whose
// diff touches compression/advanced (not audio), so ApplyProfileChangeUseCase PUTs
// then applies (Hermes restart). Holds `original` (server truth) + `draft`; dirty is
// derived. Thin: loads via profileRepository, saves via the one FSM usecase, folds
// its ApplyState flow into flat progress fields (Restarting drives the restart copy).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.advanced

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.ProfileV1
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Advanced page state. `original` is the last server truth; `draft` carries local edits. */
data class AdvancedUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: ProfileV1? = null,
    val draft: ProfileV1? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val dirty: Boolean get() = original != null && draft != null && draft != original
    val applyActive: Boolean get() = saving || restarting
}

class AdvancedViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "advanced-vm")

    private val _ui = MutableStateFlow(AdvancedUiState())
    val ui: StateFlow<AdvancedUiState> = _ui.asStateFlow()

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

    fun setReasoning(effort: String) = editDraft { it.copy(advanced = it.advanced.copy(reasoningEffort = effort)) }

    fun setMaxTokens(tokens: Int) = editDraft { it.copy(advanced = it.advanced.copy(maxTokens = tokens)) }

    fun setExtraPrompt(text: String) = editDraft { it.copy(advanced = it.advanced.copy(extraSystemPrompt = text)) }

    fun setCompression(threshold: Double) =
        editDraft { it.copy(compression = it.compression.copy(threshold = threshold)) }

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
        if (!state.dirty || state.applyActive) return
        log.info("save", mapOf("reasoning" to next.advanced.reasoningEffort, "maxTokens" to next.advanced.maxTokens))
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutProfile(previous, next)).collect { st ->
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

/** Fold one FSM transition into flat progress fields. */
internal fun AdvancedUiState.foldApply(state: ApplyState): AdvancedUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
