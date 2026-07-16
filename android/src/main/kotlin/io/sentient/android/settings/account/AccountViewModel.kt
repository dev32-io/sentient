// ---------------------------------------------------------------------------
// AccountViewModel — thin state-holder for the Account settings page. Imperative
// ops (no draft/apply bar): the display-name Save fires PUT auth/me immediately and
// the change-PIN dialog fires PUT auth/me/pin immediately, each surfacing its own
// inline result. Identity ops resolve SettingsComponent.account (AccountUseCases);
// the usecase persists the rolled token on a successful me / rename. PIN + name
// values are NEVER logged (lengths/outcomes only). No sign-out here — logout stays
// a root-level danger row.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.AccountUseCases
import io.sentient.mobiledata.usecase.settings.ChangePinOutcome
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val PIN_LENGTH = 4
private const val ERR_WRONG_PIN = "Current PIN is wrong"

/** Inline outcome of the display-name Save action. */
sealed interface NameSaveState {
    data object Idle : NameSaveState
    data object Saving : NameSaveState
    data object Saved : NameSaveState
    data class Error(val message: String) : NameSaveState
}

/** Change-PIN dialog state; null in [AccountUiState.pin] means the dialog is closed. */
data class PinDialogState(
    val current: String = "",
    val new: String = "",
    val saving: Boolean = false,
    val error: String? = null,
)

data class AccountUiState(
    val name: String = "",
    val savedName: String = "",
    val loaded: Boolean = false,
    val nameSave: NameSaveState = NameSaveState.Idle,
    val pin: PinDialogState? = null,
) {
    /** Save is offered only when the trimmed name is non-empty and differs from the last-saved value. */
    val nameDirty: Boolean get() = name.trim().isNotEmpty() && name.trim() != savedName
}

class AccountViewModel(
    private val account: AccountUseCases,
) : ViewModel() {
    private val log = createLogger("android", "settings", "account-vm")

    private val _state = MutableStateFlow(AccountUiState())
    val state: StateFlow<AccountUiState> = _state.asStateFlow()

    init {
        load()
    }

    /** Load the current identity to seed the display-name field. Failure leaves it empty/unloaded. */
    fun load() {
        viewModelScope.launch {
            when (val r = account.me()) {
                is SentientResult.Success -> _state.update {
                    it.copy(name = r.data.displayName, savedName = r.data.displayName, loaded = true)
                }
                is SentientResult.Failure -> log.warn("me.failed", mapOf("kind" to r.error.kind))
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun setName(value: String) {
        _state.update { it.copy(name = value, nameSave = NameSaveState.Idle) }
    }

    /** Rename (imperative PUT). Guarded on [AccountUiState.nameDirty]; result is inline. */
    fun saveName() {
        val trimmed = _state.value.name.trim()
        if (!_state.value.nameDirty) return
        _state.update { it.copy(nameSave = NameSaveState.Saving) }
        viewModelScope.launch {
            when (val r = account.updateDisplayName(trimmed)) {
                is SentientResult.Success -> _state.update {
                    it.copy(name = r.data.displayName, savedName = r.data.displayName, nameSave = NameSaveState.Saved)
                }
                is SentientResult.Failure ->
                    _state.update { it.copy(nameSave = NameSaveState.Error(r.error.userMessage)) }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun openPinDialog() = _state.update { it.copy(pin = PinDialogState()) }

    fun closePinDialog() = _state.update { it.copy(pin = null) }

    fun setCurrentPin(value: String) = updatePin { it.copy(current = value.digits(), error = null) }

    fun setNewPin(value: String) = updatePin { it.copy(new = value.digits(), error = null) }

    /** Change PIN (imperative). Wrong-current-PIN surfaces inline; the token is never dropped. */
    fun submitPin() {
        val dialog = _state.value.pin ?: return
        if (!dialog.isSubmittable) return
        updatePin { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            when (val outcome = account.changePin(dialog.current, dialog.new)) {
                ChangePinOutcome.Ok -> _state.update { it.copy(pin = null) }
                ChangePinOutcome.WrongCurrentPin -> updatePin { it.copy(saving = false, error = ERR_WRONG_PIN) }
                is ChangePinOutcome.Error ->
                    updatePin { it.copy(saving = false, error = outcome.error.userMessage) }
            }
        }
    }

    private inline fun updatePin(transform: (PinDialogState) -> PinDialogState) {
        _state.update { s -> s.pin?.let { s.copy(pin = transform(it)) } ?: s }
    }
}

private val PinDialogState.isSubmittable: Boolean
    get() = current.length == PIN_LENGTH && new.length == PIN_LENGTH && !saving

private fun String.digits(): String = filter { it.isDigit() }.take(PIN_LENGTH)
