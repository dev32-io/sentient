// ---------------------------------------------------------------------------
// SecretsViewModel — thin state-holder for the Secrets (admin) settings page.
// Presence-only key management over SettingsComponent.admin (AdminUseCases): GET
// returns has_key booleans (NEVER key material), PUT is write-only. Key values live
// ONLY in the SecretRow composable's local draft — they never enter this VM's state
// or any log line (logging carries provider name + a hasKey boolean, that's all).
//
// Restart affordance (webui parity): a saved key/base-url/active-change eagerly PUTs
// and flags `restartNeeded`. Webui queues that as a "slow" op on its apply-bar; the
// mobile mirror shows an inline "Restart to pick up the new key" notice + an
// "Apply now" button that fires the bare apply via ApplyProfileChangeUseCase.applyOnly.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.secrets

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.AdminUseCases
import io.sentient.mobiledata.usecase.settings.ApplyProfileChangeUseCase
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.SecretsStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** LLM provider slugs — must match the gateway secrets routes (secrets.ts LLM_PROVIDERS). */
object SecretProviders {
    const val OPENROUTER = "openrouter"
    const val OLLAMA_CLOUD = "ollama-cloud"
    const val CUSTOM = "custom"
}

/** Which row's inline field is open. */
enum class SecretField { KEY, BASE_URL }

data class EditingTarget(val provider: String, val field: SecretField)

data class SecretsUiState(
    val status: SecretsStatus? = null,
    val editing: EditingTarget? = null,
    val restartNeeded: Boolean = false,
    /** Non-null while / after a bare apply — drives the "Applying…/Applied/Failed" affordance. */
    val applying: ApplyState? = null,
    val errorMessage: String? = null,
)

class SecretsViewModel(
    private val admin: AdminUseCases,
    private val applyProfileChange: ApplyProfileChangeUseCase,
) : ViewModel() {
    private val log = createLogger("android", "settings", "secrets-vm")

    private val _state = MutableStateFlow(SecretsUiState())
    val state: StateFlow<SecretsUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            when (val r = admin.getSecretsStatus()) {
                is SentientResult.Success -> _state.update { it.copy(status = r.data) }
                is SentientResult.Failure -> _state.update { it.copy(errorMessage = "Failed to load provider keys.") }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun startEdit(provider: String, field: SecretField) =
        _state.update { it.copy(editing = EditingTarget(provider, field), errorMessage = null) }

    fun cancelEdit() = _state.update { it.copy(editing = null) }

    /** Save a provider key (write-only; value never logged/stored in state), then refetch. */
    fun saveKey(provider: String, value: String) = mutate("key.save", provider) {
        admin.setLlmProviderKey(provider, value = value, baseUrl = null)
    }

    /** Save the custom provider base URL, then refetch. */
    fun saveBaseUrl(url: String) = mutate("baseurl.save", SecretProviders.CUSTOM) {
        admin.setLlmProviderKey(SecretProviders.CUSTOM, value = null, baseUrl = url)
    }

    /** Point the active LLM provider at [provider], then refetch. */
    fun setActive(provider: String) = mutate("set-active", provider) {
        admin.setActiveLlmProvider(provider)
    }

    private inline fun mutate(op: String, provider: String, crossinline call: suspend () -> SentientResult<Unit>) {
        viewModelScope.launch {
            when (call()) {
                is SentientResult.Success -> {
                    log.info(op, mapOf("provider" to provider)) // value/url NEVER logged
                    _state.update { it.copy(editing = null, restartNeeded = true) }
                    refresh()
                }
                is SentientResult.Failure ->
                    _state.update { it.copy(errorMessage = "Couldn't save. Try again.") }
                is SentientResult.Loading -> Unit
            }
        }
    }

    /** Fire the bare apply so the worker restarts and picks up the new key. */
    fun applyNow() {
        if (_state.value.applying is ApplyState.Restarting) return
        viewModelScope.launch {
            applyProfileChange.applyOnly().collect { st ->
                _state.update {
                    it.copy(applying = st, restartNeeded = if (st is ApplyState.Ready) false else it.restartNeeded)
                }
            }
        }
    }

    /** Dismiss a terminal apply affordance (Applied/Already/Failed). */
    fun clearApplyResult() = _state.update { it.copy(applying = null) }
}
