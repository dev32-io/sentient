package io.sentient.mobiledata.cache

import com.russhwolf.settings.MapSettings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SyncCursorStoreTest {

    private fun store() = SyncCursorStore(MapSettings())

    @Test
    fun get_on_empty_returns_null() {
        assertNull(store().get("conv-1"))
    }

    @Test
    fun set_then_get_round_trips_the_snapshot() {
        val store = store()
        store.set("conv-1", epoch = 7, lastSeq = 42)
        assertEquals(CursorSnapshot(epoch = 7, lastSeq = 42), store.get("conv-1"))
    }

    @Test
    fun set_twice_returns_the_latest() {
        val store = store()
        store.set("conv-1", epoch = 1, lastSeq = 10)
        store.set("conv-1", epoch = 2, lastSeq = 99)
        assertEquals(CursorSnapshot(epoch = 2, lastSeq = 99), store.get("conv-1"))
    }

    @Test
    fun clear_removes_the_cursor() {
        val store = store()
        store.set("conv-1", epoch = 3, lastSeq = 5)
        store.clear("conv-1")
        assertNull(store.get("conv-1"))
    }

    @Test
    fun half_written_cursor_epoch_only_returns_null() {
        // Pin the "both keys written/cleared together" invariant: if only the epoch key
        // is present (e.g. a crash between the two putLong calls), get() must return
        // null rather than yield a garbage CursorSnapshot with a default lastSeq.
        val settings = MapSettings()
        settings.putLong("cursor.conv-1.epoch", 5L)
        // seq key deliberately NOT written
        assertNull(SyncCursorStore(settings).get("conv-1"))
    }

    @Test
    fun distinct_conversations_do_not_collide() {
        val store = store()
        store.set("conv-a", epoch = 1, lastSeq = 11)
        store.set("conv-b", epoch = 2, lastSeq = 22)

        assertEquals(CursorSnapshot(epoch = 1, lastSeq = 11), store.get("conv-a"))
        assertEquals(CursorSnapshot(epoch = 2, lastSeq = 22), store.get("conv-b"))

        store.clear("conv-a")
        assertNull(store.get("conv-a"))
        assertEquals(CursorSnapshot(epoch = 2, lastSeq = 22), store.get("conv-b"))
    }
}
