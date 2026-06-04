// ---------------------------------------------------------------------------
// BackendSetupViewModel — drives the "Sentient backend setup" screen. Save folds
// in a reachability probe: build a throwaway AuthClient from the candidate config
// and call listUsers(); on success persist + applyResolvedConfig() (rebuild SDK)
// and signal success (UI shows a checkmark, then dismisses); on failure stay with
// an error. The token is cleared so a backend change never auto-resumes a stale
// session on a different backend.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.sdk.SdkHolder
import io.sentient.android.sdk.buildAuthHttpClient
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val DEFAULT_PORT = 8888

data class BackendSetupUiState(
    val host: String = "",
    val port: String = DEFAULT_PORT.toString(),
    val security: ConnectionSecurity = ConnectionSecurity.TLS_VALID,
    val saving: Boolean = false,
    val saved: Boolean = false,   // brief checkmark before dismiss
    val error: String? = null,
)

sealed interface BackendSetupIntent {
    data class SetHost(val v: String) : BackendSetupIntent
    data class SetPort(val v: String) : BackendSetupIntent
    data class SetSecurity(val v: ConnectionSecurity) : BackendSetupIntent
    data object Save : BackendSetupIntent
}

class BackendSetupViewModel(
    private val store: BackendConfigStore = BackendConfigHolder.store,
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
    private val probe: suspend (BackendConfig) -> AuthResult<*> = { c ->
        AuthClient(c.toGatewayWsUrl(), buildAuthHttpClient(c.allowSelfSigned())).listUsers()
    },
    private val onApplied: () -> Unit = { SdkHolder.applyResolvedConfig() },
) : ViewModel() {
    private val log = createLogger("android", "backend-setup-vm")
    private val _state = MutableStateFlow(prefill())
    val state: StateFlow<BackendSetupUiState> = _state.asStateFlow()

    private fun prefill(): BackendSetupUiState {
        val c = store.config.value ?: return BackendSetupUiState()
        return BackendSetupUiState(c.host, c.port.toString(), c.security)
    }

    fun dispatch(intent: BackendSetupIntent) = when (intent) {
        is BackendSetupIntent.SetHost -> _state.update { it.copy(host = intent.v.trim(), error = null) }
        is BackendSetupIntent.SetPort -> _state.update { it.copy(port = intent.v.filter(Char::isDigit), error = null) }
        is BackendSetupIntent.SetSecurity -> _state.update { it.copy(security = intent.v, error = null) }
        BackendSetupIntent.Save -> save()
    }

    private fun save() {
        val s = _state.value
        val port = s.port.toIntOrNull()
        if (s.host.isBlank()) { _state.update { it.copy(error = "Enter a host or IP.") }; return }
        if (port == null || port !in 1..65535) { _state.update { it.copy(error = "Port must be 1–65535.") }; return }
        val candidate = BackendConfig(s.host, port, s.security)
        log.info("save.probe", mapOf("host" to s.host, "port" to port, "security" to s.security.name))
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            when (val r = probe(candidate)) {
                is AuthResult.Success -> {
                    log.info("save.ok")
                    tokenStore.clear()
                    store.save(candidate)
                    onApplied()
                    _state.update { it.copy(saving = false, saved = true) }
                }
                is AuthResult.Failure -> {
                    log.warn("save.failed", mapOf("error" to r.error::class.simpleName))
                    _state.update { it.copy(saving = false, error = messageFor(r.error)) }
                }
            }
        }
    }

    private fun messageFor(error: AuthError): String = when (error) {
        is AuthError.Network -> "Can't reach that server. Check the host, port, and TLS option."
        is AuthError.Server -> "Server reachable but returned an error. Check the address."
        AuthError.InvalidCredentials -> "Invalid credentials. Check the address and TLS option."
        is AuthError.Unknown -> "Couldn't verify the server. Check the address and TLS option."
    }
}
