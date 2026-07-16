// ---------------------------------------------------------------------------
// PersonalitiesViewModel — Personalities settings page. Unlike the draft+Save pages,
// each mutation (create / update-body / activate / delete) is its OWN restart-on-write
// FSM run; the list is refetched after every Ready (webui: trust post-restart truth).
// The VM holds only the server list + FSM progress; per-card expand / edit-draft /
// new-form state is view-local in the screen.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.personalities

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.Personality
import io.sentient.mobilesdk.settings.PersonalityList
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Personalities page state. `list` is server truth; progress fields fold the active FSM run. */
data class PersonalitiesUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val list: PersonalityList? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val busy: Boolean get() = saving || restarting
    val personalities: List<Personality> get() = list?.personalities ?: emptyList()
    val activeName: String? get() = list?.activeName
}

class PersonalitiesViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "personalities-vm")

    private val _ui = MutableStateFlow(PersonalitiesUiState())
    val ui: StateFlow<PersonalitiesUiState> = _ui.asStateFlow()

    init {
        reload()
    }

    fun create(name: String, body: String) =
        runMutation(ProfileMutation.CreatePersonality(name.trim(), body), "create")

    fun updateBody(name: String, body: String) =
        runMutation(ProfileMutation.UpdatePersonality(name, body), "update")

    fun activate(name: String) = runMutation(ProfileMutation.ActivatePersonality(name), "activate")

    fun delete(name: String) = runMutation(ProfileMutation.DeletePersonality(name), "delete")

    private fun runMutation(mutation: ProfileMutation, op: String) {
        if (_ui.value.busy) return
        log.info("mutation", mapOf("op" to op))
        viewModelScope.launch {
            component.applyProfileChange(mutation).collect { st ->
                _ui.update { it.foldApply(st) }
                if (st is ApplyState.Ready) reload()
            }
        }
    }

    private fun reload() {
        viewModelScope.launch {
            when (val r = component.profileRepository.listPersonalities()) {
                is SentientResult.Success -> _ui.update { it.copy(loading = false, list = r.data, loadError = null) }
                is SentientResult.Failure -> {
                    log.warn("reload.failed", mapOf("kind" to r.error.kind))
                    _ui.update { it.copy(loading = false, loadError = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }
}

/** Fold one FSM transition into flat progress fields. */
internal fun PersonalitiesUiState.foldApply(state: ApplyState): PersonalitiesUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
