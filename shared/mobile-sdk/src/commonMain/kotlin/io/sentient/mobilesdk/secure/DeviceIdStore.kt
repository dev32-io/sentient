// ---------------------------------------------------------------------------
// DeviceIdStore — boundary interface for the stable per-install device id.
//
// The gateway REQUIRES a stable deviceId in session.configure (Task 3.10) so it
// can key the per-device replay buffer across reconnects. The id is generated
// ONCE per install and persisted; every connect (and stream.resume) sends the
// same value. Mirrors web-sdk's device-id.ts get-or-create-from-localStorage.
//
// commonMain owns the boundary + the get-or-create logic; the actual persistence
// is platform (Android SharedPreferences / iOS NSUserDefaults) behind this
// interface, so commonMain stays pure (no platform APIs) and tests inject a fake.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

/**
 * Persistent storage for the stable per-install device id.
 *
 * Implementations need not be encrypted — the device id is not a secret, just a
 * stable correlator. Plain SharedPreferences / NSUserDefaults is sufficient.
 * Implementations MUST be safe to call from any coroutine dispatcher.
 */
interface DeviceIdStore {
    /** Reads the stored device id, or null if none has been persisted yet. */
    fun load(): String?

    /** Persists [id], overwriting any previous value. */
    fun save(id: String)
}
