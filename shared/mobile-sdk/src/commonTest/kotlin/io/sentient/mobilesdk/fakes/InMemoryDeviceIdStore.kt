// ---------------------------------------------------------------------------
// InMemoryDeviceIdStore — DeviceIdStore test double backed by a simple var.
//
// No platform dependency. Lets commonTest drive device-id get-or-create
// scenarios (empty store → generate + persist; pre-seeded store → reuse).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.secure.DeviceIdStore

/**
 * In-memory [DeviceIdStore] double for use in commonTest.
 *
 * Thread safety: not thread-safe — use from a single coroutine/thread in tests.
 */
class InMemoryDeviceIdStore(initial: String? = null) : DeviceIdStore {

    private var stored: String? = initial

    /** Number of save() calls — lets tests assert "persisted exactly once". */
    var saveCount: Int = 0
        private set

    override fun load(): String? = stored

    override fun save(id: String) {
        stored = id
        saveCount++
    }
}
