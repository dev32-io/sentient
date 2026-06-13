// ---------------------------------------------------------------------------
// SettingsViewModel — the command surface for the thin Settings screen (D-A5).
//
// Two commands:
//   - logout: clears the persisted token + display name (inverse of login). The SDK
//     teardown is owned by AppNavHost (UserSessionManager.shutdown()).
//   - send diagnostic log: list the vitals sessions, upload a chosen one, surface
//     per-upload progress + a ref/error result. The vitals facade owns the file
//     read + the authenticated POST; this VM just drives + folds the result.
//
// sessions is a SNAPSHOT taken at construction (the screen is entered fresh each
// time → a fresh VM → a fresh list); progress/result are hot StateFlows the row
// binds to so the button morphs into a progress bar and then a result line.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.sdk.AppDependencies
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.DisplayNameStore
import io.sentient.android.sdk.VitalsHolder
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.vitals.SentientMobileVitals
import io.sentient.mobilesdk.vitals.VitalsSessionInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Terminal upload outcome surfaced on the row, or null while idle/in-flight. */
sealed interface UploadOutcome {
    /** Uploaded; [ref] is the server ref ("" when the upload succeeded but no ref parsed). */
    data class Sent(val ref: String) : UploadOutcome
    /** Upload failed (transport error / non-2xx / missing body). Offer a retry. */
    data object Failed : UploadOutcome
}

/**
 * Drives the Settings screen's commands. Default constructor reads app singletons;
 * every param is injectable for tests (no DI framework).
 *
 * @param tokenStore The same store login wrote to; clearing it prevents auto-resume.
 * @param displayNameStore Clearing this flips the nav gate to the login screen.
 * @param vitals The app-lifetime diagnostic facade (list + upload sessions).
 * @param readBody Reads a chosen session's file body for upload. Defaults to the holder.
 */
class SettingsViewModel(
    private val tokenStore: SecureTokenStore = AppDependencies.tokenStore,
    private val displayNameStore: DisplayNameStore = DisplayNameHolder.store,
    private val vitals: SentientMobileVitals = VitalsHolder.vitals,
    private val readBody: (String) -> String? = VitalsHolder::readSessionBody,
) : ViewModel() {
    private val log = createLogger("android", "settings-viewmodel")

    /** Newest-first vitals sessions, snapshotted at construction. */
    val sessions: List<VitalsSessionInfo> = vitals.listSessions()

    // Upload progress in [0,1]; null = idle / done. The row morphs into a bar while non-null.
    private val _progress = MutableStateFlow<Float?>(null)
    val progress: StateFlow<Float?> = _progress.asStateFlow()

    // Terminal outcome (ref or failure); null until an upload completes.
    private val _outcome = MutableStateFlow<UploadOutcome?>(null)
    val outcome: StateFlow<UploadOutcome?> = _outcome.asStateFlow()

    /**
     * Upload the session at [path]. Drives [progress] during the POST and sets [outcome]
     * on completion. A missing/unreadable body is a Failed outcome (never throws).
     */
    fun uploadSession(path: String) {
        val fileName = path.substringAfterLast('/')
        log.info("upload.start", mapOf("file" to fileName))
        _outcome.value = null
        _progress.value = 0f
        viewModelScope.launch {
            val body = readBody(path)
            if (body == null) {
                log.warn("upload.no-body", mapOf("reason" to "unreadable", "file" to fileName))
                _progress.value = null
                _outcome.value = UploadOutcome.Failed
                return@launch
            }
            val ref = vitals.upload(fileName, body) { p -> _progress.value = p.toFloat() }
            _progress.value = null
            _outcome.value = if (ref != null) UploadOutcome.Sent(ref) else UploadOutcome.Failed
            log.info("upload.done", mapOf("file" to fileName, "ok" to (ref != null), "ref" to (ref ?: "-")))
        }
    }

    /**
     * Logs the user out: clears the persisted token + display name. Idempotent.
     * AppNavHost pairs this with UserSessionManager.shutdown() + routes to login.
     */
    fun logout() {
        log.info("logout.start")
        tokenStore.clear()
        displayNameStore.clear()
        log.info("logout.done")
    }
}
