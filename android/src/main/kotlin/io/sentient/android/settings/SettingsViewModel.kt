// ---------------------------------------------------------------------------
// SettingsViewModel — the logout command surface for the thin Settings screen
// (D-A5). v1 Settings is INTENTIONALLY THIN (operator directive: show version,
// add the rest later), so the only side-effecting action here is logout.
//
// Logout is the inverse of the AuthViewModel login flow: login does
//   tokenStore.save(token) → sdk.connect()
// so logout does
//   sdk.disconnect() → tokenStore.clear()
// We disconnect FIRST (tears down WS + cancels the cycle) then clear the token,
// so the SDK can't read a half-cleared store mid-teardown. Clearing the token is
// what makes a relaunch land on login (the orchestrator reads the token on
// connect; no token ⇒ no auto-resume). Navigation back to login is NOT modelled
// here — MainActivity derives login-vs-chat from the SDK's single state surface
// (status != READY ⇒ login), matching the codebase's event-driven UX inference.
// disconnect() drives status away from READY, so AppRoot swaps to login.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.lifecycle.ViewModel
import io.sentient.android.sdk.SdkHolder
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.sdk.SentientSdk

/**
 * Drives the Settings screen's only command: [logout]. Default constructor pulls
 * the process singletons from [SdkHolder]; both params are injectable for tests.
 *
 * @param sdk The process-singleton SDK (disconnect tears down WS + cancels).
 * @param tokenStore The same store login wrote to; clearing it prevents auto-resume.
 */
class SettingsViewModel(
    private val sdk: SentientSdk = SdkHolder.sdk,
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
) : ViewModel() {
    private val log = createLogger("android", "settings-viewmodel")

    /**
     * Logs the user out: disconnect (WS teardown + cycle cancel) then clear the
     * persisted token. Idempotent — [SentientSdk.disconnect] and
     * [SecureTokenStore.clear] are both safe to call when already logged out. The
     * resulting status != READY makes [MainActivity]'s AppRoot swap to login.
     */
    fun logout() {
        log.info("logout.start")
        sdk.disconnect()
        tokenStore.clear()
        log.info("logout.done")
    }
}
