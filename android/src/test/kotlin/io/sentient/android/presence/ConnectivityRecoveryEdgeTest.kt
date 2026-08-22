package io.sentient.android.presence

import io.sentient.android.di.SessionConnectivityRecoveryFence
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConnectivityRecoveryEdgeTest {
    @Test
    fun `only unavailable to available is a recovery edge`() {
        val edge = ConnectivityRecoveryEdge(initiallyAvailable = null)

        assertFalse(edge.update(available = true).changed) // initial snapshot
        assertFalse(edge.update(available = true).changed) // duplicate
        val unavailable = edge.update(available = false)
        assertTrue(unavailable.changed)
        assertFalse(unavailable.recovered)
        assertFalse(edge.update(available = false).changed) // duplicate
        val recovered = edge.update(available = true)
        assertTrue(recovered.changed)
        assertTrue(recovered.recovered)
        assertFalse(edge.update(available = true).changed) // duplicate
    }

    @Test
    fun `disposed session fence rejects queued and predecessor callbacks`() {
        var signals = 0
        val predecessor = SessionConnectivityRecoveryFence { signals++ }
        predecessor.signalIfActive()
        predecessor.close()
        predecessor.signalIfActive()

        val successor = SessionConnectivityRecoveryFence { signals++ }
        predecessor.signalIfActive()
        successor.signalIfActive()

        assertEquals(2, signals)
    }
}
