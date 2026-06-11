// ---------------------------------------------------------------------------
// DeviceIdProviderTest — get-or-create stability over a fake store.
//
// Pins the contract the gateway resume buffer depends on (Task 3.10): the
// deviceId is generated ONCE and stable across calls + "reconnects" (new
// provider over the same persisted store). Keeper per .claude/rules/testing.md
// (protocol-adjacent invariant: a churning deviceId breaks per-device replay).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

import io.sentient.mobilesdk.fakes.InMemoryDeviceIdStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeviceIdProviderTest {

    @Test
    fun generates_and_persists_when_store_is_empty() {
        val store = InMemoryDeviceIdStore()
        val provider = DeviceIdProvider(store, generate = { "fresh-id" })

        val id = provider.getOrCreate()

        assertEquals("fresh-id", id)
        assertEquals("fresh-id", store.load())
        assertEquals(1, store.saveCount)
    }

    @Test
    fun reuses_the_persisted_id_without_generating() {
        val store = InMemoryDeviceIdStore(initial = "existing-id")
        var generated = false
        val provider = DeviceIdProvider(store, generate = { generated = true; "should-not-be-used" })

        val id = provider.getOrCreate()

        assertEquals("existing-id", id)
        assertTrue(!generated, "must not generate when a stored id exists")
        assertEquals(0, store.saveCount)
    }

    @Test
    fun is_stable_across_repeated_calls() {
        val store = InMemoryDeviceIdStore()
        var n = 0
        val provider = DeviceIdProvider(store, generate = { "id-${n++}" })

        val first = provider.getOrCreate()
        val second = provider.getOrCreate()
        val third = provider.getOrCreate()

        assertEquals(first, second)
        assertEquals(second, third)
        assertEquals(1, store.saveCount) // generated + persisted exactly once
    }

    @Test
    fun a_new_provider_over_the_same_store_reuses_the_id() {
        // Simulates a process restart / reconnect: the persisted id must survive.
        val store = InMemoryDeviceIdStore()
        val first = DeviceIdProvider(store, generate = { "persisted-id" }).getOrCreate()

        val secondProvider = DeviceIdProvider(store, generate = { "different-id" })
        val second = secondProvider.getOrCreate()

        assertEquals(first, second)
        assertEquals("persisted-id", second)
    }

    @Test
    fun default_generate_produces_a_nonempty_uuid_shaped_id() {
        val store = InMemoryDeviceIdStore()
        val id = DeviceIdProvider(store).getOrCreate()
        assertTrue(id.isNotEmpty(), "device id must be non-empty (gateway requires min(1))")
    }
}
