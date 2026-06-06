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
// (hasSession ⇒ chat, else login), matching the codebase's event-driven UX
// inference. disconnect() defaults to clearSession=true, which clears hasSession,
// so AppRoot swaps to login. (A clean idle-disconnect uses clearSession=false to
// KEEP hasSession, so it stays on chat and auto-reconnects — logout is distinct.)
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.lifecycle.ViewModel
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.DisplayNameStore
import io.sentient.android.sdk.SdkHolder
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.sdk.SentientSdk

/**
 * Drives the Settings screen's only command: [logout]. Default constructor reads
 * the current SDK from [SdkHolder.sdkFlow] at call time so a backend rebuild is
 * reflected without recreating this ViewModel; both params are injectable for tests.
 *
 * @param sdkProvider Returns the current SDK (disconnect tears down WS + cancels).
 * @param tokenStore The same store login wrote to; clearing it prevents auto-resume.
 */
class SettingsViewModel(
    private val sdkProvider: () -> SentientSdk? = { SdkHolder.sdkFlow.value },
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
    private val displayNameStore: DisplayNameStore = DisplayNameHolder.store,
) : ViewModel() {
    private val log = createLogger("android", "settings-viewmodel")

    /**
     * Logs the user out: disconnect (WS teardown + cycle cancel) then clear the
     * persisted token. Idempotent — [SentientSdk.disconnect] and
     * [SecureTokenStore.clear] are both safe to call when already logged out.
     * disconnect()'s default clearSession=true clears hasSession, so
     * [MainActivity]'s AppRoot swaps to login.
     */
    fun logout() {
        log.info("logout.start")
        sdkProvider()?.disconnect()
        tokenStore.clear()
        // Clear the persisted display name alongside the token so a logged-out
        // relaunch never shows a stale name (parity: iOS SdkStore.logout). The
        // store's flow flips to null → headers fall back to the neutral default.
        displayNameStore.clear()
        log.info("logout.done")
    }
}
