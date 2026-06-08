package io.sentient.mobilesdk.sdk
import kotlin.test.Test; import kotlin.test.assertTrue; import kotlin.test.assertFalse
class AuthErrorClassTest {
    @Test fun terminal_codes() {
        assertTrue(isTerminalAuthError("auth-required"))
        assertTrue(isTerminalAuthError("token-validation-failed"))
        assertTrue(isTerminalAuthError("user-not-found"))
    }
    @Test fun non_terminal_codes_stay_retryable() {
        assertFalse(isTerminalAuthError("rate-limited"))
        assertFalse(isTerminalAuthError(null))
    }
}
