// ---------------------------------------------------------------------------
// UpdateViewModel — the single, shared OTA-update state holder.
//
// Holds ONE hot StateFlow<UpdateStatus> that three consumers observe:
//   - the force-update gate in AppNavHost (routes to ForceUpdateScreen on mandatory),
//   - the Settings update row (status text + check/install action),
//   - the foreground-trigger in the presence relay (calls check() on real foreground).
//
// Because all three must see the SAME status, this VM is provided as a Koin
// `single` (one process-lived instance), resolved via koinInject — NOT a
// per-route koinViewModel. It still extends ViewModel so check()/install() run on
// viewModelScope; the scope lives for the process (the single is never cleared),
// which is correct for app/connection-scoped update state.
//
// Thin by design: it delegates the manifest fetch to the shared UpdateChecker (B2)
// and the install to AppUpdateInstaller (B3/B4). No combine/transform lives here.
// ---------------------------------------------------------------------------
package io.sentient.android.update

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.UpdateChecker
import io.sentient.mobilesdk.update.UpdateStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Drives the OTA-update surface. [checker] fetches the release manifest + compares
 * the installed build; [installer] downloads + hands the artifact to the platform
 * installer. Both come from the connection scope (UserSessionManager) so they carry
 * the resolved gateway host. Every param is injectable for tests (no DI framework).
 */
class UpdateViewModel(
    private val checker: UpdateChecker,
    private val installer: AppUpdateInstaller,
) : ViewModel() {
    private val log = createLogger("android", "update-viewmodel")

    private val _status = MutableStateFlow<UpdateStatus>(UpdateStatus.UpToDate)

    /** Latest known update status. Starts [UpdateStatus.UpToDate]; no check runs until requested. */
    val status: StateFlow<UpdateStatus> = _status.asStateFlow()

    /** Fetch the manifest and fold the result into [status]. Never throws (checker is typed). */
    fun check() {
        viewModelScope.launch {
            log.info("check.start")
            val result = checker.check()
            _status.value = result
            log.info("check.result", mapOf("status" to result::class.simpleName.orEmpty()))
        }
    }

    /** Install the current target. No-op unless [status] is [UpdateStatus.Available]. */
    fun install() {
        val current = _status.value
        if (current !is UpdateStatus.Available) {
            log.warn("install.no-target", mapOf("status" to current::class.simpleName.orEmpty()))
            return
        }
        viewModelScope.launch {
            log.info("install.start", mapOf("build" to current.latestBuild))
            val result = installer.start(current.target)
            log.info("install.result", mapOf("result" to result::class.simpleName.orEmpty()))
        }
    }
}
