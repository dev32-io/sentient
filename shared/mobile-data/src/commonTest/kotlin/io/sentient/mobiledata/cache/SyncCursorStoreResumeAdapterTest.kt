// ---------------------------------------------------------------------------
// SyncCursorStoreResumeAdapterTest — pins the dependency-inversion boundary
// (Task 4.7): the adapter round-trips the SDK's transport.CursorSnapshot through
// the durable SyncCursorStore, mapping epoch/lastSeq across the two layers' snapshot
// types. save→load returns the snapshot; clear→load returns null.
//
// KEEPER (per .claude/rules/testing.md): the adapter is the seam where the SDK's
// persistence interface meets mobile-data's storage — a mapping bug here silently
// breaks cross-restart resume. Backed by a real SyncCursorStore over in-memory
// MapSettings (no platform), exactly as the platform owner wires it in production.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache

import com.russhwolf.settings.MapSettings
import io.sentient.mobilesdk.transport.CursorSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SyncCursorStoreResumeAdapterTest {

    private fun adapter() = SyncCursorStoreResumeAdapter(SyncCursorStore(MapSettings()))

    @Test
    fun save_then_load_round_trips_the_sdk_snapshot() {
        val adapter = adapter()
        adapter.save("conv-1", CursorSnapshot(epoch = 4, lastSeq = 77))
        assertEquals(CursorSnapshot(epoch = 4, lastSeq = 77), adapter.load("conv-1"))
    }

    @Test
    fun load_on_empty_returns_null() {
        assertNull(adapter().load("conv-1"))
    }

    @Test
    fun clear_removes_the_persisted_snapshot() {
        val adapter = adapter()
        adapter.save("conv-1", CursorSnapshot(epoch = 1, lastSeq = 5))
        adapter.clear("conv-1")
        assertNull(adapter.load("conv-1"))
    }

    @Test
    fun distinct_conversations_do_not_collide() {
        val adapter = adapter()
        adapter.save("conv-a", CursorSnapshot(epoch = 1, lastSeq = 11))
        adapter.save("conv-b", CursorSnapshot(epoch = 2, lastSeq = 22))
        assertEquals(CursorSnapshot(epoch = 1, lastSeq = 11), adapter.load("conv-a"))
        assertEquals(CursorSnapshot(epoch = 2, lastSeq = 22), adapter.load("conv-b"))
    }
}
