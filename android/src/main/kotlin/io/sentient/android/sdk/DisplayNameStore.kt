// ---------------------------------------------------------------------------
// DisplayNameStore — persists the logged-in user's display name in
// SharedPreferences and exposes it as a StateFlow so the chat / history-drawer
// headers update reactively the moment login saves it.
//
// AuthUserLite (and AuthViewModel) are login-scoped and torn down after a
// successful login, so the selected user's display name is persisted here at
// login time and read back for the post-login headers. The flow is seeded
// synchronously so the first chat frame can show the real name.
//
// This is a DISPLAY name, not a secret — it NEVER travels through the token /
// SecureTokenStore path. Cleared on logout (alongside the token) so a logged-out
// relaunch never shows a stale name. Mirrors BackendConfigStore's style + the
// iOS DisplayNameStore role.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import android.content.Context
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PREFS = "display_name"
private const val KEY_DISPLAY_NAME = "auth.displayName"

class DisplayNameStore(context: Context) {
    private val log = createLogger("android", "display-name-store")
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _name = MutableStateFlow(read())

    /** Current persisted display name, or null when nothing is stored (pre-login / post-logout). */
    val name: StateFlow<String?> = _name.asStateFlow()

    /** Persist the display name. Blank input is treated as a clear (no stale name). */
    fun save(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            clear()
            return
        }
        log.info("save")
        prefs.edit().putString(KEY_DISPLAY_NAME, trimmed).apply()
        _name.value = trimmed
    }

    /** Remove the persisted display name. Called on logout. Idempotent. */
    fun clear() {
        log.info("clear")
        prefs.edit().remove(KEY_DISPLAY_NAME).apply()
        _name.value = null
    }

    /** Read the persisted name, or null when nothing stored / the stored value is blank. */
    private fun read(): String? =
        prefs.getString(KEY_DISPLAY_NAME, null)?.trim()?.takeIf { it.isNotEmpty() }
}

/** Process singleton. [init] runs once in SentientApp.onCreate (has app context). */
object DisplayNameHolder {
    @Volatile private var instance: DisplayNameStore? = null

    fun init(context: Context) {
        if (instance == null) synchronized(this) {
            if (instance == null) instance = DisplayNameStore(context)
        }
    }

    val store: DisplayNameStore
        get() = instance ?: error("DisplayNameHolder.init not called (SentientApp.onCreate)")
}
