package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AuthErrorClassTest {
    // ── Frame path: auth.error code → terminal unless explicitly retryable ──
    @Test fun frame_known_terminal_codes_are_terminal() {
        assertTrue(isTerminalAuthError("auth-required"))
        assertTrue(isTerminalAuthError("user-not-found"))
        assertTrue(isTerminalAuthError("token-validation-failed"))
    }

    @Test fun frame_gateway_token_error_codes_are_terminal() {
        // The actual bug: gateway sends these on token expiry/tamper; must route to login.
        assertTrue(isTerminalAuthError("expired"))
        assertTrue(isTerminalAuthError("malformed"))
        assertTrue(isTerminalAuthError("signature-invalid"))
        assertTrue(isTerminalAuthError("wrong-purpose"))
    }

    @Test fun frame_unknown_code_defaults_terminal() {
        // Inverted default: an auth rejection we do not recognise must surface re-login,
        // never loop forever.
        assertTrue(isTerminalAuthError("some-future-auth-code"))
    }

    @Test fun frame_explicitly_retryable_codes_are_not_terminal() {
        assertFalse(isTerminalAuthError("auth-timeout"))
        assertFalse(isTerminalAuthError("session-limit"))
        assertFalse(isTerminalAuthError("rate-limited"))
    }

    @Test fun frame_null_code_is_not_terminal() {
        assertFalse(isTerminalAuthError(null))
    }

    // ── Throwable path: sessions.error → terminal ONLY for a known credential code ──
    @Test fun throwable_known_auth_codes_are_terminal() {
        assertTrue(isTerminalAuthError(SessionsRequestException("auth-required", "no token")))
        assertTrue(isTerminalAuthError(SessionsRequestException("user-not-found", "gone")))
        assertTrue(isTerminalAuthError(SessionsRequestException("expired", "token expired")))
    }

    @Test fun throwable_non_auth_codes_are_not_terminal() {
        // A sessions error that is not an auth failure must NOT log the user out.
        assertFalse(isTerminalAuthError(SessionsRequestException("rate-limited", "slow down")))
        assertFalse(isTerminalAuthError(SessionsRequestException("not-found", "no such session")))
        assertFalse(isTerminalAuthError(SessionsTimeoutException("session.switched")))
        assertFalse(isTerminalAuthError(RuntimeException("socket closed")))
    }
}
