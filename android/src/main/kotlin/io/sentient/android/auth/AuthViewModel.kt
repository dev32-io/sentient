// ---------------------------------------------------------------------------
// AuthViewModel — MVI ViewModel for the Login screen (avatar grid → PIN pad).
//
// Single source of truth: state: StateFlow<AuthUiState>. Single mutation entry:
// dispatch(AuthIntent). Side work (REST listUsers/login, token save) runs in
// viewModelScope. Navigation to chat is NOT modelled here — AppNavHost's login
// destination watches DisplayNameStore.name and navigates to chat when it appears.
// On a successful login we save the token, explicit server user id, and display
// name; the nav layer reacts only after identity + display state are present.
//
// PIN is NEVER logged. Auto-submit fires once 4 digits are entered.
// ---------------------------------------------------------------------------
package io.sentient.android.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.sdk.AppDependencies
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.DisplayNameStore
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.protocol.AuthUser
import io.sentient.mobilesdk.auth.AuthUserLite
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** PIN length the gateway expects (auth.ts: 4-digit numeric PIN). */
const val PIN_LENGTH = 4

/** Which login sub-screen is showing. */
enum class AuthPhase { PICK_USER, ENTER_PIN }

/**
 * Everything the Login screen renders. Immutable; updated via [AuthViewModel.dispatch].
 *
 * @param users Avatar grid entries from GET /auth/users.
 * @param loadingUsers True while the initial list is in flight.
 * @param selectedUser The user whose PIN is being entered (null in PICK_USER).
 * @param pin The digits entered so far (length 0..PIN_LENGTH). NEVER logged.
 * @param error A user-facing error message, or null. Drives the `login-error` text.
 * @param submitting True while a login round-trip + connect is in flight.
 */
data class AuthUiState(
    val users: List<AuthUserLite> = emptyList(),
    val loadingUsers: Boolean = false,
    val selectedUser: AuthUserLite? = null,
    val pin: String = "",
    val error: String? = null,
    val submitting: Boolean = false,
) {
    val phase: AuthPhase get() = if (selectedUser == null) AuthPhase.PICK_USER else AuthPhase.ENTER_PIN
}

/** User actions + external events. Closed sum for an exhaustive reducer. */
sealed interface AuthIntent {
    data object LoadUsers : AuthIntent
    data object Reset : AuthIntent
    data class SelectUser(val user: AuthUserLite) : AuthIntent
    data object Back : AuthIntent
    data class AppendDigit(val digit: Char) : AuthIntent
    data object DeleteDigit : AuthIntent
}

class AuthViewModel(
    private val authClientProvider: () -> AuthClient = { AppDependencies.authClient },
    private val tokenStore: SecureTokenStore = AppDependencies.tokenStore,
    private val displayNameStore: DisplayNameStore = DisplayNameHolder.store,
    /** Receives the server-authenticated identity; never infer it from display data or tokens. */
    private val onAuthenticated: (AuthUser) -> Unit = {},
) : ViewModel() {
    private val log = createLogger("android", "auth-viewmodel")

    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    fun dispatch(intent: AuthIntent) {
        when (intent) {
            AuthIntent.LoadUsers -> loadUsers()
            // Clear stale per-login navigation state (selectedUser/pin/submitting/
            // error) without dropping the loaded user list. The Activity-scoped VM
            // survives login→chat→logout, so the login screen must reset on entry —
            // otherwise logout lands on a stale, submitting (inert) PIN screen.
            AuthIntent.Reset -> _state.update {
                it.copy(selectedUser = null, pin = "", submitting = false, error = null)
            }
            is AuthIntent.SelectUser -> _state.update {
                it.copy(selectedUser = intent.user, pin = "", error = null)
            }
            AuthIntent.Back -> _state.update {
                it.copy(selectedUser = null, pin = "", error = null)
            }
            is AuthIntent.AppendDigit -> appendDigit(intent.digit)
            AuthIntent.DeleteDigit -> _state.update {
                if (it.submitting) it else it.copy(pin = it.pin.dropLast(1), error = null)
            }
        }
    }

    private fun loadUsers() {
        log.info("loadUsers.start")
        _state.update { it.copy(loadingUsers = true, error = null) }
        viewModelScope.launch {
            when (val result = authClientProvider().listUsers()) {
                is AuthResult.Success -> {
                    log.info("loadUsers.ok", mapOf("count" to result.value.size))
                    _state.update { it.copy(users = result.value, loadingUsers = false) }
                }
                is AuthResult.Failure -> {
                    log.warn("loadUsers.failed", mapOf("error" to result.error::class.simpleName))
                    _state.update { it.copy(loadingUsers = false, error = messageFor(result.error)) }
                }
            }
        }
    }

    private fun appendDigit(digit: Char) {
        val current = _state.value
        if (current.submitting || current.pin.length >= PIN_LENGTH) return
        val next = current.pin + digit
        _state.update { it.copy(pin = next, error = null) }
        if (next.length == PIN_LENGTH) submit(current.selectedUser, next)
    }

    private fun submit(user: AuthUserLite?, pin: String) {
        if (user == null) return
        log.info("login.start", mapOf("userIdLength" to user.userId.length)) // PIN intentionally omitted
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            when (val result = authClientProvider().login(user.userId, pin)) {
                is AuthResult.Success -> {
                    val authenticated = result.value.user
                    if (authenticated.userId.isBlank()) {
                        log.warn("login.rejected", mapOf("reason" to "missing-authenticated-id"))
                        _state.update {
                            it.copy(submitting = false, pin = "", error = "Something went wrong. Please try again.")
                        }
                        return@launch
                    }
                    log.info("login.ok", mapOf("userIdLength" to authenticated.userId.length))
                    tokenStore.save(result.value.token)
                    // Persist presentation data separately from the explicit server
                    // identity. The callback is the only transport into the
                    // authenticated UserSessionManager boundary, and runs first so
                    // navigation cannot build a session from display-name state.
                    onAuthenticated(authenticated)
                    displayNameStore.save(authenticated.displayName)
                }
                is AuthResult.Failure -> {
                    log.warn("login.failed", mapOf("error" to result.error::class.simpleName))
                    _state.update {
                        it.copy(submitting = false, pin = "", error = messageFor(result.error))
                    }
                }
            }
        }
    }

    private fun messageFor(error: AuthError): String = when (error) {
        AuthError.InvalidCredentials -> "Incorrect PIN. Try again."
        is AuthError.Network -> "Can't reach the server. Check your connection."
        is AuthError.Server -> "Server error. Please try again."
        is AuthError.Unknown -> "Something went wrong. Please try again."
    }
}
