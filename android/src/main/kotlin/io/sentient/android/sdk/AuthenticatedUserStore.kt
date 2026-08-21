// ---------------------------------------------------------------------------
// AuthenticatedUserStore — the explicit server-authenticated identity retained
// across process recreation. It is separate from DisplayNameStore on purpose:
// display names are presentation data and can never select a cache namespace.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PREFS = "authenticated_user"
private const val KEY_USER_ID = "auth.userId"

class AuthenticatedUserStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _userId = MutableStateFlow(read())

    /** The explicit server-authenticated user id, or null before login/after logout. */
    val userId: StateFlow<String?> = _userId.asStateFlow()

    fun save(userId: String) {
        val normalized = userId.trim()
        require(normalized.isNotEmpty()) { "authenticated user id must not be blank" }
        prefs.edit().putString(KEY_USER_ID, normalized).apply()
        _userId.value = normalized
    }

    fun clear() {
        prefs.edit().remove(KEY_USER_ID).apply()
        _userId.value = null
    }

    private fun read(): String? = prefs.getString(KEY_USER_ID, null)?.trim()?.takeIf { it.isNotEmpty() }
}

/** Process singleton initialized before Koin in [io.sentient.android.SentientApp]. */
object AuthenticatedUserHolder {
    @Volatile private var instance: AuthenticatedUserStore? = null

    fun init(context: Context) {
        if (instance == null) synchronized(this) {
            if (instance == null) instance = AuthenticatedUserStore(context)
        }
    }

    val store: AuthenticatedUserStore
        get() = instance ?: error("AuthenticatedUserHolder.init not called (SentientApp.onCreate)")
}
