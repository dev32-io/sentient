// ---------------------------------------------------------------------------
// SettingsViewModel — the logout command surface for the thin Settings screen
// (D-A5). v1 Settings is INTENTIONALLY THIN (operator directive: show version,
// add the rest later), so the only side-effecting action here is logout.
//
// Logout is the inverse of the AuthViewModel login flow:
//   login:  tokenStore.save(token) + displayNameStore.save(name)
//   logout: tokenStore.clear() + displayNameStore.clear()
//
// Clearing displayName flips the nav gate (displayName == null) in
// AppConfiguredRoot → login screen. Unmounting ChatRoot calls
// ChatViewModel.onCleared → chatSession.close() → sdk.disconnect(). So logout
// does NOT need a direct SDK disconnect call — unmounting the chat composable
// is the teardown path. Mirrors iOS: clearing the store flips the nav gate.
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
     * when already logged out. Clearing displayName flips [AppConfiguredRoot]'s nav
     * gate → login, which unmounts ChatRoot → ChatViewModel.onCleared → session.close()
     * (SDK disconnect). No direct SDK call is needed here.
     */
    fun logout() {
        log.info("logout.start")
        tokenStore.clear()
        displayNameStore.clear()
        log.info("logout.done")
    }
}
