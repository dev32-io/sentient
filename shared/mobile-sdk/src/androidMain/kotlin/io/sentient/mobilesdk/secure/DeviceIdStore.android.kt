// ---------------------------------------------------------------------------
// DeviceIdStore.android — plain SharedPreferences-backed device id persistence.
//
// The device id is a stable correlator, not a secret, so it lives in a plain
// (unencrypted) SharedPreferences file — no Keystore overhead. Resolves the
// application Context from AndroidContextHolder, the same pattern as the token
// store's no-arg factory.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import android.content.Context
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("secure", "device-id", "android")

private const val PREFS_FILE = "sentient.device.prefs"
private const val PREF_KEY_DEVICE_ID = "sentient.device.id"

/** Android [DeviceIdStore] backed by a private SharedPreferences file. */
class AndroidDeviceIdStore(context: Context) : DeviceIdStore {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    override fun load(): String? = prefs.getString(PREF_KEY_DEVICE_ID, null)

    override fun save(id: String) {
        prefs.edit().putString(PREF_KEY_DEVICE_ID, id).apply()
        log.info("save", mapOf("len" to id.length))
    }
}

/** Convenience factory resolving the Context from [AndroidContextHolder]. */
fun AndroidDeviceIdStore(): AndroidDeviceIdStore =
    AndroidDeviceIdStore(AndroidContextHolder.requireContext())
