// ---------------------------------------------------------------------------
// MembersViewModel — thin state-holder for the Members (admin) settings page.
// Imperative admin ops over SettingsComponent.admin (AdminUseCases): list, promote/
// demote (PATCH isAdmin), delete (confirm), add member (name + 4-digit PIN, 3-user
// cap). Also resolves SettingsComponent.account to read the current userId so the
// self-row hides its own promote/demote/delete (webui parity; the server also
// enforces last-admin). PINs are NEVER logged (only lengths/ids/flags).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.AccountUseCases
import io.sentient.mobiledata.usecase.settings.AdminUseCases
import io.sentient.mobiledata.usecase.settings.canAddUser
import io.sentient.mobiledata.usecase.settings.householdSlotsFree
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.CreateUserRequest
import io.sentient.mobilesdk.settings.UserSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val PIN_LENGTH = 4
private const val ERR_ROLE = "Couldn't update role. Try again."
private const val ERR_DELETE = "Couldn't remove member. Try again."
private const val ERR_ADD = "Couldn't add member. Try again."
private const val ERR_LOAD = "Failed to load members."

/** Add-member dialog state; null in [MembersUiState.addDialog] means closed. */
data class AddMemberState(
    val displayName: String = "",
    val pin: String = "",
    val saving: Boolean = false,
    val error: String? = null,
) {
    val submittable: Boolean get() = displayName.trim().isNotEmpty() && pin.length == PIN_LENGTH && !saving
}

data class MembersUiState(
    val users: List<UserSummary> = emptyList(),
    val selfUserId: String = "",
    /** Fail-safe: false until me() proves admin. An unresolved/failed me() must never grant access. */
    val isAdmin: Boolean = false,
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val addDialog: AddMemberState? = null,
    val deleteTarget: UserSummary? = null,
    val errorMessage: String? = null,
    /** True when me() itself failed — distinct from a confirmed non-admin (mirrors iOS Access.error). */
    val accessError: Boolean = false,
) {
    val slotsFree: Int get() = householdSlotsFree(users.size)
    val canAdd: Boolean get() = canAddUser(users.size)
}

class MembersViewModel(
    private val admin: AdminUseCases,
    private val account: AccountUseCases,
) : ViewModel() {
    private val log = createLogger("android", "settings", "members-vm")

    private val _state = MutableStateFlow(MembersUiState())
    val state: StateFlow<MembersUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    /** Load self id (for the self-guard) then the member list. Fail-safe: a failed/loading
     *  me() never falls through to the roster with a defeated (isAdmin=true) guard. */
    fun refresh() {
        viewModelScope.launch {
            when (val me = account.me()) {
                is SentientResult.Success ->
                    _state.update { it.copy(selfUserId = me.data.userId, isAdmin = me.data.isAdmin, accessError = false) }
                is SentientResult.Failure -> {
                    log.warn("me.failed", mapOf("kind" to me.error.kind))
                    _state.update { it.copy(loaded = true, isAdmin = false, accessError = true) }
                    return@launch
                }
                is SentientResult.Loading -> Unit
            }
            when (val r = admin.listUsers()) {
                is SentientResult.Success -> {
                    _state.update { it.copy(users = r.data, loaded = true, errorMessage = null) }
                    log.info("members.loaded", mapOf("count" to r.data.size))
                }
                is SentientResult.Failure -> _state.update { it.copy(loaded = true, errorMessage = ERR_LOAD) }
                is SentientResult.Loading -> Unit
            }
        }
    }

    /** Promote / demote (PATCH isAdmin). Self-row never reaches this (UI hides its actions). */
    fun toggleAdmin(user: UserSummary) {
        viewModelScope.launch {
            when (admin.setUserAdmin(user.userId, !user.isAdmin)) {
                is SentientResult.Success -> refresh()
                is SentientResult.Failure -> _state.update { it.copy(errorMessage = ERR_ROLE) }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun openDelete(user: UserSummary) = _state.update { it.copy(deleteTarget = user) }

    fun closeDelete() = _state.update { it.copy(deleteTarget = null) }

    /** Delete the confirmed member, then refetch. */
    fun confirmDelete() {
        val target = _state.value.deleteTarget ?: return
        _state.update { it.copy(busy = true, deleteTarget = null) }
        viewModelScope.launch {
            when (admin.deleteUser(target.userId)) {
                is SentientResult.Success -> {
                    _state.update { it.copy(busy = false) }
                    refresh()
                }
                is SentientResult.Failure -> _state.update { it.copy(busy = false, errorMessage = ERR_DELETE) }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun openAdd() = _state.update { it.copy(addDialog = AddMemberState()) }

    fun closeAdd() = _state.update { it.copy(addDialog = null) }

    fun setAddName(value: String) = updateAdd { it.copy(displayName = value, error = null) }

    fun setAddPin(value: String) =
        updateAdd { it.copy(pin = value.filter { c -> c.isDigit() }.take(PIN_LENGTH), error = null) }

    /** Create a member with default profile (see MemberDefaults), then refetch. */
    fun submitAdd() {
        val dialog = _state.value.addDialog ?: return
        if (!dialog.submittable) return
        updateAdd { it.copy(saving = true, error = null) }
        val request = CreateUserRequest(
            displayName = dialog.displayName.trim(),
            pin = dialog.pin,
            isAdmin = false,
            profile = defaultMemberProfile(),
        )
        viewModelScope.launch {
            when (admin.createUser(request)) {
                is SentientResult.Success -> {
                    log.info("member.added")
                    _state.update { it.copy(addDialog = null) }
                    refresh()
                }
                is SentientResult.Failure -> updateAdd { it.copy(saving = false, error = ERR_ADD) }
                is SentientResult.Loading -> Unit
            }
        }
    }

    private inline fun updateAdd(transform: (AddMemberState) -> AddMemberState) {
        _state.update { s -> s.addDialog?.let { s.copy(addDialog = transform(it)) } ?: s }
    }
}
