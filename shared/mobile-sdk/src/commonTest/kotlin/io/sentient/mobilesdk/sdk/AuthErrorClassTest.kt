package io.sentient.mobilesdk.sdk
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
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

    // Throwable overload — the connection-scope crash guard's auth-vs-transient
    // routing decision (auth → login, transient → recover). Security boundary.
    @Test fun terminal_auth_request_exception_routes_to_login() {
        assertTrue(isTerminalAuthError(SessionsRequestException("auth-required", "no token")))
        assertTrue(isTerminalAuthError(SessionsRequestException("user-not-found", "gone")))
    }
    @Test fun non_auth_throwables_stay_transient() {
        assertFalse(isTerminalAuthError(SessionsRequestException("rate-limited", "slow down")))
        assertFalse(isTerminalAuthError(SessionsTimeoutException("session.switched")))
        assertFalse(isTerminalAuthError(RuntimeException("socket closed")))
    }
}
