// ---------------------------------------------------------------------------
// BackendConfigStore — persists the user-entered BackendConfig (SharedPreferences)
// and exposes it as a StateFlow seeded synchronously so the app's first frame
// knows whether to force the setup page. save() updates both prefs and the flow.
// BackendConfigHolder is the process singleton, initialised in SentientApp.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import android.content.Context
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PREFS = "backend_config"
private const val KEY_HOST = "host"
private const val KEY_PORT = "port"
private const val KEY_SECURITY = "security"

class BackendConfigStore(context: Context) {
    private val log = createLogger("android", "backend-config-store")
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _config = MutableStateFlow(read())

    /** Current persisted override, or null if the user never set one. */
    val config: StateFlow<BackendConfig?> = _config.asStateFlow()

    fun save(config: BackendConfig) {
        log.info("save", mapOf("host" to config.host, "port" to config.port, "security" to config.security.name))
        prefs.edit()
            .putString(KEY_HOST, config.host)
            .putInt(KEY_PORT, config.port)
            .putString(KEY_SECURITY, config.security.name)
            .apply()
        _config.value = config
    }

    private fun read(): BackendConfig? {
        val host = prefs.getString(KEY_HOST, null) ?: return null
        val port = prefs.getInt(KEY_PORT, -1).takeIf { it in 1..65535 } ?: return null
        val security = prefs.getString(KEY_SECURITY, null)
            ?.let { runCatching { ConnectionSecurity.valueOf(it) }.getOrNull() } ?: return null
        return BackendConfig(host, port, security)
    }
}

/** Process singleton. [init] runs once in SentientApp.onCreate (has app context). */
object BackendConfigHolder {
    @Volatile private var instance: BackendConfigStore? = null
    fun init(context: Context) { if (instance == null) instance = BackendConfigStore(context) }
    val store: BackendConfigStore
        get() = instance ?: error("BackendConfigHolder.init not called (SentientApp.onCreate)")
}
