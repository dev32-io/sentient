// ---------------------------------------------------------------------------
// DeviceIdStore.ios — NSUserDefaults-backed device id persistence.
//
// The device id is a stable correlator, not a secret, so NSUserDefaults (plain)
// is sufficient — no Keychain needed. NSUserDefaults survives app restarts and
// is cleared on uninstall, which matches "stable per install".
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.log.createLogger
import platform.Foundation.NSUserDefaults

private val log = createLogger("secure", "device-id", "ios")

private const val DEFAULTS_KEY = "io.sentient.device.id"

/** iOS [DeviceIdStore] backed by NSUserDefaults.standardUserDefaults. */
class IosDeviceIdStore : DeviceIdStore {

    private val defaults = NSUserDefaults.standardUserDefaults

    override fun load(): String? = defaults.stringForKey(DEFAULTS_KEY)

    override fun save(id: String) {
        defaults.setObject(id, forKey = DEFAULTS_KEY)
        log.info("save", mapOf("len" to id.length))
    }
}
