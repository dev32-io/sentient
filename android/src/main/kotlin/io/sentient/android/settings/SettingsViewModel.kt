// ---------------------------------------------------------------------------
// SettingsViewModel — the logout command surface for the thin Settings screen
// (D-A5). v1 Settings is INTENTIONALLY THIN (operator directive: show version,
// add the rest later), so the only side-effecting action here is logout.
//
// Logout is the inverse of the AuthViewModel login flow:
//   login:  tokenStore.save(token) + displayNameStore.save(name)
//   logout: tokenStore.clear() + displayNameStore.clear()
//
// Clearing displayName flips the auth gate (displayName == null). The actual SDK
// teardown on logout is owned by AppNavHost: it calls UserSessionManager.shutdown()
// (disconnect + cancel scope) alongside this logout(). So this VM only clears the
// persisted auth state. Mirrors iOS: clearing the store flips the nav gate.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.lifecycle.ViewModel
import io.sentient.android.sdk.AppDependencies
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.DisplayNameStore
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore

/**
 * Drives the Settings screen's only command: [logout]. Default constructor reads
 * from [AppDependencies]; both params are injectable for tests.
 *
 * @param tokenStore The same store login wrote to; clearing it prevents auto-resume.
 * @param displayNameStore Clearing this flips the nav gate to the login screen.
 */
class SettingsViewModel(
    private val tokenStore: SecureTokenStore = AppDependencies.tokenStore,
    private val displayNameStore: DisplayNameStore = DisplayNameHolder.store,
) : ViewModel() {
    private val log = createLogger("android", "settings-viewmodel")

    /**
     * Logs the user out: clears the persisted token + display name. Idempotent —
     * [SecureTokenStore.clear] and [DisplayNameStore.clear] are both safe to call
     * when already logged out. AppNavHost pairs this with UserSessionManager.shutdown()
     * for the SDK disconnect + scope cancel, then routes to login.
     */
    fun logout() {
        log.info("logout.start")
        tokenStore.clear()
        displayNameStore.clear()
        log.info("logout.done")
    }
}
