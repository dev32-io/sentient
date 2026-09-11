package io.sentient.mobiledata.di

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AsyncDisconnectLifecycleTest {
    @Test
    fun logout_callback_returns_before_ordered_teardown_and_close_does_not_cancel_it() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val events = mutableListOf<String>()
        val lifecycle = AsyncDisconnectLifecycle(StandardTestDispatcher(testScheduler)) { clearSession ->
            events += "capture-cancel"
            entered.complete(Unit)
            release.await()
            events += "transport-shutdown:$clearSession"
        }

        lifecycle.disconnect(clearSession = true)
        lifecycle.closeAfterDisconnect()

        assertFalse(entered.isCompleted, "the synchronous UI callback must not execute teardown inline")
        runCurrent()
        assertTrue(entered.isCompleted)
        assertEquals(listOf("capture-cancel"), events)

        release.complete(Unit)
        advanceUntilIdle()
        assertEquals(
            listOf("capture-cancel", "transport-shutdown:true"),
            events,
            "close must preserve capture-before-transport ordering",
        )
    }
}
