package io.sentient.mobilesdk.util

import kotlin.test.Test
import kotlin.test.assertEquals

// ---------------------------------------------------------------------------
// EventEmitter — snapshot-safety invariant test
//
// Pins: emit() iterates a snapshot of handlers, so a handler that unsubscribes
// itself or another handler mid-emit does not cause ConcurrentModificationException
// and all handlers registered at emit-time are still invoked.
// ---------------------------------------------------------------------------

class EventEmitterTest {

    /**
     * Given two handlers A and B, where A's body removes B via its unsubscribe fn,
     * both A and B must be called (because emit snapshots the handler list before
     * iterating). Without .toList() this throws ConcurrentModificationException on
     * Kotlin's LinkedHashSet iterator.
     */
    @Test
    fun emit_calls_all_snapshot_handlers_even_when_one_unsubscribes_another_mid_emit() {
        val emitter = EventEmitter<Int>()
        val called = mutableListOf<String>()

        var removeB: (() -> Unit)? = null

        emitter.on { value ->
            called += "A:$value"
            removeB?.invoke() // unsubscribe B while iterating
        }
        removeB = emitter.on { value ->
            called += "B:$value"
        }

        emitter.emit(1)

        // Both A and B must have been called — snapshot guarantees it.
        assertEquals(listOf("A:1", "B:1"), called)

        // B is now unsubscribed; a second emit must only call A.
        emitter.emit(2)
        assertEquals(listOf("A:1", "B:1", "A:2"), called)
    }
}
