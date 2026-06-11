// ---------------------------------------------------------------------------
// DeviceIdProvider — get-or-create the stable per-install device id.
//
// Pure commonMain logic on top of the [DeviceIdStore] boundary. Mirrors web-sdk's
// getOrCreateDeviceId(): read the persisted id, or generate a fresh UUID, persist
// it, and return it. The generated id is cached in-memory so repeated calls within
// one process are stable even if a store write transiently fails.
//
// UUID generation uses kotlin.uuid.Uuid (stable since Kotlin 2.0.20) — a pure-
// commonMain RNG, no platform API, so this stays testable with a fake store.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.log.createLogger
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * Resolves the stable per-install device id from [store], generating + persisting
 * one on first use. Holds an in-memory cache so a single process always returns
 * the same id even across store hiccups.
 *
 * @param store Platform-backed persistence (Android prefs / iOS NSUserDefaults).
 * @param generate UUID factory; defaults to a random v4 UUID. Injectable for tests.
 */
class DeviceIdProvider(
    private val store: DeviceIdStore,
    private val generate: () -> String = { defaultUuid() },
) {
    private val log = createLogger("secure", "device-id")

    private var cached: String? = null

    /**
     * Return the stable device id. Resolution order:
     *   1. In-memory cache (set on a prior call this process).
     *   2. The persisted store value.
     *   3. A freshly generated UUID, persisted + cached.
     */
    fun getOrCreate(): String {
        cached?.let { return it }

        val stored = store.load()
        if (!stored.isNullOrEmpty()) {
            cached = stored
            log.debug("loaded", mapOf("source" to "store"))
            return stored
        }

        val fresh = generate()
        store.save(fresh)
        cached = fresh
        log.info("generated", mapOf("persisted" to (store.load() == fresh)))
        return fresh
    }

    companion object {
        @OptIn(ExperimentalUuidApi::class)
        private fun defaultUuid(): String = Uuid.random().toString()
    }
}
