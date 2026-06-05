// ---------------------------------------------------------------------------
// SdkViewModel — the Compose-facing bridge to the singleton SentientSdk.
//
// The SDK owns the one observable surface (StateFlow<SdkState>); this ViewModel
// re-exposes it verbatim (no re-derivation, per the SDK's single-surface
// contract) and forwards user commands. suspend SDK ops run in viewModelScope
// so they cancel with the ViewModel; fire-and-forget ops (sendText, interrupt,
// mic toggles) are plain calls — the SDK launches their own work internally.
//
// The composable collects [state] via collectAsStateWithLifecycle(); this VM
// does not convert the flow to a snapshot itself, keeping the lifecycle-aware
// collection at the UI boundary where the rules place it.
//
// Re-points on backend change: flatMapLatest cancels the old SDK's state
// collection and starts collecting the rebuilt instance. The VM is only ever
// constructed in AppRoot's configured branch, so sdkFlow is non-null here.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.SdkState
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Bridges the process-singleton [SentientSdk] to Compose. Observes
 * [SdkHolder.sdkFlow] reactively so a backend change (applyResolvedConfig)
 * re-points the retained ViewModel at the rebuilt instance without recreating
 * the Activity/VM.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SdkViewModel : ViewModel() {
    private val log = createLogger("android", "sdk-viewmodel")

    // Re-point on backend change: flatMapLatest cancels the old SDK's state
    // collection and collects the rebuilt instance. sdkFlow is non-null here
    // because the VM is only constructed in AppRoot's configured branch.
    val state: StateFlow<SdkState> =
        SdkHolder.sdkFlow.filterNotNull()
            .flatMapLatest { it.state }
            .stateIn(viewModelScope, SharingStarted.Eagerly, SdkHolder.sdkFlow.value?.state?.value ?: SdkState())

    private val sdk: SentientSdk? get() = SdkHolder.sdkFlow.value

    // connect/newChat/setTtsEnabled call SDK suspend ops that can throw at the
    // session boundary (SessionsTimeoutException / SessionsRequestException, Task
    // 3 @Throws). A bare viewModelScope.launch would let that escape as an
    // uncaught coroutine exception → app crash, so each is wrapped in runCatching
    // and degraded to a logged WARN. The UI recovers via the connection banner /
    // cycle-error row (Task 8 B/D); a transient failure must never SIGABRT.
    fun connect() {
        log.info("connect")
        viewModelScope.launch {
            runCatching { sdk?.connect() }.onFailureNonCancellation { warn("connect-failed", it) }
        }
    }

    fun disconnect() {
        log.info("disconnect")
        sdk?.disconnect()
    }

    fun sendText(text: String) {
        log.info("sendText", mapOf("len" to text.length))
        sdk?.sendText(text)
    }

    fun interrupt() {
        log.info("interrupt")
        sdk?.interrupt()
    }

    fun startMic() {
        log.info("startMic")
        sdk?.startMic()
    }

    fun stopMic() {
        log.info("stopMic")
        sdk?.stopMic()
    }

    fun setTtsEnabled(enabled: Boolean) {
        log.info("setTtsEnabled", mapOf("enabled" to enabled))
        viewModelScope.launch {
            runCatching { sdk?.setTtsEnabled(enabled) }
                .onFailureNonCancellation { warn("tts-failed", it, mapOf("enabled" to enabled)) }
        }
    }

    fun newChat() {
        log.info("newChat")
        viewModelScope.launch {
            runCatching { sdk?.newChat() }.onFailureNonCancellation { warn("new-failed", it) }
        }
    }

    /**
     * Manual reconnect — passthrough to [SentientSdk.forceReconnect]. Drives the
     * connection-lost banner CTA (Task 8 B). Fire-and-forget: the SDK re-arms the
     * reconnect controller and runs the recovery loop on its own scope.
     */
    fun forceReconnect() {
        log.info("forceReconnect")
        sdk?.forceReconnect()
    }

    private fun warn(event: String, e: Throwable, extra: Map<String, Any?> = emptyMap()) {
        log.warn(event, extra + mapOf("reason" to (e.message ?: e::class.simpleName)))
    }
}

/**
 * Like [Result.onFailure] but rethrows [CancellationException] so a cancelled
 * viewModelScope (ViewModel cleared / Activity finishing) propagates instead of
 * being swallowed + logged as a spurious failure.
 */
private inline fun <T> Result<T>.onFailureNonCancellation(action: (Throwable) -> Unit): Result<T> =
    onFailure { if (it is CancellationException) throw it else action(it) }
