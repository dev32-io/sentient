// ---------------------------------------------------------------------------
// DevicesViewModel — thin state-holder for the Devices (Signal) settings page.
// Imperative ops over SettingsComponent.devices (DevicesUseCases): fetch state,
// start/cancel/unlink linking, and drive the status-poll loop.
//
// Poll lifecycle: startLink launches ONE job that fires linkStart then collects
// pollLinkStatus (2s cadence, webui parity). The collect exits on a terminal status
// (linked → success+refresh; error → retryable Error). A `finally { NonCancellable
// linkCancel() }` fires the server-side cancel on ANY abandonment — the explicit
// Cancel button, a poll error/timeout, OR leaving the screen (onCleared cancels the
// job) — but NOT on a successful link. This is the "leaving screen cancels + poll
// stops" contract. No secrets here; only ids/lengths/states are logged.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.DevicesUseCases
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.SignalLinkStatusResponse
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val POLL_INTERVAL_MS = 2_000L
private const val STATE_LINKED = "linked"
private const val ERR_LINK_FAILED = "Linking failed. Try again."
private const val ERR_UNLINK_FAILED = "Couldn't unlink Signal. Try again."

/** The Signal card's top-level state. */
sealed interface SignalCardState {
    data object Loading : SignalCardState
    data class Linked(val accountMasked: String?, val linkedAt: String?) : SignalCardState
    data object Unlinked : SignalCardState
}

/** The in-progress linking overlay's state (Idle = overlay hidden). */
sealed interface LinkFlowState {
    data object Idle : LinkFlowState
    data object Starting : LinkFlowState
    data class AwaitingScan(val qrDataUrl: String, val expiresAt: Long?) : LinkFlowState
    data class Error(val message: String) : LinkFlowState
}

data class DevicesUiState(
    val card: SignalCardState = SignalCardState.Loading,
    val link: LinkFlowState = LinkFlowState.Idle,
    val unlinkConfirmOpen: Boolean = false,
    val busy: Boolean = false,
    /** One-off inline error (e.g. a failed unlink); distinct from the linking overlay's own error. */
    val errorMessage: String? = null,
)

class DevicesViewModel(
    private val devices: DevicesUseCases,
) : ViewModel() {
    private val log = createLogger("android", "settings", "devices-vm")

    private val _state = MutableStateFlow(DevicesUiState())
    val state: StateFlow<DevicesUiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    init {
        refresh()
    }

    /** (Re)load the Signal pairing state. A failure leaves the last-known card intact. */
    fun refresh() {
        viewModelScope.launch {
            when (val r = devices.getDevices()) {
                is SentientResult.Success -> {
                    val signal = r.data.platforms.signal
                    _state.update {
                        it.copy(
                            card = if (signal.paired) {
                                SignalCardState.Linked(signal.accountMasked, signal.linkedAt)
                            } else {
                                SignalCardState.Unlinked
                            },
                            errorMessage = null,
                        )
                    }
                    log.info("devices.loaded", mapOf("paired" to signal.paired))
                }
                is SentientResult.Failure -> log.warn("devices.failed", mapOf("kind" to r.error.kind))
                is SentientResult.Loading -> Unit
            }
        }
    }

    /** Begin linking: request the QR, then poll status until a terminal state. */
    fun startLink() {
        if (pollJob?.isActive == true) return
        _state.update { it.copy(link = LinkFlowState.Starting, errorMessage = null) }
        pollJob = viewModelScope.launch {
            var linked = false
            try {
                if (!beginLink()) return@launch
                devices.pollLinkStatus(POLL_INTERVAL_MS).collect { r ->
                    if (foldPoll(r)) linked = true
                }
            } finally {
                if (!linked) withContext(NonCancellable) { devices.linkCancel() }
            }
        }
    }

    /** linkStart → AwaitingScan, or Error. Returns false when the loop must not start. */
    private suspend fun beginLink(): Boolean = when (val r = devices.linkStart()) {
        is SentientResult.Success -> {
            _state.update { it.copy(link = LinkFlowState.AwaitingScan(r.data.qrDataUrl, r.data.expiresAt)) }
            log.info("link.started", mapOf("expiresAt" to r.data.expiresAt))
            true
        }
        is SentientResult.Failure -> {
            _state.update { it.copy(link = LinkFlowState.Error(r.error.userMessage)) }
            log.warn("link.start-failed", mapOf("kind" to r.error.kind))
            false
        }
        is SentientResult.Loading -> false
    }

    /** Fold one poll emission. Returns true iff it was the terminal LINKED success. */
    private fun foldPoll(r: SentientResult<SignalLinkStatusResponse>): Boolean = when (r) {
        is SentientResult.Success -> when {
            r.data.state == STATE_LINKED -> {
                log.info("link.success")
                _state.update { it.copy(link = LinkFlowState.Idle) }
                refresh()
                true
            }
            r.data.error != null -> {
                log.warn("link.error", mapOf("hasError" to true))
                _state.update { it.copy(link = LinkFlowState.Error(ERR_LINK_FAILED)) }
                false
            }
            else -> false // still awaiting scan — keep polling
        }
        is SentientResult.Failure -> {
            if (!r.error.recoverable) _state.update { it.copy(link = LinkFlowState.Error(r.error.userMessage)) }
            false // transient failures keep polling; the usecase loop stops on non-recoverable
        }
        is SentientResult.Loading -> false
    }

    /** Abandon linking: stop the poll (fires server cancel via the job's finally) and hide the overlay. */
    fun cancelLink() {
        pollJob?.cancel()
        pollJob = null
        _state.update { it.copy(link = LinkFlowState.Idle) }
    }

    fun retryLink() {
        cancelLink()
        startLink()
    }

    fun openUnlinkConfirm() = _state.update { it.copy(unlinkConfirmOpen = true) }

    fun closeUnlinkConfirm() = _state.update { it.copy(unlinkConfirmOpen = false) }

    /** Unlink the Signal account (imperative), then refetch the card. */
    fun unlink() {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            when (val r = devices.unlink()) {
                is SentientResult.Success -> {
                    log.info("unlink.ok")
                    _state.update { it.copy(busy = false, unlinkConfirmOpen = false) }
                    refresh()
                }
                is SentientResult.Failure -> {
                    log.warn("unlink.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(busy = false, unlinkConfirmOpen = false, errorMessage = ERR_UNLINK_FAILED) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }
}
