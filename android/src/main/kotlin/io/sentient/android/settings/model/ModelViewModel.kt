// ---------------------------------------------------------------------------
// ModelViewModel — Model settings page. SLOW save: a full-profile PUT whose model
// ref changed (not audio) → PUT then apply (Hermes restart). Loads the profile +
// the model catalog; holds `original` + `draft` (only the model ref is editable
// here). Provider-browse + search are view-local (the screen owns them); the VM only
// tracks the committed selection and the FSM progress.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.model

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.ModelEntry
import io.sentient.mobilesdk.settings.ProfileModelRef
import io.sentient.mobilesdk.settings.ProfileV1
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Model page state. `original` is server truth; `draft` carries the pending model pick. */
data class ModelUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: ProfileV1? = null,
    val draft: ProfileV1? = null,
    val models: List<ModelEntry> = emptyList(),
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val dirty: Boolean get() = original != null && draft != null && draft.model != original.model
    val applyActive: Boolean get() = saving || restarting

    /** The pending model id (drives single-select highlighting). */
    val selectedId: String? get() = draft?.model?.id
}

class ModelViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "model-vm")

    private val _ui = MutableStateFlow(ModelUiState())
    val ui: StateFlow<ModelUiState> = _ui.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, loadError = null) }
            val profile = component.profileRepository.getProfile()
            if (profile !is SentientResult.Success) {
                val msg = (profile as? SentientResult.Failure)?.error?.userMessage ?: "Couldn't load profile."
                log.warn("load.profile.failed")
                _ui.update { it.copy(loading = false, loadError = msg) }
                return@launch
            }
            val models = when (val r = component.profileRepository.listModels()) {
                is SentientResult.Success -> r.data.models
                else -> {
                    log.warn("load.models.degraded")
                    emptyList()
                }
            }
            _ui.update { it.copy(loading = false, original = profile.data, draft = profile.data, models = models) }
        }
    }

    fun selectModel(entry: ModelEntry) {
        _ui.update { s ->
            val draft = s.draft ?: return@update s
            if (draft.model.id == entry.id && draft.model.provider == entry.provider) return@update s
            log.info("select", mapOf("id" to entry.id, "provider" to entry.provider))
            s.copy(
                draft = draft.copy(model = ProfileModelRef(provider = entry.provider, id = entry.id)),
                alreadyApplying = false,
                applyError = null,
            )
        }
    }

    fun save() {
        val state = _ui.value
        val previous = state.original ?: return
        val next = state.draft ?: return
        if (!state.dirty || state.applyActive) return
        log.info("save", mapOf("model" to next.model.id))
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
internal fun ModelUiState.foldApply(state: ApplyState): ModelUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
