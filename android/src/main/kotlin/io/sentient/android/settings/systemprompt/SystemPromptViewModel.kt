// ---------------------------------------------------------------------------
// SystemPromptViewModel — System Prompt (Soul.md) page. SLOW save: the soul PUT is
// restart-on-write, so ApplyProfileChangeUseCase(PutSoul) does write + restart in one
// call. Holds `original` (server SoulDoc) + `draft` (editor content); dirty derived.
// Restore-default fetches the canonical template into the draft (no save until Save).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.systemprompt

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.SoulDoc
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** System-prompt page state. `original` is the server SoulDoc; `draft` is editor content. */
data class SystemPromptUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: SoulDoc? = null,
    val draft: String? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val dirty: Boolean get() = original != null && draft != null && draft != original.content
    val applyActive: Boolean get() = saving || restarting
}

class SystemPromptViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "system-prompt-vm")

    private val _ui = MutableStateFlow(SystemPromptUiState())
    val ui: StateFlow<SystemPromptUiState> = _ui.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, loadError = null) }
            when (val r = component.profileRepository.getSoul()) {
                is SentientResult.Success ->
                    _ui.update { it.copy(loading = false, original = r.data, draft = r.data.content) }
                is SentientResult.Failure -> {
                    log.warn("load.failed", mapOf("kind" to r.error.kind))
                    _ui.update { it.copy(loading = false, loadError = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun setDraft(content: String) {
        _ui.update { it.copy(draft = content, alreadyApplying = false, applyError = null) }
    }

    /** Load the canonical Soul.md into the draft. User still Saves to commit + restart. */
    fun restoreDefault() {
        viewModelScope.launch {
            when (val r = component.profileRepository.getSoulDefault()) {
                is SentientResult.Success -> {
                    log.info("restore-default.loaded")
                    _ui.update { it.copy(draft = r.data.content, applyError = null) }
                }
                is SentientResult.Failure -> {
                    log.warn("restore-default.failed", mapOf("kind" to r.error.kind))
                    _ui.update { it.copy(applyError = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun save() {
        val state = _ui.value
        val next = state.draft ?: return
        if (!state.dirty || state.applyActive) return
        log.info("save", mapOf("chars" to next.length))
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutSoul(next)).collect { st ->
                _ui.update { it.foldApply(st) }
                if (st is ApplyState.Ready) refetch()
            }
        }
    }

    private suspend fun refetch() {
        when (val r = component.profileRepository.getSoul()) {
            is SentientResult.Success -> _ui.update { it.copy(original = r.data, draft = r.data.content) }
            is SentientResult.Failure -> log.warn("refetch.failed", mapOf("kind" to r.error.kind))
            is SentientResult.Loading -> Unit
        }
    }
}

/** Fold one FSM transition into flat progress fields. */
internal fun SystemPromptUiState.foldApply(state: ApplyState): SystemPromptUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
