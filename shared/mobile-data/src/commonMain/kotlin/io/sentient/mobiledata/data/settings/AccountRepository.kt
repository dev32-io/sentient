// ---------------------------------------------------------------------------
// AccountRepository — stateless mapper over the AuthClient identity surface.
//
// me / updateDisplayName return the refreshed AuthResponse (token + user, incl.
// isAdmin) so the usecase can persist the rolled token AND read isAdmin. changePin
// returns the raw AuthResult so the usecase can distinguish a wrong-current-PIN 401
// (recoverable, NO token drop) from a token-expiry 401 — the envelope can't carry
// that context, so this repo passes AuthResult through for that one op.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data.settings

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.auth.AuthResponse
import io.sentient.mobilesdk.auth.AuthResult

/** Stateless account/identity surface. */
interface AccountRepository {
    suspend fun me(): SentientResult<AuthResponse>
    suspend fun updateDisplayName(displayName: String): SentientResult<AuthResponse>
    /** Raw result — the usecase folds InvalidCredentials as a recoverable wrong-PIN, not a session drop. */
    suspend fun changePin(currentPin: String, newPin: String): AuthResult<Unit>
    suspend fun logout(): SentientResult<Unit>
}

/** AuthClient-backed AccountRepository. [token] supplies the current PASETO token per call. */
class SdkAccountRepository(
    private val auth: AuthClient,
    private val token: () -> String,
) : AccountRepository {

    override suspend fun me(): SentientResult<AuthResponse> = auth.me(token()).toEnvelope()

    override suspend fun updateDisplayName(displayName: String): SentientResult<AuthResponse> =
        auth.updateMe(token(), displayName).toEnvelope()

    override suspend fun changePin(currentPin: String, newPin: String): AuthResult<Unit> =
        auth.changePin(token(), currentPin, newPin)

    override suspend fun logout(): SentientResult<Unit> = auth.logout(token()).toEnvelope()
}
