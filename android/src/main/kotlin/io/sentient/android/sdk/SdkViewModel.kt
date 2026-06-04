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

    fun connect() {
        log.info("connect")
        viewModelScope.launch { sdk?.connect() }
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
        viewModelScope.launch { sdk?.setTtsEnabled(enabled) }
    }

    fun switchSession(sessionId: String) {
        log.info("switchSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch { sdk?.switchSession(sessionId) }
    }

    fun newChat() {
        log.info("newChat")
        viewModelScope.launch { sdk?.newChat() }
    }
}
