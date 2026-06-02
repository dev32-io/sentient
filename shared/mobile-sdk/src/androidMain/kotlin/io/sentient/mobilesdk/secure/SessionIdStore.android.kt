// ---------------------------------------------------------------------------
// SessionIdStore.android.kt — Plain SharedPreferences session-ID persistence.
//
// The session ID is an ephemeral resume handle, not a credential. Plain
// SharedPreferences (no encryption) is intentional — security-crypto overhead
// is unwarranted for a non-secret value. See SecureTokenStore.android.kt for
// the Keystore-backed implementation that protects the actual auth token.
//
// Prefs file: "sentient.session.prefs" (MODE_PRIVATE, distinct from secure prefs).
// Key: PREF_KEY_SESSION_ID.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import android.content.Context
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("secure", "session-id-store", "android")

private const val PREFS_FILE = "sentient.session.prefs"
private const val PREF_KEY_SESSION_ID = "sentient.session.id"

/**
 * Android [SessionIdStore] backed by plain [android.content.SharedPreferences].
 *
 * The session ID is not a credential — plain storage is appropriate.
 * Construct with an application [Context], or use the no-arg factory which
 * resolves from [AndroidContextHolder].
 */
class AndroidSessionIdStore(context: Context) : SessionIdStore {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    override fun get(): String? {
        val id = prefs.getString(PREF_KEY_SESSION_ID, null)
        log.debug("get", mapOf("present" to (id != null)))
        return id
    }

    override fun set(id: String) {
        log.debug("set", mapOf("idLength" to id.length))
        try {
            prefs.edit().putString(PREF_KEY_SESSION_ID, id).apply()
            log.info("set-ok")
        } catch (e: Exception) {
            log.warn("set-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }

    override fun clear() {
        log.debug("clear")
        try {
            prefs.edit().remove(PREF_KEY_SESSION_ID).apply()
            log.info("clear-ok")
        } catch (e: Exception) {
            log.warn("clear-failed", mapOf("reason" to (e.message ?: e::class.simpleName ?: "unknown")))
        }
    }
}

/**
 * Convenience factory that resolves the Context from [AndroidContextHolder].
 */
fun AndroidSessionIdStore(): AndroidSessionIdStore =
    AndroidSessionIdStore(AndroidContextHolder.requireContext())
