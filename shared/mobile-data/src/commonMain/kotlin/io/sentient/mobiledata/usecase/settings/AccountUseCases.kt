// ---------------------------------------------------------------------------
// AccountUseCases — identity ops: read me, rename, change PIN, logout. Thin, but
// owns two side effects the repo (stateless) must not:
//   - on a successful me / rename the gateway rolls a fresh token; [onTokenRefreshed]
//     persists it so the drawer header reflects the new display name.
//   - logout ALWAYS clears local session via [onLoggedOut], even if the server
//     ack fails — a sign-out must never leave the user stuck signed-in.
//
// changePin returns a typed outcome so a wrong-current-PIN (gateway 401) surfaces
// as an INLINE error with NO token drop — distinct from a session-expiry 401.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.AccountRepository
import io.sentient.mobiledata.data.settings.toSentientError
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AuthUser
import io.sentient.mobilesdk.result.SentientError

/** Outcome of a PIN change. WrongCurrentPin is recoverable + inline; NEVER drops the token. */
sealed interface ChangePinOutcome {
    data object Ok : ChangePinOutcome
    data object WrongCurrentPin : ChangePinOutcome
    data class Error(val error: SentientError) : ChangePinOutcome
}

class AccountUseCases(
    private val account: AccountRepository,
    private val onTokenRefreshed: (String) -> Unit = {},
    private val onLoggedOut: () -> Unit = {},
) {
    private val log = createLogger("data", "settings", "account")

    /** Current identity (incl. isAdmin); persists the rolled token. */
    suspend fun me(): SentientResult<AuthUser> = when (val r = account.me()) {
        is SentientResult.Success -> {
            onTokenRefreshed(r.data.token)
            SentientResult.Success(r.data.user)
        }
        is SentientResult.Failure -> r
        is SentientResult.Loading -> SentientResult.Loading()
    }

    /** Rename; on success rolls the token so the new name propagates to the session header. */
    suspend fun updateDisplayName(displayName: String): SentientResult<AuthUser> =
        when (val r = account.updateDisplayName(displayName)) {
            is SentientResult.Success -> {
                onTokenRefreshed(r.data.token)
                log.info("displayName.updated", mapOf("len" to displayName.length))
                SentientResult.Success(r.data.user)
            }
            is SentientResult.Failure -> r
            is SentientResult.Loading -> SentientResult.Loading()
        }

    /** Change PIN. Wrong current PIN → WrongCurrentPin (inline, no token drop). Values never logged. */
    suspend fun changePin(currentPin: String, newPin: String): ChangePinOutcome =
        when (val r = account.changePin(currentPin, newPin)) {
            is AuthResult.Success -> {
                log.info("pin.changed")
                ChangePinOutcome.Ok
            }
            is AuthResult.Failure -> when (r.error) {
                AuthError.InvalidCredentials -> {
                    log.warn("pin.wrong-current")
                    ChangePinOutcome.WrongCurrentPin
                }
                else -> ChangePinOutcome.Error(r.error.toSentientError(terminalAuth = false))
            }
        }

    /** Best-effort server logout, then ALWAYS clear local session. Never fails the user out-of-flow. */
    suspend fun logout(): SentientResult<Unit> {
        val r = account.logout()
        onLoggedOut()
        log.info("logout", mapOf("serverAck" to (r is SentientResult.Success)))
        return SentientResult.Success(Unit)
    }
}
