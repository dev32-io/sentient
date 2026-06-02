// ---------------------------------------------------------------------------
// SessionIdStore.ios.kt — NSUserDefaults-backed session-ID persistence.
//
// The session ID is an ephemeral resume handle, not a credential. NSUserDefaults
// is the appropriate store — no Keychain overhead needed for a non-secret value.
// See SecureTokenStore.ios.kt for the Keychain-backed implementation that
// protects the actual auth token.
//
// Defaults suite: standard (NSUserDefaults.standardUserDefaults).
// Key: DEFAULTS_KEY_SESSION_ID.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.log.createLogger
import platform.Foundation.NSUserDefaults

private val log = createLogger("secure", "session-id-store", "ios")

private const val DEFAULTS_KEY_SESSION_ID = "io.sentient.app.session.id"

/**
 * iOS [SessionIdStore] backed by [NSUserDefaults].
 *
 * No initialisation is required on iOS — NSUserDefaults is always available.
 */
class IosSessionIdStore : SessionIdStore {

    private val defaults = NSUserDefaults.standardUserDefaults

    override fun get(): String? {
        val id = defaults.stringForKey(DEFAULTS_KEY_SESSION_ID)
        log.debug("get", mapOf("present" to (id != null)))
        return id
    }

    override fun set(id: String) {
        log.debug("set", mapOf("idLength" to id.length))
        try {
            defaults.setObject(id, DEFAULTS_KEY_SESSION_ID)
            log.info("set-ok")
        } catch (e: Exception) {
            log.warn("set-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }

    override fun clear() {
        log.debug("clear")
        try {
            defaults.removeObjectForKey(DEFAULTS_KEY_SESSION_ID)
            log.info("clear-ok")
        } catch (e: Exception) {
            log.warn("clear-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }
}
